import type { ForgeNestedUsage } from "@zihanw/pi-forge/subagent";

/** The native Usage shape accepted by Pi's tool result contract. */
export interface ForgeNativePiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface ForgeSubagentUsageMapping {
	native?: ForgeNativePiUsage;
	nested?: ForgeNestedUsage;
}

/**
 * Map the runtime's response usage without trusting its compile-time type.
 * beta.4 and custom producers are allowed to omit coverage metadata; those
 * results remain in details.response.usage but are not promoted or attributed.
 */
export function mapForgeSubagentResponseUsage(response: unknown): ForgeSubagentUsageMapping {
	if (!isRecord(response)) return {};
	return mapForgeSubagentUsage(response.usage);
}

/** Map a runtime RunUsage-shaped value to Pi native and Forge nested usage. */
export function mapForgeSubagentUsage(value: unknown): ForgeSubagentUsageMapping {
	if (!isRecord(value)) return {};

	const tokens = isRecord(value.tokens) ? value.tokens : undefined;
	const requests = isRecord(value.requests) ? value.requests : undefined;
	const cost = value.cost === undefined ? undefined : isRecord(value.cost) ? value.cost : null;
	const total = safeCount(requests?.total);
	if (total === undefined || !tokens || cost === null || !isValidTokenShape(tokens) || !isValidRequestShape(requests, total) || !isValidCostShape(cost)) return {};

	const input = safeCount(tokens.input);
	const output = safeCount(tokens.output);
	const tokenTotal = safeCount(tokens.total);
	if (input === undefined || output === undefined || tokenTotal === undefined) return {};

	const cacheRead = safeCount(tokens.cacheRead);
	const cacheWrite = safeCount(tokens.cacheWrite);
	const hasCachePair = cacheRead !== undefined && cacheWrite !== undefined;
	const cacheKnown = safeCount(requests?.cacheKnown);
	const usageKnown = safeCount(requests?.usageKnown);
	const completeCacheCoverage = cacheKnown !== undefined && cacheKnown === total;
	if (total === 0 && (input > 0 || output > 0 || (cacheRead ?? 0) > 0 || (cacheWrite ?? 0) > 0)) return {};
	const nested: ForgeNestedUsage = {
		schemaVersion: 1,
		requests: total,
		input,
		output,
		...(completeCacheCoverage && hasCachePair ? { cacheRead, cacheWrite } : {}),
	};

	// The public nested contract deliberately carries no invented request count:
	// reaching this point proves that requests.total exists. Mixed cache coverage
	// keeps the token pair absent so the host UI can show cache as unknown.
	const result: ForgeSubagentUsageMapping = { nested };
	if (
		total > 0 &&
		completeCacheCoverage &&
		usageKnown !== undefined &&
		usageKnown === total &&
		hasCachePair &&
		isConsistentTokenTotal(input, output, cacheRead, cacheWrite, tokenTotal) &&
		isCompleteUsdCost(cost)
	) {
		result.native = {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens: tokenTotal,
			cost: {
				input: cost.breakdown.input,
				output: cost.breakdown.output,
				cacheRead: cost.breakdown.cacheRead,
				cacheWrite: cost.breakdown.cacheWrite,
				total: cost.amount,
			},
		};
	}
	return result;
}

function isValidTokenShape(value: Record<string, unknown>): boolean {
	if (safeCount(value.input) === undefined || safeCount(value.output) === undefined || safeCount(value.total) === undefined) return false;
	const hasRead = value.cacheRead !== undefined;
	const hasWrite = value.cacheWrite !== undefined;
	return hasRead === hasWrite && (!hasRead || (safeCount(value.cacheRead) !== undefined && safeCount(value.cacheWrite) !== undefined));
}

function isValidRequestShape(value: Record<string, unknown> | undefined, total: number): boolean {
	if (!value) return false;
	for (const key of ["cacheKnown", "usageKnown"] as const) {
		if (value[key] !== undefined) {
			const count = safeCount(value[key]);
			if (count === undefined || count > total) return false;
		}
	}
	return true;
}

function isValidCostShape(value: Record<string, unknown> | undefined): boolean {
	if (!value) return true;
	if (!isFiniteNonNegative(value.amount) || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) return false;
	if (value.breakdown === undefined) return true;
	if (!isRecord(value.breakdown)) return false;
	return isFiniteNonNegative(value.breakdown.input) &&
		isFiniteNonNegative(value.breakdown.output) &&
		isFiniteNonNegative(value.breakdown.cacheRead) &&
		isFiniteNonNegative(value.breakdown.cacheWrite);
}

function isCompleteUsdCost(value: Record<string, unknown> | undefined): value is Record<string, unknown> & {
	amount: number;
	breakdown: { input: number; output: number; cacheRead: number; cacheWrite: number };
} {
	if (!value || value.currency !== "USD" || !isFiniteNonNegative(value.amount) || !isRecord(value.breakdown)) return false;
	return isFiniteNonNegative(value.breakdown.input) &&
		isFiniteNonNegative(value.breakdown.output) &&
		isFiniteNonNegative(value.breakdown.cacheRead) &&
		isFiniteNonNegative(value.breakdown.cacheWrite);
}

function isConsistentTokenTotal(input: number, output: number, cacheRead: number, cacheWrite: number, total: number): boolean {
	const sum = input + output + cacheRead + cacheWrite;
	return Number.isSafeInteger(sum) && sum === total;
}

function safeCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
