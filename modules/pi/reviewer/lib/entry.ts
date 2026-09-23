import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReviewerState, Verdict } from "./state.ts";
import { callTarget, sanitize } from "./preview.ts";
import { hardWrap } from "./approval.ts";

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
	stage?: "recommendation" | "final";
	confirmation?: Verdict["confirmation"];
	classifier?: Verdict["classifier"];
	approvalFingerprint?: string;
	instructionId?: string;
	/** Display-only one-line call description (command, path, query...). */
	target?: string;
	/** Jev confidence threshold, recorded for below-threshold allows. */
	threshold?: number;
	/** Approval dialog outcome for user decisions. */
	outcome?: "allow" | "deny" | "cancel" | "changed" | "edited" | "error";
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
			const entries = ctx.sessionManager.getBranch()
				.filter(e => e.type === "custom")
				.filter(e => e.customType === "reviewer-decision");
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
				...(d.approvalFingerprint ? [`Exact-call approval fingerprint: ${d.approvalFingerprint}`] : []),
				...(d.instructionId ? [`Deny-next instruction: ${d.instructionId}`] : []),
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

interface Theme { fg(color: string, text: string): string; bold(text: string): string }
interface Member { id: string; parentId?: string | null; data: DecisionData; seq: number }
interface Group { head: string; members: Map<string, Member> }

const MAX_LINE = 110;

function fixed(n: number): string {
	return Number.isFinite(n) ? n.toFixed(2) : "?";
}

/** Legacy entries have no `target`; derive it from the clipped JSON summary when possible. */
function targetOf(d: DecisionData): string {
	if (d.target !== undefined) return sanitize(d.target);
	try { return callTarget(d.toolName, JSON.parse(d.inputSummary)); } catch { return sanitize(d.inputSummary ?? "").slice(0, 200); }
}

/** Mark, color and short outcome for one (latest) decision on a call. */
export function describeDecision(d: DecisionData): { mark: string; tone: string; outcome: string } {
	const c = d.classifier;
	const jev = c ? `Jev ${c.choice} ${fixed(c.confidence)}` : undefined;
	const withJev = (text: string) => jev ? `${text} · ${jev}` : text;
	const threshold = d.threshold ?? Number(/threshold ([\d.]+)/.exec(d.reason ?? "")?.[1]);
	if (d.stage === "recommendation") return { mark: "…", tone: "warning", outcome: withJev("awaiting your approval") };
	if (d.source === "user") {
		if (d.instructionId) return { mark: "✘", tone: "error", outcome: "blocked by /perm deny-next" };
		if (d.userDecision === "allow") return { mark: "✔", tone: "success", outcome: withJev("you approved") };
		const why = { deny: "you denied", cancel: "approval dismissed", changed: "changed during approval",
			edited: "preview edited; not approved", error: "approval dialog failed", allow: "you denied" }[d.outcome ?? "deny"];
		return { mark: "✘", tone: "error", outcome: withJev(why) };
	}
	if (d.decision === "allow") return { mark: "✔", tone: "success", outcome: c ? `Jev ${fixed(c.confidence)}` : `allowed · ${d.confidence}` };
	const reason = d.reason ?? "";
	if (d.source === "static-deny") return { mark: "✘", tone: "error", outcome: "blocked by alwaysDeny rule" };
	if (d.source === "incomplete-context") return { mark: "✘", tone: "error",
		outcome: /exceed contextBudget/.test(reason) ? "blocked: context too large · /reviewer-restate" : "blocked: incomplete context" };
	if (d.source === "fail-closed") return { mark: "✘", tone: "error", outcome: /changed/.test(reason) ? "blocked: changed during review"
		: /unavailable|timed out|aborted/.test(reason) ? "blocked: reviewer unavailable" : /without a UI/.test(reason) ? "blocked: approval needs a UI" : "blocked: fail-closed" };
	if (c && d.confirmation === "low-confidence-allow") return { mark: "✘", tone: "error",
		outcome: `blocked: ${jev}${Number.isFinite(threshold) ? ` < ${fixed(threshold)}` : " (below threshold)"}` };
	if (c) return { mark: "✘", tone: "error", outcome: c.choice === "uncertain" ? `blocked: ${jev}` : `denied: ${jev}` };
	return { mark: "✘", tone: "error", outcome: `denied · ${d.confidence}` };
}

/** One compact line (plus details when expanded) for the latest decision on a call. */
export function decisionLines(d: DecisionData, id: string, width: number, expanded: boolean, theme: Theme, toolWidth = 0): string[] {
	const { mark, tone, outcome } = describeDecision(d);
	const lineWidth = Math.max(20, Math.min(width, MAX_LINE));
	const right = theme.fg(tone === "success" ? "dim" : tone, outcome);
	const leftBudget = lineWidth - 1 - visibleWidth(outcome) - 2;
	const left = theme.fg(tone, mark) + " " + theme.fg("muted", d.toolName.padEnd(toolWidth)) + "  " + theme.fg("dim", targetOf(d));
	let line: string;
	if (leftBudget < 12) line = " " + truncateToWidth(theme.fg(tone, mark) + " " + d.toolName + " · " + right, lineWidth - 1);
	else {
		const shown = truncateToWidth(left, leftBudget, "…");
		line = " " + shown + " ".repeat(Math.max(2, lineWidth - 1 - visibleWidth(shown) - visibleWidth(outcome))) + right;
	}
	const lines = [truncateToWidth(line, width)];
	const detail = (label: string, text: string) => hardWrap(`${label}: ${sanitize(text)}`, Math.max(10, width - 4))
		.map(l => "   " + theme.fg("dim", l));
	// Chat reviewers write real prose reasons; Jev reasons are only scores (in the outcome).
	if (!expanded && d.decision === "deny" && !d.classifier && d.source === "reviewer") lines.push(...detail("reason", d.reason).slice(0, 2));
	if (expanded) {
		lines.push(...detail("reason", d.reason ?? ""));
		lines.push(...detail("details", `source ${d.source} · mode ${d.mode} · model ${d.reviewerModel ?? "none"} · entry ${id}`));
		lines.push(...detail("input", d.inputSummary ?? ""));
		if (d.raw) lines.push(...detail("raw", d.raw));
	}
	return lines;
}

/** Renders a run of consecutive decision entries as ONE transcript item. */
class DecisionGroupView implements Component {
	private readonly group: Group;
	private readonly expanded: boolean;
	private readonly theme: Theme;
	constructor(group: Group, expanded: boolean, theme: Theme) {
		this.group = group;
		this.expanded = expanded;
		this.theme = theme;
	}
	invalidate(): void {}
	render(width: number): string[] {
		// Walk the active chain from the head; on branches, prefer the most recently rendered child.
		const chain: Member[] = [];
		let current = this.group.members.get(this.group.head);
		while (current) {
			chain.push(current);
			let next: Member | undefined;
			for (const m of this.group.members.values()) if (m.parentId === current.id && (!next || m.seq > next.seq)) next = m;
			current = next;
		}
		// The latest entry per call wins: a pending recommendation becomes its final outcome.
		const latest = new Map<string, Member>();
		for (const m of chain) latest.set(m.data.toolCallId ?? m.id, m);
		const shown = [...latest.values()];
		const toolWidth = Math.min(16, Math.max(...shown.map(m => m.data.toolName.length)));
		return shown.flatMap(m => decisionLines(m.data, m.id, width, this.expanded, this.theme, toolWidth));
	}
}

export function registerRenderer(pi: ExtensionAPI): void {
	const groups = new Map<string, Group>();
	let seq = 0;
	pi.registerEntryRenderer("reviewer-decision", (entry, { expanded }, theme) => {
		const e = entry as unknown as { id: string; parentId?: string | null; data: DecisionData };
		let group = groups.get(e.id);
		if (!group) {
			// Pi spaces every rendered entry; a decision directly following another
			// joins that entry's group so parallel calls read as one compact list.
			group = (e.parentId ? groups.get(e.parentId) : undefined) ?? { head: e.id, members: new Map() };
			groups.set(e.id, group);
		}
		group.members.set(e.id, { id: e.id, parentId: e.parentId, data: e.data, seq: ++seq });
		if (group.head !== e.id) return undefined;
		return new DecisionGroupView(group, expanded, theme as unknown as Theme);
	});
}
