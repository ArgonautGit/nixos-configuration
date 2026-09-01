import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { ReviewerState } from "./state.ts";
import { renderInput } from "./context.ts";

/**
 * Pick the reviewer model, mirroring the /model picker:
 * scoped models first (same set the built-in model picker offers),
 * otherwise the full available catalogue.
 */
export async function pickReviewerModel(ctx: ExtensionContext, firstEnable: boolean): Promise<Model | undefined> {
	if (!ctx.hasUI) return undefined;

	let models: Model[] = [];
	if (ctx.scopedModels && ctx.scopedModels.length > 0) {
		models = ctx.scopedModels.map((s) => s.model);
	} else {
		try {
			models = [...ctx.modelRegistry.getAvailable()];
		} catch {
			models = [];
		}
	}
	if (models.length === 0) {
		ctx.ui.notify("No models available for the reviewer", "error");
		return undefined;
	}

	const options = models.map((m) => `${m.provider}/${m.id}`);
	const title = firstEnable
		? "Reviewer model required — select the model that will review tool calls (like /model):"
		: "Select reviewer model:";
	const choice = await ctx.ui.select(title, options);
	if (choice === undefined) return undefined;

	const slash = choice.indexOf("/");
	const model = ctx.modelRegistry.find(choice.slice(0, slash), choice.slice(slash + 1));
	if (!model) {
		ctx.ui.notify(`Model ${choice} not found`, "error");
		return undefined;
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		ctx.ui.notify(`No authentication configured for ${choice} — pick another`, "warning");
		return undefined;
	}
	return model;
}

/** Parse the reviewer's reply into a Verdict. Tolerant JSON extraction. */
export function parseVerdict(text: string): { decision: "allow" | "deny"; confidence: "high" | "medium" | "low"; reason: string } | undefined {
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					const slice = text.slice(start, i + 1);
					try {
						const obj = JSON.parse(slice) as Record<string, unknown>;
						const decision = obj.decision;
						const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
						if ((decision === "allow" || decision === "deny") && reason) {
							const confidence =
								obj.confidence === "high" || obj.confidence === "medium" || obj.confidence === "low"
									? obj.confidence
									: "medium";
							return { decision, confidence, reason };
						}
					} catch {
						/* try next candidate */
					}
					break;
				}
			}
		}
	}
	return undefined;
}

export function cacheKey(toolName: string, input: Record<string, unknown>): string {
	return `${toolName}\u0000${renderInput(input)}`;
}
