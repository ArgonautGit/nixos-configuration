import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { Mode } from "./state.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface AllowDenyRule {
	tool: string;
	pattern?: string; // regex matched against complete serialized JSON input
}

export interface ReviewerConfig {
	defaultMode: Mode;
	/** "provider/id" or "" → must be selected interactively on first enable */
	reviewerModel: string;
	reviewerThinking: ModelThinkingLevel;
	reviewTimeoutMs: number;
	/** tools to review; empty list = review everything */
	reviewedTools: string[];
	/** restore chosen mode + reviewer model on /resume (stored in session via appendEntry) */
	sessionPersistence: boolean;
	alwaysAllow: AllowDenyRule[];
	alwaysDeny: AllowDenyRule[];
	/** deny AND stop the agent (for catastrophic calls) */
	denyTerminate: AllowDenyRule[];
	contextBudget: { maxMessages: number; maxChars: number };
}

export const DEFAULT_CONFIG: ReviewerConfig = {
	defaultMode: "deny",
	reviewerModel: "",
	reviewerThinking: "off",
	reviewTimeoutMs: 30_000,
	reviewedTools: [],
	sessionPersistence: false,
	alwaysAllow: [{ tool: "read" }],
	alwaysDeny: [{ tool: "bash", pattern: "\\brm\\s+-rf\\s+(/|~)\\b" }],
	denyTerminate: [],
	contextBudget: { maxMessages: 40, maxChars: 60_000 },
};

/** Locate config.json: env override > beside the extension > global ~/.pi path. */
export function configDirCandidates(): string[] {
	const candidates: string[] = [];
	const envPath = process.env.PI_REVIEWER_CONFIG_DIR;
	if (envPath) candidates.push(envPath);
	try {
		candidates.push(dirname(dirname(fileURLToPath(import.meta.url)))); // lib/config.ts → extension root
	} catch {
		/* jiti may not provide import.meta.url */
	}
	candidates.push(join(homedir(), ".pi", "agent", "extensions", "reviewer"));
	return candidates;
}

function deepMerge<T>(base: T, patch: Partial<T> | undefined): T {
	if (patch === undefined || patch === null || typeof patch !== "object") return base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
		if (v !== undefined) out[k] = v;
	}
	return out as T;
}

export function loadConfig(): { config: ReviewerConfig; dir: string; warnings: string[] } {
	const warnings: string[] = [];
	for (const dir of configDirCandidates()) {
		const path = join(dir, "config.json");
		try {
			const raw = readFileSync(path, "utf8");
			const parsed = JSON.parse(raw) as Partial<ReviewerConfig>;
			const config = deepMerge(DEFAULT_CONFIG, parsed);
			if (config.defaultMode !== "deny" && config.defaultMode !== "ask" && config.defaultMode !== "allow") {
				warnings.push(`config.defaultMode "${String(config.defaultMode)}" invalid, using "deny"`);
				config.defaultMode = "deny";
			}
			return { config, dir, warnings };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
			warnings.push(`failed to parse ${path}: ${String(e)}`);
		}
	}
	return { config: DEFAULT_CONFIG, dir: "", warnings };
}

export function loadRules(dir: string): { rules: string; path: string } {
	const candidates = dir
		? [join(dir, "rules.md"), join(homedir(), ".pi", "agent", "extensions", "reviewer", "rules.md")]
		: [join(homedir(), ".pi", "agent", "extensions", "reviewer", "rules.md")];
	for (const path of candidates) {
		try {
			return { rules: readFileSync(path, "utf8"), path };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") continue;
		}
	}
	return { rules: FALLBACK_RULES, path: "(built-in fallback)" };
}

const FALLBACK_RULES = `# Reviewer Rules (fallback — no rules.md found)

- Presume least privilege. Read-only actions are acceptable.
- Use the active task and recent user clarifications to interpret short follow-ups.
- Ordinary public web searches and harmless search tests are normally allowed;
  never disclose private data or credentials in queries or URLs.
- Actions that modify files, run installs or mutate system state require clear
  alignment with the active task. Deny concrete risks, explicit prohibitions or
  meaningful scope violations, not merely a different preferred diagnostic query.
- Never approve destructive, irreversible, or security-sensitive operations
  (deleting data, force-pushes, credential handling, system-wide changes).
`;
