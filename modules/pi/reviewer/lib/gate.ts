import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type { ReviewerConfig } from "./config.ts";
import type { ReviewerState } from "./state.ts";
import { buildReviewContext } from "./context.ts";

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

/** Serialize dialogs. No UI, Esc, errors, stale input/context, or abort => deny. */
export async function confirmExactCall(ctx: ExtensionContext, state: ReviewerState, binding: CallBinding, reason: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	const previous = state.confirmationQueue;
	let release!: () => void;
	state.confirmationQueue = new Promise<void>(resolve => { release = resolve; });
	try {
		await previous;
		if (!binding.current()) return false;
		// The editor is scrollable and receives the COMPLETE immutable snapshot.
		// Editing the preview cannot change the tool call and invalidates approval:
		// otherwise a user might approve a safer edited version of an unsafe call.
		const inspected = await ctx.ui.editor("Inspect exact tool call (do not edit; Esc denies)", binding.preview);
		if (inspected !== binding.preview || !binding.current()) return false;
		const choice = await ctx.ui.select(
			`${reason}\n\nApprove only the inspected call? ID: ${binding.fingerprint.slice(0, 12)}`,
			["Deny", "Allow this call"], { signal: binding.signal },
		);
		return choice === "Allow this call" && binding.current();
	} catch {
		return false;
	} finally { release(); }
}
