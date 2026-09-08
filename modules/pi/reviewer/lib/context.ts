import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewerConfig } from "./config.ts";

/** Short display/log summary ONLY. Never use this for permission decisions. */
export function renderInput(input: Record<string, unknown>): string {
	return clip(JSON.stringify(input), 2000);
}

export const MAX_REVIEW_INPUT_CHARS = 60_000;

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
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n");
}

function extractMessage(message: unknown): ExtractedMessage[] {
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
				if (c?.type === "toolCall") return [`[assistant proposes tool: ${c.name}]`];
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

function extractMessages(entries: unknown[]): ExtractedMessage[] {
	return entries.flatMap(entry => {
		const e = entry as { type?: string; message?: unknown; summary?: string; retainedTail?: unknown[];
			customType?: string; content?: unknown; data?: Record<string, unknown> };
		if (e.type === "message") return extractMessage(e.message);
		if (e.type === "compaction" || e.type === "branch_summary") {
			return [
				{ role: "summary" as const, text: e.summary ?? "" },
				...(e.type === "compaction" ? (e.retainedTail ?? []).flatMap(extractMessage) : []),
			];
		}
		if (e.type === "custom_message") return [{ role: "custom" as const, text: contentToText(e.content) }];
		if (e.type === "custom" && e.customType === "reviewer-decision" && e.data) {
			// Includes earlier preflight decisions in a parallel batch. A proposed
			// tool alone is not evidence that "deny the next call" was consumed.
			const { toolName, decision, source, reason, toolCallId } = e.data;
			return [{ role: "reviewerDecision" as const, text: JSON.stringify({ toolName, toolCallId, decision, source, reason }) }];
		}
		return [];
	});
}

function clip(text: string, max: number): string {
	const marker = " …[truncated]";
	if (text.length <= max) return text;
	return max < marker.length ? marker.slice(0, max) : text.slice(0, max - marker.length) + marker;
}

/** Active branch + pi's compaction checkpoint, not all historical branches.
 * JSON lines keep text from spoofing role labels. Budget whole records, reserving
 * recent user clarifications and the latest summary before filling the tail.
 */
export function buildTranscript(ctx: ExtensionContext, config: ReviewerConfig): string {
	let messages: ExtractedMessage[];
	try {
		messages = extractMessages(ctx.sessionManager.buildContextEntries());
	} catch {
		return "(active conversation context unavailable; do not infer authorization)";
	}
	if (!messages.length) return "(no conversation context available)";
	const maxChars = Math.max(128, Math.floor(config.contextBudget.maxChars));
	const maxMessages = Math.max(1, Math.floor(config.contextBudget.maxMessages));
	const indices = messages.map((_, i) => i).reverse();
	const users = indices.filter(i => messages[i].role === "user").slice(0, 3);
	const summary = indices.find(i => messages[i].role === "summary");
	const priority = [...new Set([...users, ...(summary === undefined ? [] : [summary]), ...indices])];
	const selected = new Map<number, string>();
	const omission = "[Some context omitted or clipped; not evidence of permission.]\n";
	let remaining = maxChars - omission.length;
	for (const i of priority) {
		if (selected.size >= maxMessages || remaining < 80) break;
		const m = messages[i];
		const limit = m.role === "user" ? Math.min(6000, Math.floor(maxChars / 4))
			: m.role === "summary" ? Math.min(12000, Math.floor(maxChars / 3))
			: m.role === "assistant" ? 3000 : 1000;
		const encode = (length: number) => JSON.stringify({ role: m.role,
			...(i === users[0] ? { latestUser: true } : {}), text: clip(m.text, length) });
		let low = 0, high = Math.min(m.text.length, limit);
		// Account for JSON escaping, not just raw text length.
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (encode(mid).length + 1 <= remaining) low = mid;
			else high = mid - 1;
		}
		const line = encode(low);
		if (line.length + 1 > remaining) continue;
		selected.set(i, line);
		remaining -= line.length + 1;
	}
	return omission + [...selected].sort(([a], [b]) => a - b).map(([, line]) => line).join("\n");
}
