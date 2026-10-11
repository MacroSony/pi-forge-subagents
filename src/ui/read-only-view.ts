import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { plainSubagentText as plain } from "./plain-text.ts";
import { subagentViewScopeGuard } from "./view-scope.ts";

export interface ReadOnlyTask {
	id: string;
	label: string;
	detail: () => string | Promise<string>;
}
export interface ReadOnlyView {
	title: string;
	summary: string;
	tasks?: readonly ReadOnlyTask[];
}

/** One custom component owns summary, selector and detail: no nested modal or writable editor. */
export class ReadOnlySubagentView implements Component {
	private selected = 0;
	private offset = 0;
	private detailText: string | undefined;
	private loading = false;
	private generation = 0;
	private selectionChanged = false;
	private overviewOffset = 0;
	private closed = false;
	private readonly view: ReadOnlyView;
	private readonly height: () => number;
	private readonly redraw: () => void;
	private readonly close: () => void;
	private readonly accent: (text: string) => string;
	private readonly isCurrent: () => boolean;
	constructor(view: ReadOnlyView, height: () => number, redraw: () => void, close: () => void, accent: (text: string) => string = (text) => text, isCurrent: () => boolean = () => true) {
		this.view = view; this.height = height; this.redraw = redraw; this.close = close; this.accent = accent; this.isCurrent = isCurrent;
	}
	private active(): boolean {
		if (this.closed) return false;
		if (this.isCurrent()) return true;
		this.dispose();
		// Do not replace a parent editor halfway through its render pass.
		queueMicrotask(() => this.close());
		return false;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (!this.active()) return [];
		width = Math.max(1, width);
		// Reserve two rows for surrounding Pi UI, then budget our header/footer exactly.
		const height = Math.max(1, Math.floor(this.height()) - 2);
		const rows = Math.max(0, height - 2);
		const text = this.detailText ?? this.view.summary;
		const body = new Text(plain(text), 0, 0).render(Math.max(1, width));
		if (this.detailText === undefined && this.view.tasks?.length) {
			body.push("", truncateToWidth("Tasks (Enter: read-only details):", width));
			let selectedRow = body.length;
			for (const [i, task] of this.view.tasks.entries()) {
				if (i === this.selected) selectedRow = body.length;
				const label = plain(task.label).replace(/\s+/g, " ");
				const prefix = `${i === this.selected ? "›" : " "} ${i + 1}. `;
				const indent = " ".repeat(visibleWidth(prefix));
				const wrapped = new Text(label, 0, 0).render(Math.max(1, width - visibleWidth(prefix)));
				body.push(...wrapped.map((line, part) => truncateToWidth(`${part === 0 ? prefix : indent}${line}`, width)));
			}
			if (this.selectionChanged && rows > 0) {
				if (selectedRow < this.offset) this.offset = selectedRow;
				if (selectedRow >= this.offset + rows) this.offset = selectedRow - rows + 1;
				this.selectionChanged = false;
			}
		}
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, body.length - rows)));
		return [
			this.accent(truncateToWidth(plain(`${this.view.title} · read-only`), width)),
			...body.slice(this.offset, this.offset + rows),
			truncateToWidth(this.loading ? "Loading read-only detail… · Esc: return" : this.detailText !== undefined ? "↑/↓ scroll · PgUp/PgDn · Esc: return" : "↑/↓ tasks · PgUp/PgDn scroll · Enter: details · Esc: close", width),
		].slice(0, height);
	}
	handleInput(data: string): void {
		if (!this.active()) return;
		if (matchesKey(data, "escape")) {
			this.generation++;
			if (this.detailText !== undefined || this.loading) {
				this.loading = false; this.detailText = undefined; this.offset = this.overviewOffset;
			} else { this.closed = true; this.close(); return; }
		} else if (this.loading) {
			return; // Keep selection stable until details resolve or Esc cancels the pending view.
		} else if (matchesKey(data, "enter") && this.detailText === undefined) {
			const task = this.view.tasks?.[this.selected];
			if (task) {
				this.overviewOffset = this.offset;
				this.loading = true;
				const generation = ++this.generation;
				Promise.resolve().then(() => {
					if (generation !== this.generation || !this.active()) return undefined;
					return task.detail();
				}).catch((error: unknown) => `Cannot inspect this task: ${error instanceof Error ? error.message : String(error)}\nReturn to its launch branch to inspect live output/usage.`).then((text) => {
					if (generation !== this.generation || !this.active() || text === undefined) return;
					this.detailText = text; this.loading = false; this.offset = 0; this.redraw();
				});
			}
		} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const delta = matchesKey(data, "up") ? -1 : 1;
			if (this.detailText === undefined && this.view.tasks?.length) {
				this.selected = Math.max(0, Math.min(this.view.tasks.length - 1, this.selected + delta));
				this.selectionChanged = true;
			} else this.offset = Math.max(0, this.offset + delta);
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
			this.offset = Math.max(0, this.offset + (matchesKey(data, "pageUp") ? -1 : 1) * Math.max(1, this.height() - 4));
		}
		this.redraw();
	}
	dispose(): void { this.closed = true; this.loading = false; this.detailText = undefined; this.generation++; }
}

/** Caller holds the dialog gate for the entire flow. Headless output remains plain text. */
export async function showReadOnlyView(ctx: ExtensionCommandContext, view: ReadOnlyView): Promise<void> {
	if (!ctx.hasUI) { console.log(plain(view.summary)); return; }
	const isCurrent = subagentViewScopeGuard(ctx);
	if (typeof ctx.ui.custom === "function") {
		await ctx.ui.custom<void>((tui, theme, _keys, done) => new ReadOnlySubagentView(
			view, () => tui.terminal.rows, () => tui.requestRender(), () => done(undefined), (text) => theme.fg("accent", text), isCurrent,
		));
		return;
	}
	// Legacy simulated contexts lack custom(). The returned edits are deliberately ignored.
	const editor = async (title: string, text: string) => { if (isCurrent()) await ctx.ui.editor(`${plain(title)} — read-only; edits ignored`, plain(text)); };
	await editor(view.title, view.summary);
	if (!view.tasks?.length || typeof ctx.ui.select !== "function") return;
	const options = view.tasks.map((task, index) => `${index + 1}. ${plain(task.label).replace(/\s+/g, " ")}`);
	while (isCurrent()) {
		const label = await ctx.ui.select(`${plain(view.title)} — read-only tasks (Esc: close)`, options);
		if (label === undefined || !isCurrent()) return;
		const task = view.tasks[options.indexOf(label)];
		if (!task) return;
		try { await editor(view.title, await task.detail()); }
		catch (error) { await editor(view.title, `Cannot inspect this task: ${error instanceof Error ? error.message : String(error)}\nReturn to its launch branch to inspect live output/usage.`); }
	}
}
