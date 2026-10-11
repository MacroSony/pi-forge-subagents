import type { ExtensionAPI, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { plainSubagentText } from "./plain-text.ts";

const completionType = "forge-subagent-completion";
const rowPattern = /^([a-zA-Z0-9_-]{1,24}): (completed|failed|cancelled|timed-out|limit-reached)$/;
const prefix = "Background subagent tasks finished: ";
const suffix = ". Call forge_subagent_task action result with each task id to collect the result.";
type CompletionTask = { id: string; status: string };
type CompletionMessage = Pick<Parameters<MessageRenderer>[0], "content" | "details">;

/** Strict legacy format: never interpret arbitrary message text as a task receipt. */
export function parseCompletionTasks(content: string): CompletionTask[] | undefined {
	if (!content.startsWith(prefix) || !content.endsWith(suffix)) return undefined;
	const rows = content.slice(prefix.length, -suffix.length).split("; ");
	const tasks: CompletionTask[] = [];
	for (const row of rows) {
		const match = rowPattern.exec(row);
		if (!match || match[0] !== row) return undefined;
		tasks.push({ id: match[1]!, status: match[2]! });
	}
	return tasks.length ? tasks : undefined;
}

function tasksFromDetails(details: unknown): CompletionTask[] | undefined {
	if (!details || typeof details !== "object" || !("tasks" in details) || !Array.isArray(details.tasks) || !details.tasks.length) return undefined;
	const tasks: CompletionTask[] = [];
	for (const row of details.tasks) {
		if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.status !== "string") return undefined;
		const text = `${row.id}: ${row.status}`;
		const match = rowPattern.exec(text);
		if (!match || match[0] !== text) return undefined;
		tasks.push({ id: row.id, status: row.status });
	}
	return tasks;
}

function rawContent(message: CompletionMessage): string {
	return plainSubagentText(typeof message.content === "string" ? message.content : message.content
		.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
}

/** Display only: historical send-time statuses, not current collection state. */
export function renderCompletionMessage(message: CompletionMessage, expanded: boolean, theme: Theme, width: number): string[] {
	const columns = Math.max(0, Math.floor(width));
	if (!columns) return [];
	const tasks = tasksFromDetails(message.details) ?? (typeof message.content === "string" ? parseCompletionTasks(message.content) : undefined);
	let text = theme.fg("customMessageText", rawContent(message));
	if (!expanded && tasks) {
		const label = theme.fg("customMessageLabel", `◆ Background subagent${tasks.length === 1 ? "" : "s"} finished`);
		const rows = tasks.map(({ id, status }) => {
			const icon = status === "completed" ? "✓" : status === "failed" ? "✗" : "○";
			const color = status === "completed" ? "success" : status === "failed" ? "error" : status === "timed-out" ? "warning" : "muted";
			return `${theme.fg(color, icon)} ${theme.fg("customMessageText", `${plainSubagentText(id)} ${plainSubagentText(status)}`)}`;
		});
		text = [label, ...rows].join(theme.fg("customMessageText", " · "));
	}
	// Guard even sub-grapheme widths (e.g. a 2-cell emoji at width 1).
	return wrapTextWithAnsi(text, columns).map((line) => visibleWidth(line) > columns ? truncateToWidth(line, columns, "") : line);
}

export function registerCompletionMessageRenderer(pi: Pick<ExtensionAPI, "registerMessageRenderer">): void {
	if (typeof pi.registerMessageRenderer !== "function") return;
	pi.registerMessageRenderer(completionType, (message, { expanded }, theme) => ({
		render: (width) => renderCompletionMessage(message, expanded, theme, width),
		invalidate() {},
	}));
}
