/**
 * Reviewer — LLM permission gate for tool calls.
 *
 * Modes (default: deny):
 *   deny — every reviewed tool call needs an explicit reviewer ALLOW (fail-closed)
 *   ask  — reviewer advises; the user must explicitly allow each call
 *   allow — unconstrained; reviewer bypassed
 *
 * Commands:
 *   /perm [deny|ask|allow|status]
 *   /reviewer-model
 *
 * Config: config.json + rules.md next to this extension (Nix-managed in production;
 * PI_REVIEWER_CONFIG_DIR env var overrides for dev/testing).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createState, MODE_LABELS, type Mode, type ReviewerState, type Verdict } from "./lib/state.ts";
import { loadConfig, loadRules, type ReviewerConfig } from "./lib/config.ts";
import { matchesRule, renderInput } from "./lib/context.ts";
import { pickReviewerModel, cacheKey } from "./lib/picker.ts";
import { runReviewer } from "./lib/reviewer.ts";
import { registerRenderer, type DecisionData } from "./lib/entry.ts";

export default function (pi: ExtensionAPI) {
	const state = createState();
	let config: ReviewerConfig;
	let rules = "";
	let rulesPath = "";

	registerRenderer(pi);

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
		rulesPath = r.path;

		const freshSession = event.reason === "startup" || event.reason === "new" || event.reason === "reload";
		if (freshSession) {
			state.mode = config.defaultMode;
			state.reviewerModel = undefined;
			state.modelSelectedThisSession = false;
			state.cache.clear();
		}

		// Optional session-persisted state (mode + model) on resume
		if (config.sessionPersistence && (event.reason === "resume" || event.reason === "fork")) {
			try {
				const entries = ctx.sessionManager.getEntries() as Array<{
					type?: string;
					customType?: string;
					data?: { mode?: Mode; model?: string };
				}>;
				for (let i = entries.length - 1; i >= 0; i--) {
					const e = entries[i];
					if (e?.type === "custom" && e.customType === "reviewer-state" && e.data) {
						if (e.data.mode && ["deny", "ask", "allow"].includes(e.data.mode)) state.mode = e.data.mode;
						if (e.data.model) {
							const slash = e.data.model.indexOf("/");
							const m = ctx.modelRegistry.find(e.data.model.slice(0, slash), e.data.model.slice(slash + 1));
							if (m && ctx.modelRegistry.hasConfiguredAuth(m)) {
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
			const slash = config.reviewerModel.indexOf("/");
			const m = ctx.modelRegistry.find(config.reviewerModel.slice(0, slash), config.reviewerModel.slice(slash + 1));
			if (m && ctx.modelRegistry.hasConfiguredAuth(m)) {
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

	pi.on("tool_call", async (event, ctx) => {
		if (state.mode === "allow") return undefined;

		const toolName = event.toolName;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (config.reviewedTools.length > 0 && !config.reviewedTools.includes(toolName)) return undefined;
		const rendered = renderInput(input);

		// Hard static deny — applies even in ask mode, no prompt, no reviewer
		for (const rule of config.alwaysDeny) {
			if (matchesRule(rule, toolName, rendered)) {
				const terminate = config.denyTerminate.some((r) => matchesRule(r, toolName, rendered));
				logDecision(ctx, {
					toolName,
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
			if (matchesRule(rule, toolName, rendered)) return undefined;
		}

		// Reviewer model must exist before any review can happen
		if (!state.reviewerModel) {
			if (!ctx.hasUI) {
				return {
					block: true,
					reason: "Reviewer not enabled: no reviewer model is configured. The user must run /reviewer-model or set reviewerModel in config.json.",
				};
			}
			state.selectingModel ??= pickReviewerModel(ctx, true).then((m) => {
				if (m) {
					state.reviewerModel = m;
					state.modelSelectedThisSession = true;
					updateWidget(ctx);
				}
				state.selectingModel = undefined;
				return m;
			});
			const picked = await state.selectingModel;
			if (!picked) {
				return {
					block: true,
					reason: "Reviewer not enabled: no reviewer model was selected. Ask the user to run /reviewer-model.",
				};
			}
		}

		// Reviewer verdict (with per-turn cache)
		const key = cacheKey(toolName, input);
		let verdict = state.cache.get(key);
		if (!verdict) {
			verdict = await runReviewer(ctx, state, config, rules, state.reviewerModel!, toolName, input);
			state.cache.set(key, verdict);
		}

		logDecision(ctx, {
			toolName,
			inputSummary: rendered,
			decision: verdict.decision,
			confidence: verdict.confidence,
			reason: verdict.reason,
			reviewerModel: verdict.reviewerModel,
			source: verdict.source,
			mode: state.mode,
		});

		if (verdict.decision === "deny") {
			notifyVerdict(ctx, verdict, toolName);
			return {
				block: true,
				reason: `REVIEWER DENIED this tool call: ${verdict.reason}`,
				terminate:
					verdict.source === "static-deny" &&
					config.denyTerminate.some((r) => matchesRule(r, toolName, rendered)),
			};
		}

		// Reviewer allows. In ask mode the user still has the final say — wait for explicit allow.
		if (state.mode === "ask") {
			if (!ctx.hasUI) {
				return { block: true, reason: `ask mode without a UI — blocked (fail-closed). Reviewer said: ${verdict.reason}` };
			}
			const choice = await ctx.ui.select(
				`Reviewer recommends ALLOW (${verdict.confidence}): ${verdict.reason}\n\nAllow ${toolName}?`,
				["Allow", "Deny"],
			);
			const userDecision = choice === "Allow" ? "allow" : "deny";
			logDecision(ctx, {
				toolName,
				inputSummary: rendered,
				decision: userDecision,
				confidence: verdict.confidence,
				reason: verdict.reason,
				reviewerModel: verdict.reviewerModel,
				source: "user",
				mode: state.mode,
				userDecision,
			});
			if (userDecision === "deny") {
				return {
					block: true,
					reason: `User denied this tool call. Reviewer had recommended allow: ${verdict.reason}`,
				};
			}
			return undefined;
		}

		notifyVerdict(ctx, verdict, toolName);
		return undefined;
	});

	// Persist mode+model choice for later restore (opt-in)
	pi.on("session_shutdown", async (_event, ctx) => {
		if (config?.sessionPersistence) {
			try {
				pi.appendEntry("reviewer-state", { mode: state.mode, model: reviewerModelLabel() });
			} catch {
				/* best-effort */
			}
		}
	});

	pi.registerCommand("perm", {
		description: "Reviewer permission mode: /perm [deny|ask|allow|status]",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "status") {
				ctx.ui.notify(`Reviewer mode: ${state.mode} — ${MODE_LABELS[state.mode]} · model: ${reviewerModelLabel()}`, "info");
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
			ctx.ui.notify("Usage: /perm [deny|ask|allow|status]", "warning");
		},
	});

	pi.registerCommand("reviewer-model", {
		description: "Select the model that reviews tool calls (like /model)",
		handler: async (_args, ctx) => {
			const m = await pickReviewerModel(ctx, !state.modelSelectedThisSession);
			if (m) {
				state.reviewerModel = m;
				state.modelSelectedThisSession = true;
				updateWidget(ctx);
				ctx.ui.notify(`Reviewer model set to ${m.provider}/${m.id}`, "info");
			}
		},
	});
}
