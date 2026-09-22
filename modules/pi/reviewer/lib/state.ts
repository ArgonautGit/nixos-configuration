import type { ReviewerModel } from "./models.ts";

export type Mode = "deny" | "ask" | "allow";

export interface Verdict {
	decision: "allow" | "deny";
	confidence: "high" | "medium" | "low";
	reason: string;
	reviewerModel?: string;
	/** Links the verdict to an in-memory request snapshot; never a cache key. */
	reviewId?: string;
	/** raw reviewer reply (truncated) — kept for diagnosis of parse failures */
	raw?: string;
	/** Only a validated Jev allow below the threshold is eligible. Still deny until a human approves. */
	confirmation?: "low-confidence-allow";
	classifier?: { choice: "allow" | "deny" | "uncertain"; confidence: number; probabilities: Record<"allow" | "deny" | "uncertain", number> };
	// where the verdict came from
	source: "reviewer" | "static-allow" | "static-deny" | "fail-closed" | "incomplete-context" | "user" | "not-configured";
}

export interface ReviewerState {
	mode: Mode;
	reviewerModel: ReviewerModel | undefined;
	/** true once the user picked a reviewer model interactively this session */
	modelSelectedThisSession: boolean;
	/** guard so parallel tool calls don't spawn multiple model pickers */
	selectingModel: Promise<ReviewerModel | undefined> | undefined;
	/** Last ten request snapshots for local diagnosis, not persisted or reused. */
	reviewRequests: Map<string, { system: string; user: string }>;
	generation: number;
	approvalAbort: AbortController;
	confirmationQueue: Promise<void>;
	controlFault: boolean;
}

export function createState(): ReviewerState {
	return {
		mode: "deny",
		reviewerModel: undefined,
		modelSelectedThisSession: false,
		selectingModel: undefined,
		reviewRequests: new Map(),
		generation: 0,
		approvalAbort: new AbortController(),
		confirmationQueue: Promise.resolve(),
		controlFault: false,
	};
}

export const MODE_LABELS: Record<Mode, string> = {
	deny: "deny — reviewer ALLOW required; low-confidence Jev allows need exact-call human approval",
	ask: "ask — reviewer advises, you approve or deny each call",
	allow: "allow — static/model review bypassed; explicit deny-next still applies",
};
