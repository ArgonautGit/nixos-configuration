import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewerConfig } from "./config.ts";

/** Render tool input as a short one-line summary for matching/presentation. */
export function renderInput(input: Record<string, unknown>): string {
	try {
		const s = JSON.stringify(input);
		return s.length > 2000 ? s.slice(0, 2000) + " …[truncated]" : s;
	} catch {
		return String(input);
	}
}

export function matchesRule(rule: { tool: string; pattern?: string }, toolName: string, rendered: string): boolean {
	if (rule.tool !== toolName) return false;
	if (rule.pattern === undefined) return true;
	try {
		return new RegExp(rule.pattern).test(rendered);
	} catch {
		return false; // invalid pattern in config — never silently matches
	}
}

interface ExtractedMessage {
	role: "user" | "assistant" | "toolResult" | "bashExecution" | "custom";
	text: string;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: { type?: string }) => c?.type === "text" && typeof (c as { text?: string }).text === "string")
			.map((c: { text?: string }) => c.text as string)
			.join("\n");
	}
	return "";
}

function extractMessages(entries: unknown[]): ExtractedMessage[] {
	const out: ExtractedMessage[] = [];
	for (const entry of entries) {
		const e = entry as { type?: string; message?: unknown };
		const msg = e?.message as
			| { role?: string; content?: unknown; toolName?: string; command?: string; customType?: string }
			| undefined;
		if (!msg?.role) continue;
		if (msg.role === "user") {
			const text = contentToText(msg.content).trim();
			if (text) out.push({ role: "user", text });
		} else if (msg.role === "assistant") {
			const raw = msg.content as unknown[] | undefined;
			if (!Array.isArray(raw)) continue;
			const parts: string[] = [];
			for (const c of raw) {
				const cc = c as { type?: string; text?: string; name?: string };
				if (cc.type === "text" && cc.text) parts.push(cc.text);
				else if (cc.type === "toolCall" && cc.name)
					parts.push(`[assistant invokes tool: ${cc.name}]`);
			}
			if (parts.length) out.push({ role: "assistant", text: parts.join("\n") });
		} else if (msg.role === "toolResult") {
			const text = contentToText(msg.content);
			if (text.trim()) out.push({ role: "toolResult", text: `(result of ${msg.toolName}) ${text}` });
		} else if (msg.role === "bashExecution") {
			out.push({
				role: "bashExecution",
				text: `(user ran shell command) ${msg.command}: ${contentToText(e) || ""}`,
			});
		}
	}
	return out;
}

const TOOL_RESULT_CLIP = 600;
const ASSISTANT_CLIP = 3000;
const USER_CLIP = 6000;

function clip(text: string, max: number): string {
	return text.length <= max ? text : text.slice(0, max) + " …[truncated]";
}

/**
 * Build a transcript for the reviewer: the original user prompt(s) (intent)
 * plus the recent conversation tail, within the configured budget.
 */
export function buildTranscript(ctx: ExtensionContext, config: ReviewerConfig): string {
	let entries: unknown[] = [];
	try {
		entries = ctx.sessionManager.getEntries() as unknown[];
	} catch {
		return "(no conversation context available)";
	}
	const msgs = extractMessages(entries);
	if (msgs.length === 0) return "(conversation just started — no prior context)";

	// Always keep the first user message (the primary statement of intent).
	const firstUser = msgs.find((m) => m.role === "user");
	const head: ExtractedMessage[] = firstUser ? [firstUser] : [];
	const tailBudget = config.contextBudget.maxMessages - head.length;
	const tail = msgs.slice(-Math.max(tailBudget, 1));

	const lines: string[] = [];
	if (firstUser && !tail.includes(firstUser)) {
		lines.push("[earliest user message — primary intent]");
		lines.push(clip(firstUser.text, USER_CLIP));
	}
	for (const m of tail) {
		if (m === firstUser && lines.length > 0 && lines[1] === clip(firstUser.text, USER_CLIP)) continue;
		const label =
			m.role === "user" ? "USER" : m.role === "assistant" ? "ASSISTANT" : m.role === "toolResult" ? "TOOL RESULT" : "SHELL";
		lines.push(`${label}:`);
		lines.push(clip(m.text, m.role === "user" ? USER_CLIP : m.role === "assistant" ? ASSISTANT_CLIP : TOOL_RESULT_CLIP));
	}

	let transcript = lines.join("\n");
	const maxChars = config.contextBudget.maxChars;
	if (transcript.length > maxChars) transcript = "…[older context omitted]\n" + transcript.slice(-maxChars);
	return transcript;
}
