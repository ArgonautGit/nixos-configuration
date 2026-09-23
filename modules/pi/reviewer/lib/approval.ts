/**
 * Ask-mode approval dialog: one scrollable view of the exact call.
 * Allow is accepted only after the end of the preview has been on screen,
 * so the complete call is inspected before approval. Esc/d deny.
 */
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { Preview, PreviewLine } from "./preview.ts";

export type ApprovalChoice = "allow" | "deny" | "cancel";

export interface ApprovalTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ApprovalViewOptions {
	title: string;
	details: string[];
	preview: Preview;
	/** Exact JSON snapshot bound to the approval (cwd, tool, call ID, input). */
	raw: string;
	theme: ApprovalTheme;
	rows: () => number;
	requestRender: () => void;
	done: (choice: ApprovalChoice) => void;
}

/** Hard-wrap by display width, preserving indentation (code must not be reflowed). */
export function hardWrap(text: string, width: number): string[] {
	if (width < 1) return [text];
	const out: string[] = [];
	let line = "", used = 0;
	for (const ch of Array.from(text)) {
		const w = visibleWidth(ch);
		if (used + w > width && line) { out.push(line); line = ""; used = 0; }
		line += ch;
		used += w;
	}
	out.push(line);
	return out;
}

export class ApprovalView implements Component {
	private rawMode = false;
	private offset = 0;
	private seenEnd = false;
	private notice = "";
	private viewport = 1;
	private settled = false;
	private readonly o: ApprovalViewOptions;

	constructor(options: ApprovalViewOptions) {
		this.o = options;
	}

	invalidate(): void {}

	private styled(line: PreviewLine, width: number, gutterWidth: number): string[] {
		const t = this.o.theme;
		const sign = line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : line.kind === "context" ? "  " : "";
		const color = line.kind === "add" ? "toolDiffAdded" : line.kind === "remove" ? "toolDiffRemoved"
			: line.kind === "context" ? "toolDiffContext" : line.kind === "warn" ? "warning" : line.kind === "gap" ? "dim" : "";
		const text = line.kind === "warn" ? "⚠ " + line.text : line.text;
		const gutter = gutterWidth ? (line.gutter ?? "").padStart(gutterWidth) + " " : "";
		const pieces = hardWrap(text, Math.max(10, width - gutter.length - sign.length));
		return pieces.map((piece, i) => {
			const g = t.fg("dim", i === 0 ? gutter : " ".repeat(gutter.length));
			const s = i === 0 ? sign : " ".repeat(sign.length);
			const body = line.kind === "heading" ? t.fg("accent", t.bold(piece)) : color ? t.fg(color, s + piece) : s + piece;
			return g + body;
		});
	}

	private body(width: number): string[] {
		if (this.rawMode) return this.o.raw.split("\n").flatMap(l => hardWrap(l, width));
		const gutterWidth = Math.max(0, ...this.o.preview.lines.map(l => (l.gutter ?? "").length));
		return this.o.preview.lines.flatMap(l => this.styled(l, width, gutterWidth));
	}

	render(width: number): string[] {
		const t = this.o.theme;
		const inner = Math.max(20, width - 2);
		const rule = t.fg("borderMuted", "─".repeat(Math.max(1, width)));
		const header = [
			" " + truncateToWidth(t.fg("warning", t.bold("Approve tool call? ")) + this.o.title, inner),
			...this.o.details.flatMap(d => wrapTextWithAnsi(d, inner)).map(l => " " + t.fg("dim", l)),
		];
		const body = this.body(inner);
		this.viewport = Math.max(3, Math.floor(this.o.rows() * 0.75) - header.length - 4);
		const maxOffset = Math.max(0, body.length - this.viewport);
		this.offset = Math.min(Math.max(0, this.offset), maxOffset);
		if (this.offset >= maxOffset) this.seenEnd = true;
		const shown = body.slice(this.offset, this.offset + this.viewport).map(l => " " + truncateToWidth(l, inner));
		const position = body.length > this.viewport
			? `lines ${this.offset + 1}–${Math.min(body.length, this.offset + this.viewport)} of ${body.length} · `
			: "";
		const keys = `${position}↑↓ PgUp PgDn scroll · r ${this.rawMode ? "diff view" : "raw JSON"} · `
			+ (this.seenEnd ? "a allow once" : "a (scroll to end first)") + " · d/Esc deny";
		return [
			rule, ...header, rule, ...shown, rule,
			" " + truncateToWidth(t.fg("dim", keys), inner),
			...(this.notice ? [" " + truncateToWidth(t.fg("warning", this.notice), inner)] : []),
		];
	}

	private finish(choice: ApprovalChoice): void {
		if (this.settled) return;
		this.settled = true;
		this.o.done(choice);
	}

	handleInput(data: string): void {
		this.notice = "";
		const page = Math.max(1, this.viewport - 1);
		if (matchesKey(data, "up") || matchesKey(data, "k")) this.offset--;
		else if (matchesKey(data, "down") || matchesKey(data, "j")) this.offset++;
		else if (matchesKey(data, "pageUp")) this.offset -= page;
		else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.offset += page;
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER; // clamped in render
		else if (matchesKey(data, "r")) { this.rawMode = !this.rawMode; this.offset = 0; }
		else if (matchesKey(data, "a")) {
			if (this.seenEnd) return this.finish("allow");
			this.notice = "Scroll to the end of the call before allowing it (End, PgDn, ↓).";
		} else if (matchesKey(data, "d")) return this.finish("deny");
		else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.finish("cancel");
		this.o.requestRender();
	}
}
