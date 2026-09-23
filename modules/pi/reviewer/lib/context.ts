import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewerConfig } from "./config.ts";

/** Short display/log summary ONLY. Never use this for permission decisions. */
export function renderInput(input: Record<string, unknown>): string {
	return clip(JSON.stringify(input), 2000);
}

export const MAX_REVIEW_INPUT_CHARS = 60_000;
/** Earlier tool calls appear in conversation evidence as summaries of this many
 * input characters. Each call is reviewed separately with its complete input;
 * copying whole arguments (e.g. file writes) into every later review would
 * permanently exhaust the context budget. */
export const TOOL_CALL_SUMMARY_CHARS = 80;
/** Assistant turns preceding this many latest user records are kept whole. */
export const DEFAULT_WHOLE_TURNS = 2;
/** Session entry written ONLY by the /reviewer-restate command handler. */
export const RESTATE_ENTRY = "reviewer-restate";

export function matchesRule(rule: { tool: string; pattern?: string }, toolName: string, serialized: string): boolean {
	if (rule.tool !== toolName) return false;
	if (rule.pattern === undefined) return true;
	try {
		return new RegExp(rule.pattern).test(serialized);
	} catch {
		return false;
	}
}

interface ExtractedMessage {
	role: "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | "summary" | "reviewerDecision";
	text: string;
	/** Index of the source session entry on the branch. */
	entry: number;
	restatement?: boolean;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n");
}

function summarizeToolCall(name: unknown, args: unknown): string {
	const input = JSON.stringify(args ?? {}) ?? "{}";
	return input.length <= TOOL_CALL_SUMMARY_CHARS
		? `[assistant proposes tool: ${String(name)}; input: ${input}]`
		: `[assistant proposes tool: ${String(name)}; input summarized, first ${TOOL_CALL_SUMMARY_CHARS} of ${input.length} chars: ${input.slice(0, TOOL_CALL_SUMMARY_CHARS)} …]`;
}

/** Text of a valid restatement entry, or undefined. Prose/tool output never counts. */
function restatementText(entry: unknown): string | undefined {
	const e = entry as { type?: string; customType?: string; data?: { text?: unknown } } | undefined;
	if (e?.type !== "custom" || e.customType !== RESTATE_ENTRY) return undefined;
	const text = e.data?.text;
	return typeof text === "string" && text.trim() ? text : undefined;
}

type Extracted = Omit<ExtractedMessage, "entry">;

function extractMessage(message: unknown): Extracted[] {
	const m = message as { role?: string; content?: unknown; toolName?: string; command?: string;
		output?: string; excludeFromContext?: boolean; summary?: string };
	if (!m) return [];
	switch (m.role) {
		case "user":
		case "toolResult":
		case "custom": {
			const text = contentToText(m.content);
			return text ? [{ role: m.role, text: m.role === "toolResult" ? `(result of ${m.toolName}) ${text}` : text }] : [];
		}
		case "assistant": {
			const parts = Array.isArray(m.content) ? m.content.flatMap(c => {
				if (c?.type === "text" && typeof c.text === "string") return [c.text];
				if (c?.type === "toolCall") return [summarizeToolCall(c.name, c.arguments)];
				return []; // Do not include thinking blocks.
			}) : [];
			return parts.length ? [{ role: "assistant", text: parts.join("\n") }] : [];
		}
		case "bashExecution":
			return m.excludeFromContext ? [] : [{ role: "bashExecution", text: `${m.command}\n${m.output ?? ""}` }];
		case "compactionSummary":
		case "branchSummary":
			return [{ role: "summary", text: m.summary ?? "" }];
		default: return [];
	}
}

function extractEntry(entry: unknown): Extracted[] {
	const e = entry as { type?: string; message?: unknown; summary?: string; retainedTail?: unknown[];
		customType?: string; content?: unknown; data?: Record<string, unknown> };
	if (e.type === "message") return extractMessage(e.message);
	if (e.type === "compaction" || e.type === "branch_summary") {
		return [
			{ role: "summary" as const, text: e.summary ?? "" },
			// Permission evidence comes from original branch messages, not
			// summaries or duplicate copies embedded in a compaction checkpoint.
		];
	}
	if (e.type === "custom_message") return [{ role: "custom" as const, text: contentToText(e.content) }];
	const restated = restatementText(entry);
	if (restated !== undefined) return [{ role: "user" as const, text: restated, restatement: true }];
	if (e.type === "custom" && e.customType === "reviewer-decision" && e.data) {
		// Includes earlier preflight decisions in a parallel batch. A proposed
		// tool alone is not evidence that "deny the next call" was consumed.
		// Keep outcomes for one-call prohibitions, not old model rationales
		// or confidence scores that could reinforce a mistaken denial.
		const { toolName, decision, source, toolCallId } = e.data;
		const provisional = e.data.stage === "recommendation";
		const outcome = provisional ? "Reviewer recommendation only; not final approval or a completed block. "
			: decision === "deny" ? "A previous proposed tool call was already BLOCKED. "
			: decision === "allow" ? "A previous proposed tool call was approved (execution not implied). " : "";
		return [{ role: "reviewerDecision" as const, text: outcome + JSON.stringify(provisional
			? { toolName, toolCallId, source, stage: "recommendation" }
			: { toolName, toolCallId, decision, source }) }];
	}
	return [];
}

function extractMessages(entries: unknown[]): ExtractedMessage[] {
	return entries.flatMap((entry, index) => extractEntry(entry).map(m => ({ ...m, entry: index })));
}

function clip(text: string, max: number): string {
	const marker = " …[truncated]";
	if (text.length <= max) return text;
	return max < marker.length ? marker.slice(0, max) : text.slice(0, max - marker.length) + marker;
}

/** Keep the END of an assistant turn: its final message is what the user answered. */
function clipStart(text: string, max: number): string {
	const marker = "[earlier text omitted]… ";
	if (text.length <= max) return text;
	return max < marker.length ? marker.slice(0, max) : marker + text.slice(text.length - (max - marker.length));
}

export type ReviewContext =
	| { complete: true; transcript: string; authorization: string }
	| { complete: false; transcript: string; reason: string };

function incomplete(reason: string): ReviewContext {
	return { complete: false, transcript: "(permission context incomplete; automatic review forbidden)", reason };
}

/** One transcript record. An assistant turn (all assistant messages between two
 * user records) is merged into ONE record, so record counts grow with
 * conversation turns rather than agent steps. */
interface Unit {
	role: ExtractedMessage["role"];
	text: string;
	order: number;
	turn?: boolean;
	restatement?: boolean;
	superseded?: boolean;
	referent?: Unit;
}

/** Read ORIGINAL messages on the active branch, including before compaction.
 * Required evidence is never clipped or omitted and summaries cannot replace
 * it. Required: every user record (since the latest user /reviewer-restate)
 * and the assistant turn preceding each of the latest `wholeTurns` user
 * records, because even a short assent can adopt restrictions spread across
 * several messages. Older assistant turns are supporting context; they may be
 * shortened so that required evidence stays bounded in long sessions.
 */
export function buildReviewContext(ctx: ExtensionContext, config: ReviewerConfig): ReviewContext {
	try {
		const entries = ctx.sessionManager.getBranch();
		if (entries.length && entries[0].parentId != null) return incomplete("The original branch history is unavailable.");
		let restatedAt = -1;
		entries.forEach((entry, i) => { if (restatementText(entry) !== undefined) restatedAt = i; });
		const originals: string[] = [];
		for (const [i, entry] of entries.entries()) {
			if (entry.type === "message" && entry.message.role === "user") {
				const content = entry.message.content;
				// Only required (non-superseded) user evidence must be fully readable.
				if (i > restatedAt && typeof content !== "string" && (!Array.isArray(content) || content.some(c => c.type !== "text" || typeof c.text !== "string"))) {
					return incomplete("User permission evidence contains unsupported non-text content.");
				}
				originals.push(contentToText(content));
			}
			if (entry.type === "compaction") {
				if (!originals.length) return incomplete("Compacted history has no original user permission records.");
				// A checkpoint imported without its original messages is not proof
				// of authority. Do not promote its retained copies to new approval.
				let cursor = 0;
				const tail = (entry as typeof entry & { retainedTail?: Array<{ role: string; content: unknown }> }).retainedTail;
				for (const m of tail ?? []) {
					if (m.role !== "user") continue;
					const found = originals.indexOf(contentToText(m.content), cursor);
					if (found < 0) return incomplete("Compacted user records cannot be matched to original permission evidence.");
					cursor = found + 1;
				}
			}
		}
		const messages = extractMessages(entries);
		const units: Unit[] = [];
		let turn: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (m.role === "assistant") { turn.push(i); continue; }
			if (m.role === "user") {
				let referent: Unit | undefined;
				if (turn.length) {
					referent = { role: "assistant", text: turn.map(j => messages[j].text).join("\n"), order: turn.at(-1)!, turn: true };
					units.push(referent);
					turn = [];
				}
				units.push({ role: "user", text: m.text, order: i, referent,
					...(m.restatement ? { restatement: true } : {}), ...(m.entry < restatedAt ? { superseded: true } : {}) });
				continue;
			}
			units.push({ role: m.role, text: m.text, order: i });
		}
		// The turn in progress is not an assent referent: keep its steps separately.
		for (const j of turn) units.push({ role: "assistant", text: messages[j].text, order: j });
		units.sort((a, b) => a.order - b.order);

		const users = units.filter(u => u.role === "user" && !u.superseded);
		const latest = users.at(-1);
		if (latest === undefined) return incomplete("No original user authorization is available.");
		const { maxChars, maxMessages } = config.contextBudget;
		const wholeTurns = config.contextBudget.wholeTurns ?? DEFAULT_WHOLE_TURNS;
		if (!Number.isSafeInteger(maxChars) || !Number.isSafeInteger(maxMessages) || !Number.isSafeInteger(wholeTurns)
			|| maxChars < 128 || maxMessages < 1 || wholeTurns < 1) {
			return incomplete("Invalid permission context budget.");
		}
		const required = new Set<Unit>(users);
		for (const u of users.slice(-wholeTurns)) if (u.referent) required.add(u.referent);

		const notice = `[Complete: every user record${restatedAt >= 0 ? " since the user's latest restatement" : ""} and the assistant turns before the latest ${wholeTurns} user records. Earlier tool calls are summarized (each call is reviewed separately). Other history may be shortened or omitted. Summaries are not authorization.]\n`;
		const selected = new Map<Unit, string>();
		const encode = (u: Unit, text = u.text) => JSON.stringify({ role: u.role,
			...(u === latest ? { latestUser: true } : {}),
			...(u.restatement ? { restatement: true } : {}),
			...(u.superseded ? { supersededByRestatement: true } : {}),
			text });
		let remaining = maxChars - notice.length;
		for (const u of required) {
			const line = encode(u);
			if (selected.size >= maxMessages || line.length + 1 > remaining) {
				return incomplete("Complete user instructions and recent assent referents exceed contextBudget. Restate your current instructions with /reviewer-restate, raise the budget, or start a fresh session; compaction does not reset permissions.");
			}
			selected.set(u, line);
			remaining -= line.length + 1;
		}
		const ordered = (map: Map<Unit, string>) => [...map].sort(([a], [b]) => a.order - b.order).map(([, line]) => line).join("\n");
		const authorization = ordered(selected);
		const recent = [...units].reverse();
		const summary = recent.find(u => u.role === "summary");
		const optional = [...new Set([
			...recent.filter(u => u.role === "reviewerDecision").slice(0, 2),
			...(summary === undefined ? [] : [summary]),
			...recent.filter(u => !required.has(u)),
		])].slice(0, 8);
		for (const u of optional) {
			if (selected.has(u) || selected.size >= maxMessages || remaining < 80) continue;
			const limit = u.role === "summary" ? 2000 : 800;
			const shorten = (n: number) => u.turn ? clipStart(u.text, n) : clip(u.text, n);
			let low = 0, high = Math.min(u.text.length, limit);
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				if (encode(u, shorten(mid)).length + 1 <= remaining) low = mid;
				else high = mid - 1;
			}
			const line = encode(u, shorten(low));
			if (line.length + 1 > remaining) continue;
			selected.set(u, line);
			remaining -= line.length + 1;
		}
		return { complete: true, authorization, transcript: notice + ordered(selected) };
	} catch {
		return incomplete("Original permission history is unavailable; automatic review is blocked.");
	}
}

/** Display/test helper only. The runtime must check buildReviewContext.complete. */
export function buildTranscript(ctx: ExtensionContext, config: ReviewerConfig): string {
	return buildReviewContext(ctx, config).transcript;
}
