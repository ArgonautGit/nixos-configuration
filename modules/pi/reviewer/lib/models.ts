import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

// Decisions models aren't chat models and are absent from pi's tool-capable
// catalogue. Keep them local to the reviewer, not in the main /model picker.
export interface JevModel {
	provider: "openrouter";
	id: string;
	api: "openrouter-decisions";
}
export type ReviewerModel = Model<Api> | JevModel;
export const JEV_MODELS: JevModel[] = ["typesafe/jev-1.13", "~typesafe/jev-latest"].map(id => ({
	provider: "openrouter", id, api: "openrouter-decisions",
}));

export function isJevModel(model: ReviewerModel): model is JevModel {
	return model.api === "openrouter-decisions";
}

export function findReviewerModel(ctx: ExtensionContext, label: string): ReviewerModel | undefined {
	const jev = JEV_MODELS.find(m => `${m.provider}/${m.id}` === label);
	if (jev) return jev;
	const slash = label.indexOf("/");
	return slash > 0 ? ctx.modelRegistry.find(label.slice(0, slash), label.slice(slash + 1)) : undefined;
}

export function hasReviewerAuth(ctx: ExtensionContext, model: ReviewerModel): boolean {
	return isJevModel(model)
		? ctx.modelRegistry.getProviderAuthStatus(model.provider).configured
		: ctx.modelRegistry.hasConfiguredAuth(model);
}
