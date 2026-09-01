import type { Model } from "@earendil-works/pi-ai";

export type Mode = "deny" | "ask" | "allow";

export interface Verdict {
	decision: "allow" | "deny";
	confidence: "high" | "medium" | "low";
	reason: string;
	reviewerModel?: string;
	/** raw reviewer reply (truncated) — kept for diagnosis of parse failures */
	raw?: string;
	// where the verdict came from
	source: "reviewer" | "static-allow" | "static-deny" | "fail-closed" | "user" | "not-configured";
}

export interface ReviewerState {
	mode: Mode;
	reviewerModel: Model | undefined;
	/** true once the user picked a reviewer model interactively this session */
	modelSelectedThisSession: boolean;
	/** guard so parallel tool calls don't spawn multiple model pickers */
	selectingModel: Promise<Model | undefined> | undefined;
	/** verdict cache keyed by toolName + normalized input */
	cache: Map<string, Verdict>;
}

export function createState(): ReviewerState {
	return {
		mode: "deny",
		reviewerModel: undefined,
		modelSelectedThisSession: false,
		selectingModel: undefined,
		cache: new Map(),
	};
}

export const MODE_LABELS: Record<Mode, string> = {
	deny: "deny — every reviewed call needs an explicit reviewer ALLOW (fail closed)",
	ask: "ask — reviewer advises, you approve or deny each call",
	allow: "allow — unconstrained, reviewer is bypassed",
};
