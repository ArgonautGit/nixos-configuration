import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { ReviewerConfig } from "./config.ts";
import type { ReviewerState, Verdict } from "./state.ts";
import { buildTranscript, renderInput } from "./context.ts";
import { parseVerdict } from "./picker.ts";

/**
 * Marker embedded in the reviewer's system prompt. index.ts watches outgoing
 * provider payloads for this marker (system-position only) and attaches an
 * OpenAI-style response_format json_schema, giving constrained-sampling
 * providers a hard structural guarantee. Providers that ignore it lose nothing:
 * the tolerant parser in picker.ts is the universal floor.
 */
export const SCHEMA_MARKER = "RV-STRUCT-OUT-9f3a";

const OUTPUT_CONTRACT = `Respond with exactly one JSON object and nothing else:
{"decision": "allow" | "deny", "confidence": "high" | "medium" | "low", "reason": "<one or two sentences>"}

Guidelines for the reason:
- Written so both the coding agent and the human user can read it.
- On deny, say what is wrong and what the agent could do instead.
- If you quote text from the tool call inside the reason, escape it as valid
  JSON (backslashes must be doubled).`;

const MARKER_NOTE = `[internal annotation ${SCHEMA_MARKER}: reply with the JSON verdict object only]`;

export function buildReviewerPrompt(
	cfg: ReviewerConfig,
	rules: string,
	cwd: string,
	transcript: string,
	toolName: string,
	input: Record<string, unknown>,
): { system: string; user: string } {
	const system = `You are the permission reviewer for an autonomous coding agent. Another LLM wants to execute a tool call. Your job is to decide whether that call should be allowed, judged against the user's intent in the conversation and the rules below.

<rules>
${rules}
</rules>

${OUTPUT_CONTRACT}

${MARKER_NOTE}`;

	const user = `## Working directory
${cwd}

## Conversation (use this to gauge the user's intent)
${transcript}

## Proposed tool call
Tool: ${toolName}
Input (JSON): ${renderInput(input)}

Review this call against the rules and the user's intent. Reply with the JSON verdict only.`;

	return { system, user };
}

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

const RAW_CLIP = 400;
function clipRaw(text: string): string {
	return text.length <= RAW_CLIP ? text : text.slice(0, RAW_CLIP) + " …[truncated]";
}

/** One reviewer LLM round-trip. Never throws; fail-closed on any problem. */
export async function runReviewer(
	ctx: ExtensionContext,
	state: ReviewerState,
	cfg: ReviewerConfig,
	rules: string,
	model: Model,
	toolName: string,
	input: Record<string, unknown>,
): Promise<Verdict> {
	const modelLabel = `${model.provider}/${model.id}`;
	const { system, user } = buildReviewerPrompt(cfg, rules, ctx.cwd, buildTranscript(ctx, cfg), toolName, input);
	const systemPlain = system.replace(MARKER_NOTE + "\n\n", "").replace("\n\n" + MARKER_NOTE, "").replace(MARKER_NOTE, "");

	const timeoutController = new AbortController();
	const timer = setTimeout(() => timeoutController.abort(), cfg.reviewTimeoutMs);
	const signals = [timeoutController.signal, ...(ctx.signal ? [ctx.signal] : [])];
	const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

	const messages = [
		{ role: "user" as const, content: [{ type: "text" as const, text: user }], timestamp: Date.now() },
	];
	const call = (sys: string) =>
		ctx.modelRegistry.complete(
			model,
			{ systemPrompt: sys, messages },
			{
				thinkingLevel: cfg.reviewerThinking,
				cacheRetention: "none",
				sessionId: randomUUID(),
				signal,
			},
		);

	try {
		let response;
		try {
			// With marker: index.ts may attach response_format (structured outputs)
			response = await call(system);
		} catch (first) {
			if (signal.aborted) throw first;
			// Provider may reject structured outputs — retry once without the marker.
			response = await call(systemPlain);
		}
		clearTimeout(timer);
		const text = responseText(response);
		const parsed = parseVerdict(text);
		if (!parsed) {
			return {
				decision: "deny",
				confidence: "high",
				reason: `Reviewer reply was not a valid verdict (model: ${modelLabel}). Call blocked (fail-closed).`,
				reviewerModel: modelLabel,
				source: "fail-closed",
				raw: clipRaw(text),
			};
		}
		return { ...parsed, reviewerModel: modelLabel, source: "reviewer", raw: clipRaw(text) };
	} catch (e) {
		clearTimeout(timer);
		const aborted = signal.aborted;
		const detail = aborted ? "aborted or timed out" : e instanceof Error ? e.message : String(e);
		return {
			decision: "deny",
			confidence: "high",
			reason: `Reviewer unavailable (${detail}; model: ${modelLabel}). Call blocked (fail-closed).`,
			reviewerModel: modelLabel,
			source: "fail-closed",
		};
	}
}
