import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { AgentResponse, SubagentDiagnostic } from "../contract/index.ts";
import { executionDisplayLines, type SubagentExecutionDisplay } from "./execution-display.ts";
import { plainSubagentText } from "./plain-text.ts";

export interface SubagentCard {
	profileId: string;
	title?: string;
	status: string;
	execution?: SubagentExecutionDisplay;
	response?: AgentResponse;
	/** A tool launch record, not a fresh manager status. */
	launchEvent?: boolean;
	live?: boolean;
	collected?: boolean;
	/** Display-only: a result response carried no fresh usage credit. */
	noNewUsageCredited?: boolean;
	output?: string;
	progress?: string;
	warnings?: (SubagentDiagnostic | string)[];
	requested?: { model?: string; thinkingLevel?: string };
	approvalBadge?: string;
	/** Human expanded-only audit details. */
	details?: string[];
}

export function subagentUsageText(usage: NonNullable<AgentResponse["usage"]>, expanded = false, includeCost = true): string {
	const parts: string[] = [];
	if (knownCount(usage.requests?.total)) parts.push(`${usage.requests.total} req`);
	if (usage.tokens) {
		for (const field of ["input", "output", "total"] as const) {
			if (knownCount(usage.tokens[field])) parts.push(`${usage.tokens[field]} ${field}`);
		}
		if (knownCount(usage.tokens.cacheRead)) parts.push(`cacheRead ${usage.tokens.cacheRead}`);
		if (knownCount(usage.tokens.cacheWrite)) parts.push(`cacheWrite ${usage.tokens.cacheWrite}`);
	}
	if (includeCost && subagentCostText(usage)) parts.push(subagentCostText(usage));
	const native = usageCoverage(usage.requests?.usageKnown, usage.requests?.total);
	const cache = usageCoverage(usage.requests?.cacheKnown, usage.requests?.total);
	const flags = [native.state !== "full" ? `usage ${native.state}` : "", cache.state !== "full" ? `cache ${cache.state}` : ""].filter(Boolean);
	if (!parts.length) parts.push("No usage reported");
	if (flags.length) parts.push(`[${flags.join(" · ")}]`);
	if (expanded) parts.push(`coverage: usage ${native.ratio} · cache ${cache.ratio}`);
	return parts.join(" · ");
}

function usageCoverage(known: number | undefined, total: number | undefined): { state: "full" | "partial" | "unknown"; ratio: string } {
	const valid = knownCount(known) && knownCount(total) && known <= total;
	return {
		state: valid && total > 0 && known > 0 ? (known === total ? "full" : "partial") : "unknown",
		ratio: valid ? `${known}/${total}` : `${knownCount(known) ? known : "unknown"}/${knownCount(total) ? total : "unknown"}`,
	};
}

function knownCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function subagentDurationText(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs < 0) return "";
	if (durationMs > 0 && durationMs < 100) return "<0.1s";
	const seconds = Math.round(durationMs / 100) / 10;
	const format = (value: number) => value.toFixed(1).replace(/\.0$/, "");
	return seconds >= 60 ? `${Math.floor(seconds / 60)}min ${format(seconds % 60)}s` : `${format(seconds)}s`;
}

function warningText(warning: SubagentDiagnostic | string): string {
	return plainSubagentText(typeof warning === "string" ? warning : `${warning.level.toUpperCase()}: ${warning.message}`);
}

function subagentCostText(usage: NonNullable<AgentResponse["usage"]>): string {
	const cost = usage.cost;
	return cost && typeof cost.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0
		? `≈ ${plainSubagentText(cost.currency)} ${cost.amount.toFixed(4)}` : "";
}

function warningBadge(warning: SubagentDiagnostic | string): string {
	// Map diagnostic identity, not arbitrary message contents, to known risk badges.
	if (typeof warning !== "string") {
		if (warning.code.endsWith(".shared-user")) return "shared-user · no OS isolation";
		if (warning.code === "tools.none") return "No tools";
		if (warning.level === "error") return warningText(warning);
	}
	const chars = Array.from(warningText(warning).replace(/\s+/g, " ").trim());
	return chars.length <= 80 ? chars.join("") : `${chars.slice(0, 77).join("")}...`;
}

/** UI preview only; model-facing tool content is never rewritten here. */
export function subagentPreview(text: string): string {
	return plainSubagentText(text).split("\n").slice(0, 2).map((line) => Array.from(line).slice(0, 1_000).join("")).join("\n");
}

/** Defer all physical-line decisions until Pi supplies the actual terminal width. */
class CardLines extends Text {
	private readonly linesAtWidth: (width: number) => string[];
	constructor(linesAtWidth: (width: number) => string[]) {
		super("", 0, 0);
		this.linesAtWidth = linesAtWidth;
	}
	override render(width: number): string[] { return width > 0 ? this.linesAtWidth(width) : []; }
}

function thinkingColor(level: string): Parameters<Theme["fg"]>[0] {
	const colors = { off: "thinkingOff", minimal: "thinkingMinimal", low: "thinkingLow", medium: "thinkingMedium", high: "thinkingHigh", xhigh: "thinkingXhigh", max: "thinkingMax" } as const;
	return colors[level as keyof typeof colors] ?? "muted";
}

function styledMetadata(line: string, theme: Theme): string {
	const thinkingAt = line.lastIndexOf(" · thinking ");
	const model = thinkingAt < 0 ? line : line.slice(0, thinkingAt);
	const slash = model.indexOf("/");
	const styledModel = slash < 0 ? theme.fg("dim", model)
		: theme.fg("dim", model.slice(0, slash + 1)) + theme.fg("text", model.slice(slash + 1));
	if (thinkingAt < 0) return styledModel;
	const level = line.slice(thinkingAt + " · thinking ".length);
	return styledModel + theme.fg("dim", " · thinking ") + theme.fg(thinkingColor(level), level);
}

export function renderSubagentCard(card: SubagentCard, expanded: boolean, theme: Theme): Container {
	const rawStatus = plainSubagentText(card.status);
	const status = card.launchEvent ? "background started" : rawStatus;
	const terminal = !["preparing", "prepared", "awaiting-approval", "starting", "running"].includes(rawStatus);
	const icon = card.launchEvent ? "↗" : rawStatus === "completed" ? "✓" : rawStatus === "failed" ? "✗" : terminal ? "○" : "●";
	const color = card.launchEvent ? "accent" : rawStatus === "failed" ? "error" : rawStatus === "completed" ? "success" : rawStatus === "timed-out" ? "warning" : terminal ? "muted" : "accent";
	const statusLine = theme.fg(color, icon) + " " + theme.fg(color, theme.bold(status))
		+ (card.live && !terminal && !card.launchEvent ? theme.fg("dim", ", live") : "")
		+ (card.collected === undefined || !terminal || card.launchEvent ? "" : theme.fg("dim", " · ") + theme.fg(card.collected ? "dim" : "warning", card.collected ? "collected" : "uncollected"));
	const profile = plainSubagentText(card.profileId).replace(/\s+/g, " ").trim();
	// No title (expanded view, branch-gated status, management failures): omit the line instead of repeating the profile.
	const title = card.title ? plainSubagentText(card.title).replace(/\s+/g, " ").trim() : "";
	const output = card.output !== undefined ? plainSubagentText(card.output).trimEnd() : undefined;
	const progress = card.progress !== undefined ? plainSubagentText(card.progress).trimEnd() : undefined;
	const metadata = executionDisplayLines(card.execution, card.response?.model);
	const requested = card.requested && (card.requested.model !== undefined || card.requested.thinkingLevel !== undefined)
		? `requested ${plainSubagentText(card.requested.model ?? "model unspecified")} · thinking ${plainSubagentText(card.requested.thinkingLevel ?? "unspecified")}` : undefined;
	if (!card.execution && !card.response?.model && requested) metadata[0] = requested;
	const duration = card.response?.durationMs !== undefined ? subagentDurationText(card.response.durationMs) : "";
	const noNewUsage = card.noNewUsageCredited === true && Boolean(card.response);
	const adjacent = [
		noNewUsage ? theme.fg("accent", "no new usage credited") : "",
		card.execution?.contextMode === "retained" ? theme.fg("accent", "kept context") : card.execution?.contextMode === "continued" ? theme.fg("accent", "continued") : "",
		duration ? theme.fg("dim", `${noNewUsage ? "task total " : ""}${duration}`) : "",
		card.response?.usage ? theme.fg("dim", subagentCostText(card.response.usage)) : "",
	].filter(Boolean).join(theme.fg("dim", " · "));
	// Only the child's reported metrics; expanded retains the complete audit summary.
	const metrics = [duration, card.response?.usage ? subagentUsageText(card.response.usage, true) : ""].filter(Boolean).join(" · ");
	const container = new Container();
	container.addChild(new CardLines((width) => {
		const indent = " ".repeat(Math.min(2, Math.max(0, width - 1)));
		const room = width - indent.length;
		const wrap = (text: string, indented = true) => wrapTextWithAnsi(text, indented ? room : width)
			.map((line) => (indented ? indent : "") + truncateToWidth(line.trimEnd(), indented ? room : width, ""));
		const lines = adjacent && visibleWidth(statusLine) + 3 + visibleWidth(adjacent) <= width
			? [statusLine + "   " + adjacent] : [...wrap(statusLine, false), ...(adjacent ? wrap(adjacent) : [])];
		if (title) lines.push(indent + theme.fg("text", truncateToWidth(title, room, "…")));
		const meta = styledMetadata(metadata[0]!, theme);
		const combined = theme.fg("dim", profile + " · ") + meta;
		if (visibleWidth(combined) <= room) lines.push(indent + combined);
		else lines.push(...wrap(theme.fg("dim", profile)), ...wrap(meta));
		for (const line of metadata.slice(1)) lines.push(...wrap(styledMetadata(line, theme)));
		if (expanded) return lines;
		const shown: string[] = [];
		const preview = (text: string, previewColor: Parameters<Theme["fg"]>[0], full = false) => {
			const physical = wrap(full ? text : subagentPreview(text).trimEnd());
			const limited = full ? physical : physical.slice(0, 2);
			shown.push(...limited);
			lines.push(...limited.map((line) => indent + theme.fg(previewColor, line.slice(indent.length))));
		};
		const samePreview = progress && output && subagentPreview(progress).trim() === subagentPreview(output).trim();
		if (progress && !card.launchEvent && !samePreview && !terminal) preview(progress, "dim");
		if (output && !card.launchEvent) preview(output, rawStatus === "failed" ? "error" : "toolOutput", rawStatus === "failed");
		if (card.response?.usage) lines.push(...wrap(theme.fg("dim", subagentUsageText(card.response.usage, false, false))));
		const seen = new Set<string>();
		const shownText = shown.join("").replace(/\s+/g, "");
		for (const warning of card.warnings ?? []) {
			if (typeof warning !== "string" && warning.level === "info") continue;
			const message = plainSubagentText(typeof warning === "string" ? warning : warning.message).trim();
			const identity = warningText(warning);
			if (seen.has(identity) || (message && shownText.includes(message.replace(/\s+/g, "")))) continue;
			seen.add(identity);
			const warningColor = typeof warning !== "string" && warning.code.endsWith(".shared-user") ? "dim"
				: typeof warning !== "string" && warning.level === "error" ? "error" : "warning";
			lines.push(...wrap(theme.fg(warningColor, warningBadge(warning))));
		}
		return lines;
	}));
	if (!expanded) return container;
	if (requested && (card.execution || card.response?.model)) container.addChild(new Text(theme.fg("muted", requested), 0, 0));
	if (card.approvalBadge) container.addChild(new Text(theme.fg("muted", plainSubagentText(card.approvalBadge)), 0, 0));
	if (card.details?.length) container.addChild(new Text(theme.fg("muted", card.details.map(plainSubagentText).join("\n")), 0, 0));
	for (const warning of card.warnings ?? []) container.addChild(new Text(theme.fg(typeof warning !== "string" && warning.level === "error" ? "error" : "warning", warningText(warning)), 0, 0));
	if (output) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Result ───"), 0, 0));
		container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
	}
	if (metrics) container.addChild(new Text(theme.fg("dim", metrics), 0, 0));
	return container;
}
