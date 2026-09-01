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

/**
 * Parse the reviewer's reply into a Verdict. Multi-strategy tolerant extraction:
 *   1. balanced-brace JSON candidates, strict JSON.parse
 *   2. same candidates after sanitizing invalid JSON escape sequences (models
 *      like to quote regex text — e.g. a reason containing "\\s+" — which is
 *      invalid JSON and defeats strict parsing)
 *   3. decision/confidence/reason fields located loosely (case-insensitive,
 *      missing confidence tolerated)
 *   4. keyword fallback: first standalone allow/deny token in the reply
 */
export function parseVerdict(text: string): { decision: "allow" | "deny"; confidence: "high" | "medium" | "low"; reason: string } | undefined {
	const decisions = new Set(["allow", "deny"]);

	function fromObject(obj: Record<string, unknown>): ReturnType<typeof parseVerdict> {
		const decision = typeof obj.decision === "string" ? obj.decision.toLowerCase() : undefined;
		const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
		if (!decision || !decisions.has(decision) || !reason) return undefined;
		const confidence =
			typeof obj.confidence === "string" && ["high", "medium", "low"].includes(obj.confidence.toLowerCase())
				? (obj.confidence.toLowerCase() as "high" | "medium" | "low")
				: "medium";
		return { decision, confidence, reason };
	}

	function balancedObjects(src: string): string[] {
		const out: string[] = [];
		for (let start = src.indexOf("{"); start !== -1; start = src.indexOf("{", start + 1)) {
			let depth = 0;
			let inString = false;
			let escaped = false;
			for (let i = start; i < src.length; i++) {
				const ch = src[i];
				if (inString) {
					if (escaped) escaped = false;
					else if (ch === "\\") escaped = true;
					else if (ch === '"') inString = false;
					continue;
				}
				if (ch === '"') inString = true;
				else if (ch === "{") depth++;
				else if (ch === "}") {
					depth--;
					if (depth === 0) {
						out.push(src.slice(start, i + 1));
						break;
					}
				}
			}
		}
		return out;
	}

	// Fix invalid escapes so JSON.parse can run: a lone backslash not followed by
	// a valid JSON escape char becomes an escaped backslash.
	function sanitize(src: string): string {
		return src.replace(/\\(?!["\\/bfnrtu])/g, "\\\\\\\\");
	}

	const candidates = balancedObjects(text);
	for (const slice of candidates) {
		try {
			const v = fromObject(JSON.parse(slice) as Record<string, unknown>);
			if (v) return v;
		} catch {
			/* fall through to sanitize */
		}
		try {
			const v = fromObject(JSON.parse(sanitize(slice)) as Record<string, unknown>);
			if (v) return v;
		} catch {
			/* try next candidate */
		}
	}

	// Loose field scan (no braces at all, or mangled beyond repair)
	const dm = text.match(/"decision"\s*:\s*"?(allow|deny)"?/i);
	if (dm) {
		const rm = text.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
		let reason = rm ? rm[1].replace(/\\(["\\n])/g, "$1") : "";
		if (!reason) {
			const after = text.slice((rm?.index ?? dm.index ?? 0) + (dm[0].length));
			reason = after.replace(/^[^a-zA-Z0-9]+/, "").slice(0, 500);
		}
		if (reason) return { decision: dm[1].toLowerCase() as "allow" | "deny", confidence: "medium", reason };
	}

	// Keyword fallback — last resort, low confidence
	const km = text.match(/\b(allow|deny)\b/i);
	if (km) {
		return { decision: km[1].toLowerCase() as "allow" | "deny", confidence: "low", reason: text.trim().slice(0, 500) };
	}
	return undefined;
}

export function cacheKey(toolName: string, input: Record<string, unknown>): string {
	return `${toolName}\u0000${renderInput(input)}`;
}
