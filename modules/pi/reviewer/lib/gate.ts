import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { ReviewerConfig } from "./config.ts";
import type { ReviewerState } from "./state.ts";
import { buildReviewContext } from "./context.ts";
import { buildPreview, callTarget } from "./preview.ts";
import { ApprovalView, type ApprovalChoice } from "./approval.ts";

/** Why an approval did or did not happen; never a reusable permission. */
export type ApprovalOutcome = "allow" | "deny" | "cancel" | "changed" | "edited" | "error";

export const APPROVAL_REASONS: Record<ApprovalOutcome, string> = {
	allow: "User explicitly approved the inspected exact tool call.",
	deny: "The user denied this tool call.",
	cancel: "The user dismissed the approval dialog; the call was not run.",
	changed: "The call or conversation changed during approval, so the approval was discarded. Re-issue the call if it is still needed.",
	edited: "The inspection preview was edited, so approval was refused (editing cannot change the call).",
	error: "The approval dialog failed; the call was blocked (details suppressed).",
};

export function invalidateApprovals(state: ReviewerState): void {
	state.generation++;
	state.approvalAbort.abort();
	state.approvalAbort = new AbortController();
}

/** Fold ONLY explicit command events on this branch. Never inspect prose. */
export function pendingDenyNext(ctx: ExtensionContext): string | undefined {
	let pending: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== "reviewer-control") continue;
		const data = entry.data as { action?: unknown; instructionId?: unknown } | undefined;
		if (!data || typeof data.instructionId !== "string" || !data.instructionId || !["arm-deny-next", "consume-deny-next"].includes(String(data.action))) {
			throw new Error("Invalid reviewer control record");
		}
		if (data.action === "arm-deny-next") pending = data.instructionId;
		else if (pending === data.instructionId) pending = undefined;
	}
	return pending;
}

export interface CallBinding {
	fingerprint: string;
	preview: string;
	current: () => boolean;
	signal: AbortSignal;
}

/** A request-local binding, never a reusable approval token or permission cache. */
export function bindCall(ctx: ExtensionContext, state: ReviewerState, config: ReviewerConfig, event: ToolCallEvent): CallBinding {
	const context = buildReviewContext(ctx, config);
	const generation = state.generation;
	const sessionId = ctx.sessionManager.getSessionId();
	const leaf = ctx.sessionManager.getLeafId();
	const cwd = ctx.cwd;
	const toolName = event.toolName;
	const toolCallId = event.toolCallId;
	const serialized = JSON.stringify(event.input ?? {});
	const signal = ctx.signal ? AbortSignal.any([ctx.signal, state.approvalAbort.signal]) : state.approvalAbort.signal;
	const fingerprint = createHash("sha256").update(JSON.stringify({ nonce: randomUUID(), sessionId, cwd, toolName, toolCallId, serialized })).digest("hex");
	return {
		fingerprint,
		signal,
		preview: JSON.stringify({ cwd, toolName, toolCallId, input: JSON.parse(serialized) }, null, 2),
		current: () => {
			try {
				if (!context.complete || signal.aborted || state.controlFault || state.generation !== generation || ctx.cwd !== cwd
					|| ctx.sessionManager.getSessionId() !== sessionId || event.toolName !== toolName
					|| event.toolCallId !== toolCallId || JSON.stringify(event.input ?? {}) !== serialized) return false;
				if (leaf && !ctx.sessionManager.getBranch().some(e => e.id === leaf)) return false;
				const now = buildReviewContext(ctx, config);
				return now.complete && now.authorization === context.authorization;
			} catch { return false; }
		},
	};
}

/** Map a dialog result to an outcome; any change to the bound call wins. */
function settle(binding: CallBinding, choice: ApprovalChoice | "edited"): ApprovalOutcome {
	if (!binding.current()) return "changed";
	return choice;
}

/** Serialize dialogs. No UI, Esc, errors, stale input/context, or abort => not allowed. */
export async function confirmExactCall(ctx: ExtensionContext, state: ReviewerState, binding: CallBinding, reason: string): Promise<ApprovalOutcome> {
	if (!ctx.hasUI) return "error";
	const previous = state.confirmationQueue;
	let release!: () => void;
	state.confirmationQueue = new Promise<void>(resolve => { release = resolve; });
	try {
		await previous;
		if (!binding.current()) return "changed";
		// Display is derived from the bound immutable snapshot, never the live input.
		const snapshot = JSON.parse(binding.preview) as { cwd: string; toolName: string; input: Record<string, unknown> };
		const id = binding.fingerprint.slice(0, 12);
		if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
			const preview = buildPreview(snapshot.toolName, snapshot.input, snapshot.cwd);
			const choice = await ctx.ui.custom<ApprovalChoice>((tui, theme, _keybindings, done) => {
				let closed = false;
				const close = (c: ApprovalChoice) => {
					if (closed) return;
					closed = true;
					binding.signal.removeEventListener("abort", onAbort);
					done(c);
				};
				const onAbort = () => close("cancel");
				binding.signal.addEventListener("abort", onAbort, { once: true });
				if (binding.signal.aborted) queueMicrotask(onAbort);
				return new ApprovalView({
					title: `${snapshot.toolName} ${callTarget(snapshot.toolName, snapshot.input)}`,
					details: [reason, `cwd: ${snapshot.cwd} · approval ID: ${id}`],
					preview, raw: binding.preview, theme: theme as never,
					rows: () => tui.terminal?.rows ?? 24,
					requestRender: () => tui.requestRender(),
					done: close,
				});
			});
			return settle(binding, choice ?? "cancel");
		}
		// Fallback (RPC or no custom UI): the editor receives the COMPLETE immutable
		// snapshot. Editing it cannot change the tool call and refuses approval:
		// otherwise a user might approve a safer edited version of an unsafe call.
		const inspected = await ctx.ui.editor("Inspect exact tool call (do not edit; Esc denies)", binding.preview);
		if (inspected === undefined) return settle(binding, "cancel");
		if (inspected !== binding.preview) return settle(binding, "edited");
		if (!binding.current()) return "changed";
		const choice = await ctx.ui.select(
			`${reason}\n\nApprove only the inspected call? ID: ${id}`,
			["Deny", "Allow this call"], { signal: binding.signal },
		);
		return settle(binding, choice === "Allow this call" ? "allow" : choice === "Deny" ? "deny" : "cancel");
	} catch {
		return "error";
	} finally { release(); }
}
