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
				if (c?.type === "toolCall") return [`[assistant proposes tool: ${c.name}; input: ${JSON.stringify(c.arguments)}]`];
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
				// Permission evidence comes from original branch messages, not
				// summaries or duplicate copies embedded in a compaction checkpoint.
			];
		}
		if (e.type === "custom_message") return [{ role: "custom" as const, text: contentToText(e.content) }];
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
	});
}

function clip(text: string, max: number): string {
	const marker = " …[truncated]";
	if (text.length <= max) return text;
	return max < marker.length ? marker.slice(0, max) : text.slice(0, max - marker.length) + marker;
}

export type ReviewContext =
	| { complete: true; transcript: string; authorization: string }
	| { complete: false; transcript: string; reason: string };

function incomplete(reason: string): ReviewContext {
	return { complete: false, transcript: "(permission context incomplete; automatic review forbidden)", reason };
}

/** Read ORIGINAL messages on the active branch, including before compaction.
 * Required evidence is never clipped or omitted. Summaries cannot replace it.
 * The preceding assistant turn is retained for every user reply because even
 * a short assent can adopt restrictions spread across several messages.
 */
export function buildReviewContext(ctx: ExtensionContext, config: ReviewerConfig): ReviewContext {
	try {
		const entries = ctx.sessionManager.getBranch();
		if (entries.length && entries[0].parentId != null) return incomplete("The original branch history is unavailable.");
		const originals: string[] = [];
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "user") {
				const content = entry.message.content;
				if (typeof content !== "string" && (!Array.isArray(content) || content.some(c => c.type !== "text" || typeof c.text !== "string"))) {
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
		const required = new Set<number>();
		const precedingTurn: number[] = [];
		let latestUser: number | undefined;
		for (let i = 0; i < messages.length; i++) {
			if (messages[i].role === "assistant") precedingTurn.push(i);
			if (messages[i].role !== "user") continue;
			required.add(i);
			for (const proposal of precedingTurn) required.add(proposal);
			precedingTurn.length = 0;
			latestUser = i;
		}
		if (latestUser === undefined) return incomplete("No original user authorization is available.");
		const { maxChars, maxMessages } = config.contextBudget;
		if (!Number.isSafeInteger(maxChars) || !Number.isSafeInteger(maxMessages) || maxChars < 128 || maxMessages < 1) {
			return incomplete("Invalid permission context budget.");
		}
		const notice = "[Original user records and preceding assistant turns are complete; other supporting history may be omitted. Summaries are not authorization.]\n";
		const selected = new Map<number, string>();
		const encode = (i: number, text = messages[i].text) => JSON.stringify({ role: messages[i].role,
			...(i === latestUser ? { latestUser: true } : {}), text });
		let remaining = maxChars - notice.length;
		for (const i of required) {
			const line = encode(i);
			if (selected.size >= maxMessages || line.length + 1 > remaining) {
				return incomplete("Complete user instructions and assent referents exceed contextBudget. Increase the budget or start a fresh session with complete current instructions; compaction does not reset permissions.");
			}
			selected.set(i, line);
			remaining -= line.length + 1;
		}
		const authorization = [...selected].sort(([a], [b]) => a - b).map(([, line]) => line).join("\n");
		const indices = messages.map((_, i) => i).reverse();
		const summary = indices.find(i => messages[i].role === "summary");
		const optional = [...new Set([
			...indices.filter(i => messages[i].role === "reviewerDecision").slice(0, 2),
			...(summary === undefined ? [] : [summary]),
			...indices.filter(i => !required.has(i)),
		])].slice(0, 8);
		for (const i of optional) {
			if (selected.has(i) || selected.size >= maxMessages || remaining < 80) continue;
			const limit = messages[i].role === "summary" ? 2000 : 800;
			let low = 0, high = Math.min(messages[i].text.length, limit);
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				if (encode(i, clip(messages[i].text, mid)).length + 1 <= remaining) low = mid;
				else high = mid - 1;
			}
			const line = encode(i, clip(messages[i].text, low));
			if (line.length + 1 > remaining) continue;
			selected.set(i, line);
			remaining -= line.length + 1;
		}
		return { complete: true, authorization,
			transcript: notice + [...selected].sort(([a], [b]) => a - b).map(([, line]) => line).join("\n") };
	} catch {
		return incomplete("Original permission history is unavailable; automatic review is blocked.");
	}
}

/** Display/test helper only. The runtime must check buildReviewContext.complete. */
export function buildTranscript(ctx: ExtensionContext, config: ReviewerConfig): string {
	return buildReviewContext(ctx, config).transcript;
}
