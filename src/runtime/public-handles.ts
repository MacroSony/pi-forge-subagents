import { randomInt } from "node:crypto";

/** Adapter-local handles: a fresh namespace on reload, one lifetime counter. */
export function createPublicHandleAllocator(): (prefix: "t" | "c") => string {
	const namespace = randomInt(36 ** 6).toString(36).padStart(6, "0");
	let counter = 0;
	return (prefix) => `${prefix}-${namespace}-${++counter}`;
}
