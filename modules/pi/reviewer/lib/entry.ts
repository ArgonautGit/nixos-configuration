import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DecisionData {
	toolName: string;
	inputSummary: string;
	decision: "allow" | "deny";
	confidence: string;
	reason: string;
	reviewerModel?: string;
	source: string;
	mode: string;
	userDecision?: "allow" | "deny";
	timestamp: number;
}

export function registerRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer("reviewer-decision", (entry, _renderCtx, theme) => {
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
		const head = `${mark} reviewer ${d.decision.toUpperCase()} [${d.confidence}] ${d.toolName} (${who}, mode: ${d.mode})`;
		const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg(color as never, head)));
		box.addChild(new Text(theme.fg("dim", d.reason)));
		if (d.reviewerModel) box.addChild(new Text(theme.fg("dim", `model: ${d.reviewerModel}`)));
		if (d.inputSummary) box.addChild(new Text(theme.fg("dim", d.inputSummary)));
		return box;
	});
}
