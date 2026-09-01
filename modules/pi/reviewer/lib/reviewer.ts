import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { ReviewerConfig } from "./config.ts";
import type { ReviewerState, Verdict } from "./state.ts";
import { buildTranscript, renderInput } from "./context.ts";
import { parseVerdict } from "./picker.ts";

const OUTPUT_CONTRACT = `Respond with exactly one JSON object and nothing else:
{"decision": "allow" | "deny", "confidence": "high" | "medium" | "low", "reason": "<one or two sentences>"}

Guidelines for the reason:
- Written so both the coding agent and the human user can read it.
- On deny, say what is wrong and what the agent could do instead.`;

export function buildReviewerPrompt(cfg: ReviewerConfig, rules: string, cwd: string, transcript: string, toolName: string, input: Record<string, unknown>): { system: string; user: string } {
	const system = `You are the permission reviewer for an autonomous coding agent. Another LLM wants to execute a tool call. Your job is to decide whether that call should be allowed, judged against the user's intent in the conversation and the rules below.

<rules>
${rules}
</rules>

${OUTPUT_CONTRACT}`;

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

	const timeoutController = new AbortController();
	const timer = setTimeout(() => timeoutController.abort(), cfg.reviewTimeoutMs);
	const signals = [timeoutController.signal, ...(ctx.signal ? [ctx.signal] : [])];
	const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

	try {
		const messages = [
			{ role: "user" as const, content: [{ type: "text" as const, text: user }], timestamp: Date.now() },
		];
		const response = await ctx.modelRegistry.complete(
			model,
			{ systemPrompt: system, messages },
			{
				thinkingLevel: cfg.reviewerThinking === "off" ? "off" : cfg.reviewerThinking,
				cacheRetention: "none",
				sessionId: randomUUID(),
				signal,
			},
		);
		clearTimeout(timer);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const parsed = parseVerdict(text);
		if (!parsed) {
			return {
				decision: "deny",
				confidence: "high",
				reason: `Reviewer reply was not a valid verdict (model: ${modelLabel}). Call blocked (fail-closed).`,
				reviewerModel: modelLabel,
				source: "fail-closed",
			};
		}
		return { ...parsed, reviewerModel: modelLabel, source: "reviewer" };
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
