import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReviewerState } from "./state.ts";

export interface DecisionData {
	toolName: string;
	toolCallId?: string;
	reviewId?: string;
	inputSummary: string;
	decision: "allow" | "deny";
	confidence: string;
	reason: string;
	reviewerModel?: string;
	raw?: string;
	source: string;
	mode: string;
	userDecision?: "allow" | "deny";
	timestamp: number;
}

export function registerExplanationCommand(pi: ExtensionAPI, state: ReviewerState): void {
	pi.registerEntryRenderer("reviewer-explanation", (entry) => {
		return new Text((entry.data as { text: string }).text, 1, 1);
	});
	pi.registerCommand("reviewer-explain", {
		description: "Inspect recorded verdict: /reviewer-explain [last|deny|entry-id] [context] (no model call)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const showContext = parts.includes("context");
			const selectors = parts.filter(p => p !== "context");
			if (selectors.length > 1) {
				ctx.ui.notify("Usage: /reviewer-explain [last|deny|entry-id] [context]", "warning");
				return;
			}
			const selector = selectors[0] ?? "last";
			const entries = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "reviewer-decision");
			const entry = entries.reverse().find(e => {
				const d = e.data as DecisionData;
				return selector === "last" || (selector === "deny" ? d.decision === "deny" : e.id === selector);
			});
			if (!entry) {
				ctx.ui.notify("No matching reviewer decision on the active branch.", "info");
				return;
			}
			const d = entry.data as DecisionData;
			const text = [
				`Recorded reviewer decision ${entry.id}: ${d.decision.toUpperCase()} (${d.confidence})`,
				`Tool: ${d.toolName} · source: ${d.source} · mode: ${d.mode}`,
				`Model: ${d.reviewerModel ?? "none"} · time: ${new Date(d.timestamp).toISOString()}`,
				`Input summary: ${d.inputSummary}`,
				`Recorded reason: ${d.reason}`,
				...(d.raw ? [`Raw reply (clipped): ${d.raw}`] : []),
				"This is the recorded rationale, not a new review or access to hidden reasoning. No tool or model call was made. It may be mistaken; later clarification was not part of that decision.",
			].join("\n\n");
			// TUI-only entry: do not inject diagnostics back into the agent's context.
			pi.appendEntry("reviewer-explanation", { text });
			if (ctx.mode === "rpc") ctx.ui.notify(text, "info");
			if (!showContext) return;
			const request = d.reviewId ? state.reviewRequests.get(d.reviewId) : undefined;
			if (!request || !ctx.hasUI) {
				ctx.ui.notify("Exact request unavailable: only the last ten reviews since load are kept in memory; viewing requires a UI. Historical context is not reconstructed or invented.", "info");
				return;
			}
			// Do not persist another copy of potentially sensitive conversation text.
			await ctx.ui.editor("Reviewer request snapshot (inspection only; edits discarded)",
				`SYSTEM\n${request.system}\n\nUSER\n${request.user}`);
		},
	});
}

export function registerRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer("reviewer-decision", (entry, { expanded }, theme) => {
		const d = entry.data as DecisionData;
		const mark = d.decision === "allow" ? "✔" : "✘";
		const color = d.decision === "allow" ? "success" : "error";
		const who =
			d.source === "user"
				? d.userDecision === "allow"
					? "user approved"
					: "user denied"
				: d.source === "fail-closed"
					? "fail-closed"
					: d.source;
		const head = mark + " reviewer " + d.decision.toUpperCase() + " [" + d.confidence + "] " + d.toolName + " (" + who + ", mode: " + d.mode + ")";
		const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg(color as never, head)));
		box.addChild(new Text(theme.fg("dim", d.reason)));
		if (expanded) {
			box.addChild(new Text(theme.fg("dim", `entry: ${entry.id} · model: ${d.reviewerModel ?? "none"}`)));
			box.addChild(new Text(theme.fg("dim", "input: " + d.inputSummary)));
			if (d.raw) box.addChild(new Text(theme.fg("dim", "raw: " + d.raw)));
		}
		return box;
	});
}
