/**
 * Reviewer — LLM permission gate for tool calls.
 *
 * Modes (default: deny):
 *   deny — every reviewed tool call needs an explicit reviewer ALLOW (fail-closed);
 *          low-confidence Jev allows are blocked without prompting
 *   ask  — reviewer advises; the user must explicitly allow each call
 *   allow — unconstrained; reviewer bypassed
 *
 * Commands:
 *   /perm [deny|ask|allow|status|deny-next]
 *   /reviewer-model
 *   /reviewer-explain [last|deny|entry-id] [context]
 *
 * Config: config.json + rules.md next to this extension (Nix-managed in production;
 * PI_REVIEWER_CONFIG_DIR env var overrides for dev/testing).
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { bindCall, confirmExactCall, invalidateApprovals, pendingDenyNext } from "./lib/gate.ts";
import { createState, MODE_LABELS, type Mode, type ReviewerState, type Verdict } from "./lib/state.ts";
import { loadConfig, loadRules, type ReviewerConfig } from "./lib/config.ts";
import { buildReviewContext, matchesRule, renderInput } from "./lib/context.ts";
import { pickReviewerModel } from "./lib/picker.ts";
import { findReviewerModel, hasReviewerAuth } from "./lib/models.ts";
import { runReviewer, SCHEMA_MARKER } from "./lib/reviewer.ts";
import { registerRenderer, registerExplanationCommand, type DecisionData } from "./lib/entry.ts";


const VERDICT_SCHEMA = {
	type: "object",
	properties: {
		decision: { type: "string", enum: ["allow", "deny"] },
		confidence: { type: "string", enum: ["high", "medium", "low"] },
		reason: { type: "string" },
	},
	required: ["decision", "confidence", "reason"],
	additionalProperties: false,
} as const;
export default function (pi: ExtensionAPI) {
	const state = createState();
	let config: ReviewerConfig;
	let rules = "";

	registerRenderer(pi);
	registerExplanationCommand(pi, state);

	// Structured outputs: when an outgoing payload is the reviewer's (marker in
	// the system-position message only — never the main agent's context), attach
	// response_format json_schema. Providers with constrained sampling enforce
	// it; others ignore it and rely on the tolerant parser.
	pi.on("before_provider_request", (event, _ctx) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object" || payload.response_format !== undefined) return undefined;
		if (!Array.isArray(payload.messages) || typeof payload.system === "string") return undefined;
		const first = payload.messages[0] as { role?: unknown; content?: unknown } | undefined;
		if (!first || first.role !== "system") return undefined;
		const sysText = typeof first.content === "string" ? first.content : JSON.stringify(first.content ?? "");
		if (!sysText.includes(SCHEMA_MARKER)) return undefined;
		payload.response_format = {
			type: "json_schema",
			json_schema: { name: "tool_review_verdict", strict: true, schema: VERDICT_SCHEMA },
		};
		return undefined;
	});

	function reviewerModelLabel(): string {
		return state.reviewerModel ? `${state.reviewerModel.provider}/${state.reviewerModel.id}` : "not selected";
	}

	function updateWidget(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext): void {
		try {
			ctx.ui.setWidget("reviewer", [`reviewer: ${state.mode} · model: ${reviewerModelLabel()}`]);
		} catch {
			/* non-UI modes */
		}
	}

	function setMode(mode: Mode, ctx: import("@earendil-works/pi-coding-agent").ExtensionContext): void {
		invalidateApprovals(state);
		state.mode = mode;
		ctx.ui.notify(`Reviewer mode set to: ${mode} — ${MODE_LABELS[mode]}`, "info");
		updateWidget(ctx);
	}

	function logDecision(
		ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
		data: Omit<DecisionData, "timestamp">,
	): void {
		try {
			pi.appendEntry("reviewer-decision", { ...data, timestamp: Date.now() });
		} catch {
			/* logging must never break the pipeline */
		}
	}

	function notifyVerdict(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext, verdict: Verdict, toolName: string): void {
		const mark = verdict.decision === "allow" ? "✔" : "✘";
		const level = verdict.decision === "allow" ? "info" : "warning";
		ctx.ui.notify(`${mark} reviewer ${verdict.decision.toUpperCase()} (${verdict.confidence}) on ${toolName}: ${verdict.reason}`, level);
	}

	pi.on("session_start", async (event, ctx) => {
		const { config: cfg, dir, warnings } = loadConfig();
		config = cfg;
		for (const w of warnings) ctx.ui.notify(`reviewer config: ${w}`, "warning");
		const r = loadRules(dir);
		rules = r.rules;

		invalidateApprovals(state);
		state.controlFault = false;
		state.mode = config.defaultMode;
		state.reviewerModel = undefined;
		state.modelSelectedThisSession = false;
		state.selectingModel = undefined;
		state.reviewRequests.clear();

		// Optional session-persisted state (mode + model) on resume
		if (config.sessionPersistence && (event.reason === "resume" || event.reason === "fork")) {
			try {
				const entries = ctx.sessionManager.getBranch() as Array<{
					type?: string;
					customType?: string;
					data?: { mode?: Mode; model?: string };
				}>;
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e?.type === "custom" && e.customType === "reviewer-state" && e.data) {
						if (e.data.mode && ["deny", "ask", "allow"].includes(e.data.mode)) state.mode = e.data.mode;
						if (e.data.model) {
							const m = findReviewerModel(ctx, e.data.model);
							if (m && hasReviewerAuth(ctx, m)) {
								state.reviewerModel = m;
								state.modelSelectedThisSession = false;
							}
						}
						break;
					}
				}
			} catch {
				/* restore is best-effort */
			}
		}

		// Pre-configured reviewer model from config.json skips interactive selection
		if (!state.reviewerModel && config.reviewerModel) {
			const m = findReviewerModel(ctx, config.reviewerModel);
			if (m && hasReviewerAuth(ctx, m)) {
				state.reviewerModel = m;
			} else {
				ctx.ui.notify(
					`reviewer: configured model "${config.reviewerModel}" not found or not authenticated — you will be prompted on first review`,
					"warning",
				);
			}
		}

		ctx.ui.setStatus("reviewer", `reviewer: ${state.mode}`);
		updateWidget(ctx);
	});

	// Invalidate pending approvals even for queued user input not persisted yet.
	pi.on("input", () => { invalidateApprovals(state); });
	pi.on("session_before_switch", () => { invalidateApprovals(state); });
	pi.on("session_before_fork", () => { invalidateApprovals(state); });
	pi.on("session_before_tree", () => { invalidateApprovals(state); });

	async function reviewToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		const toolName = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;
		const rendered = renderInput(input);
		const serialized = JSON.stringify(input); // Static rules must also see the full input.
		if (state.controlFault) return { block: true, reason: "Reviewer control persistence failed; reissue /perm deny-next after fixing session storage." };
		const instructionId = pendingDenyNext(ctx);
		if (instructionId) {
			// Synchronous consumption BEFORE any await makes sibling preflights
			// consume exactly one instruction, even with parallel callers.
			pi.appendEntry("reviewer-control", { action: "consume-deny-next", instructionId, toolCallId: event.toolCallId });
			logDecision(ctx, { toolName, toolCallId: event.toolCallId, inputSummary: rendered,
				decision: "deny", confidence: "high", source: "user", mode: state.mode, userDecision: "deny", instructionId,
				reason: "Blocked exactly one preflight by the user's /perm deny-next command." });
			return { block: true, reason: "Blocked by /perm deny-next; that instruction has now been consumed." };
		}
		if (state.mode === "allow") return undefined;
		if (config.reviewedTools.length > 0 && !config.reviewedTools.includes(toolName)) return undefined;

		// Hard static deny — applies even in ask mode, no prompt, no reviewer
		for (const rule of config.alwaysDeny) {
			if (matchesRule(rule, toolName, serialized)) {
				const terminate = config.denyTerminate.some((r) => matchesRule(r, toolName, serialized));
				logDecision(ctx, {
					toolName,
					toolCallId: event.toolCallId,
					inputSummary: rendered,
					decision: "deny",
					confidence: "high",
					reason: `Blocked by static alwaysDeny rule (tool: ${rule.tool}${rule.pattern ? `, pattern: ${rule.pattern}` : ""})`,
					source: "static-deny",
					mode: state.mode,
				});
				ctx.ui.notify(`✘ blocked by static rule: ${toolName}`, "error");
				return { block: true, reason: `Blocked by static rule: ${rule.pattern ?? rule.tool}`, terminate };
			}
		}

		// Static fast-path allow — no reviewer cost
		for (const rule of config.alwaysAllow) {
			if (matchesRule(rule, toolName, serialized)) return undefined;
		}

		const permission = buildReviewContext(ctx, config);
		if (!permission.complete) {
			const reason = `Permission context incomplete: ${permission.reason}`;
			logDecision(ctx, { toolName, toolCallId: event.toolCallId, inputSummary: rendered,
				decision: "deny", confidence: "high", source: "incomplete-context", reason, mode: state.mode });
			return { block: true, reason };
		}
		const binding = bindCall(ctx, state, config, event);

		// Reviewer model must exist before any review can happen
		if (!state.reviewerModel) {
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: "Reviewer not enabled: no reviewer model is configured. The user must run /reviewer-model or set reviewerModel in config.json.",
				};
			}
			if (!state.selectingModel) {
				const generation = state.generation;
				const selecting: NonNullable<ReviewerState["selectingModel"]> = pickReviewerModel(ctx, true).then((m) => {
					if (state.generation !== generation) return undefined;
					if (m) {
						state.reviewerModel = m;
						state.modelSelectedThisSession = true;
						updateWidget(ctx);
					}
					return m;
				}).finally(() => {
					if (state.selectingModel === selecting) state.selectingModel = undefined;
				});
				state.selectingModel = selecting;
			}
			const picked = await state.selectingModel;
			if (!picked) {
				return {
					block: true,
					reason: "Reviewer not enabled: no reviewer model was selected. Ask the user to run /reviewer-model.",
				};
			}
		}

		// Never cache permission verdicts: even identical input can have different
		// authorization or side effects after a user clarification or tool result.
		const description = pi.getAllTools().find(tool => tool.name === toolName)?.description;
		if (!binding.current()) return { block: true, reason: "Call aborted or tool/permission context changed before review; submit a fresh call." };
		const verdict = await runReviewer({ ...ctx, signal: binding.signal }, state, config, rules, state.reviewerModel!, toolName, JSON.parse(serialized), description);
		// Only ask mode reaches the human gate. Deny mode never prompts: a
		// low-confidence Jev allow is a final block there, like any other deny.
		const askUser = state.mode === "ask"
			&& (verdict.decision === "allow" || verdict.confirmation === "low-confidence-allow");

		logDecision(ctx, {
			toolName,
			toolCallId: event.toolCallId,
			reviewId: verdict.reviewId,
			inputSummary: rendered,
			decision: verdict.decision,
			confidence: verdict.confidence,
			reason: verdict.reason,
			reviewerModel: verdict.reviewerModel,
			raw: verdict.raw,
			source: verdict.source,
			mode: state.mode,
			confirmation: verdict.confirmation,
			classifier: verdict.classifier,
			stage: askUser ? "recommendation" : "final",
		});

		if (verdict.decision === "deny" && !askUser) {
			notifyVerdict(ctx, verdict, toolName);
			const hint = verdict.confirmation === "low-confidence-allow"
				? " Deny mode blocks low-confidence allows without prompting; the user can switch to /perm ask to approve such calls manually."
				: "";
			return { block: true, reason: `REVIEWER DENIED this tool call: ${verdict.reason}${hint}` };
		}

		if (!binding.current()) {
			const reason = "Tool call, session, or user instructions changed during review; approval discarded.";
			logDecision(ctx, { toolName, toolCallId: event.toolCallId, inputSummary: rendered,
				decision: "deny", confidence: "high", source: "fail-closed", reason, mode: state.mode });
			return { block: true, reason };
		}
		// Low-confidence Jev ALLOW is not approval. In ask mode it can only proceed
		// with explicit human consent for this exact call; deny mode blocked it
		// above. Deny/uncertain/errors never reach the confirmation path.
		if (askUser) {
			if (!ctx.hasUI) {
				const reason = `Human approval required without a UI — blocked (fail-closed). ${verdict.reason}`;
				logDecision(ctx, { toolName, toolCallId: event.toolCallId, inputSummary: rendered, reviewId: verdict.reviewId,
					decision: "deny", confidence: "high", source: "fail-closed", stage: "final", reason, mode: state.mode });
				return { block: true, reason };
			}
			const approved = await confirmExactCall(ctx, state, binding, verdict.reason);
			const userDecision = approved ? "allow" : "deny";
			const reason = approved ? "User explicitly approved the inspected exact tool call."
				: "User denied/cancelled, UI failed, or the call/context changed; no approval granted.";
			logDecision(ctx, { toolName, toolCallId: event.toolCallId, reviewId: verdict.reviewId,
				inputSummary: rendered, decision: userDecision, confidence: verdict.confidence,
				reason, reviewerModel: verdict.reviewerModel, raw: verdict.raw, classifier: verdict.classifier,
				source: "user", mode: state.mode, userDecision, approvalFingerprint: binding.fingerprint });
			return approved ? undefined : { block: true, reason };
		}

		notifyVerdict(ctx, verdict, toolName);
		return undefined;
	}

	pi.on("tool_call", async (event, ctx) => {
		try {
			return await reviewToolCall(event, ctx);
		} catch {
			// Never surface raw SDK/auth/session exceptions (possibly private).
			return { block: true, reason: "Reviewer gate failed; call blocked (private error details suppressed)." };
		}
	});

	// Persist mode+model choice for later restore (opt-in)
	pi.on("session_shutdown", async (_event, ctx) => {
		invalidateApprovals(state);
		if (config?.sessionPersistence) {
			try {
				pi.appendEntry("reviewer-state", { mode: state.mode, model: reviewerModelLabel() });
			} catch {
				/* best-effort */
			}
		}
	});

	pi.registerCommand("perm", {
		description: "Reviewer permissions: /perm [deny|ask|allow|status|deny-next]",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "deny-next") {
				invalidateApprovals(state);
				try {
					const instructionId = randomUUID();
					pi.appendEntry("reviewer-control", { action: "arm-deny-next", instructionId });
					state.controlFault = false;
					ctx.ui.notify(`Deny-next armed (${instructionId}): blocks one new tool preflight, even in allow mode or on an allowlist.`, "info");
				} catch {
					state.controlFault = true;
					ctx.ui.notify("Could not persist deny-next; tool calls blocked until session storage is fixed and the command is reissued.", "error");
				}
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`Reviewer mode: ${state.mode} — ${MODE_LABELS[state.mode]} · model: ${reviewerModelLabel()} · deny-next: ${pendingDenyNext(ctx) ?? "not armed"}`, "info");
				return;
			}
			if (arg === "" && ctx.hasUI) {
				const choice = await ctx.ui.select("Reviewer permission mode:", ["deny", "ask", "allow"]);
				if (choice) setMode(choice as Mode, ctx);
				return;
			}
			if (arg === "deny" || arg === "ask" || arg === "allow") {
				setMode(arg as Mode, ctx);
				return;
			}
			ctx.ui.notify("Usage: /perm [deny|ask|allow|status|deny-next]", "warning");
		},
	});

	pi.registerCommand("reviewer-model", {
		description: "Select the model that reviews tool calls (like /model)",
		handler: async (_args, ctx) => {
			const generation = state.generation;
			const m = await pickReviewerModel(ctx, !state.modelSelectedThisSession);
			if (state.generation !== generation) {
				ctx.ui.notify("Session or permission context changed; reviewer model selection discarded.", "warning");
				return;
			}
			if (m) {
				invalidateApprovals(state);
				state.reviewerModel = m;
				state.modelSelectedThisSession = true;
				updateWidget(ctx);
				ctx.ui.notify(`Reviewer model set to ${m.provider}/${m.id}`, "info");
			}
		},
	});
}
