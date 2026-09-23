/**
 * Human-readable previews of a proposed tool call, for display only.
 * Permission decisions never use these: the reviewer and approval binding
 * always work on the complete serialized input. Edit previews show every
 * character of oldText/newText; write previews collapse only lines that are
 * identical to the current file (the raw JSON view shows the exact call).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type PreviewKind = "heading" | "context" | "add" | "remove" | "warn" | "plain" | "gap";
export interface PreviewLine { kind: PreviewKind; text: string; gutter?: string }
export interface Preview { lines: PreviewLine[] }
export type ReadFile = (path: string) => string;

const defaultRead: ReadFile = path => readFileSync(path, "utf8");
const WRITE_CONTEXT = 3;

/** Make terminal control characters visible so file content cannot restyle or spoof the UI. */
export function sanitize(text: string): string {
	return text.replace(/\t/g, "    ").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
		ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function oneLine(text: string): string {
	const lines = text.trim().split("\n");
	return lines[0].replace(/\s+/g, " ") + (lines.length > 1 ? " …" : "");
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function normalizeEdits(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
	const edits = Array.isArray(input.edits) ? input.edits : [];
	const out = edits.map(e => ({ oldText: String((e as { oldText?: unknown })?.oldText ?? ""), newText: String((e as { newText?: unknown })?.newText ?? "") }));
	// Legacy shape: top-level oldText/newText.
	if (typeof input.oldText === "string" && typeof input.newText === "string") out.push({ oldText: input.oldText, newText: input.newText });
	return out;
}

/** One-line description of the call's target (command, path, query...). */
export function callTarget(toolName: string, input: Record<string, unknown>): string {
	let target: string;
	if (toolName === "bash") target = oneLine(str(input.command) ?? "");
	else if (toolName === "edit") target = `${str(input.path) ?? "?"} (${plural(normalizeEdits(input).length, "edit")})`;
	else if (toolName === "write") {
		const content = str(input.content) ?? "";
		target = `${str(input.path) ?? "?"} (${plural(content ? content.split("\n").length : 0, "line")})`;
	} else {
		const key = ["path", "query", "url", "command", "pattern", "tool", "name"].find(k => str(input[k]));
		const json = JSON.stringify(input) ?? "";
		target = key ? oneLine(str(input[key])!) : json === "{}" ? "" : json;
	}
	target = sanitize(target);
	return target.length > 200 ? target.slice(0, 199) + "…" : target;
}

function occurrences(haystack: string, needle: string): { count: number; first: number } {
	let count = 0, first = -1;
	for (let at = haystack.indexOf(needle); at >= 0 && needle; at = haystack.indexOf(needle, at + needle.length)) {
		if (first < 0) first = at;
		count++;
	}
	return { count, first };
}

/** Line diff of an exact replacement: shared leading/trailing lines are context. */
function diffLines(oldText: string, newText: string, start?: number): PreviewLine[] {
	const a = oldText.split("\n"), b = newText.split("\n");
	let pre = 0;
	while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
	let suf = 0;
	while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
	const num = (i: number) => start === undefined ? "" : String(start + i);
	const lines: PreviewLine[] = [];
	for (let i = 0; i < pre; i++) lines.push({ kind: "context", text: sanitize(a[i]), gutter: num(i) });
	for (let i = pre; i < a.length - suf; i++) lines.push({ kind: "remove", text: sanitize(a[i]), gutter: num(i) });
	for (let j = pre; j < b.length - suf; j++) lines.push({ kind: "add", text: sanitize(b[j]), gutter: "" });
	for (let i = a.length - suf; i < a.length; i++) lines.push({ kind: "context", text: sanitize(a[i]), gutter: num(i) });
	return lines;
}

function tryRead(read: ReadFile, cwd: string, path: string): string | undefined {
	try { return read(resolve(cwd, path.replace(/^@/, ""))); } catch { return undefined; }
}

function editPreview(input: Record<string, unknown>, cwd: string, read: ReadFile): Preview {
	const path = str(input.path) ?? "";
	const edits = normalizeEdits(input);
	const current = path ? tryRead(read, cwd, path) : undefined;
	const lines: PreviewLine[] = [{ kind: "heading", text: `${sanitize(path || "(missing path)")} · ${plural(edits.length, "edit")}` }];
	if (current === undefined) lines.push({ kind: "warn", text: "Cannot read the file: line numbers and match checks are unavailable." });
	if (!edits.length) lines.push({ kind: "warn", text: "No edits in this call." });
	edits.forEach((edit, i) => {
		let start: number | undefined;
		let warn: string | undefined;
		if (!edit.oldText) warn = "oldText is empty; the edit tool will reject this edit.";
		else if (current !== undefined) {
			const { count, first } = occurrences(current, edit.oldText);
			if (count === 0) warn = "oldText was not found in the current file; this edit will fail.";
			else if (count > 1) warn = `oldText occurs ${count} times; the edit tool requires a unique match.`;
			else start = current.slice(0, first).split("\n").length;
		}
		lines.push({ kind: "heading", text: `Edit ${i + 1} of ${edits.length}${start === undefined ? "" : ` · line ${start}`}` });
		if (warn) lines.push({ kind: "warn", text: warn });
		if (edit.oldText === edit.newText) lines.push({ kind: "warn", text: "oldText and newText are identical (no change)." });
		lines.push(...diffLines(edit.oldText, edit.newText, start));
	});
	return { lines };
}

function writePreview(input: Record<string, unknown>, cwd: string, read: ReadFile): Preview {
	const path = str(input.path) ?? "";
	const content = str(input.content) ?? "";
	const current = path ? tryRead(read, cwd, path) : undefined;
	const newLines = content.split("\n");
	if (current === undefined) {
		return { lines: [
			{ kind: "heading", text: `${sanitize(path || "(missing path)")} · new file · ${plural(newLines.length, "line")}` },
			...newLines.map((text, i) => ({ kind: "add" as const, text: sanitize(text), gutter: String(i + 1) })),
		] };
	}
	const lines: PreviewLine[] = [{ kind: "heading",
		text: `${sanitize(path)} · overwrite · ${plural(current.split("\n").length, "line")} → ${plural(newLines.length, "line")}` }];
	if (current === content) return { lines: [...lines, { kind: "warn", text: "Content is identical to the current file." }] };
	// Collapse long unchanged runs: they equal the current file, so nothing the call does is hidden.
	const diff = diffLines(current, content, 1);
	const firstChange = diff.findIndex(l => l.kind !== "context");
	let lastChange = diff.length - 1;
	while (lastChange >= 0 && diff[lastChange].kind === "context") lastChange--;
	const from = Math.max(0, firstChange - WRITE_CONTEXT), to = Math.min(diff.length, lastChange + 1 + WRITE_CONTEXT);
	if (from > 0) lines.push({ kind: "gap", text: `… ${plural(from, "unchanged line")} …` });
	lines.push(...diff.slice(from, to));
	if (to < diff.length) lines.push({ kind: "gap", text: `… ${plural(diff.length - to, "unchanged line")} …` });
	return { lines };
}

export function buildPreview(toolName: string, input: Record<string, unknown>, cwd: string, read: ReadFile = defaultRead): Preview {
	if (toolName === "edit") return editPreview(input, cwd, read);
	if (toolName === "write") return writePreview(input, cwd, read);
	if (toolName === "bash" && typeof input.command === "string") {
		const lines: PreviewLine[] = input.command.split("\n").map((text, i) => ({ kind: "plain", text: sanitize(text), gutter: i === 0 ? "$" : ">" }));
		if (input.timeout !== undefined) lines.push({ kind: "gap", text: `timeout: ${sanitize(String(input.timeout))}s` });
		return { lines };
	}
	return { lines: (JSON.stringify(input, null, 2) ?? "{}").split("\n").map(text => ({ kind: "plain", text: sanitize(text) })) };
}
