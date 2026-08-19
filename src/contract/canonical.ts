import type { AgentProfile, PromptStack } from "./types.ts";
import {
	fingerprint,
	type Fingerprint,
} from "@zihanw/pi-subagent-runtime";

/**
 * Canonical serialization and fingerprints are owned by
 * @zihanw/pi-subagent-runtime core. The execution contract re-exports them
 * under the `Subagent`-prefixed names the 0.4 host contract always used. The
 * exposed algorithms are identical, so existing fingerprint values are
 * unchanged.
 *
 * Note: conversation and execution fingerprints are issued only by the
 * runtime during plan sealing; this package never computes them. The helpers
 * below cover host-owned source provenance (profiles and prompt stacks) and
 * are applied to host-issued snapshots received over the host port.
 */
export { canonicalJson as canonicalSubagentJson } from "@zihanw/pi-subagent-runtime";
export { fingerprint as subagentFingerprint } from "@zihanw/pi-subagent-runtime";
export { FINGERPRINT_PREFIX as SUBAGENT_FINGERPRINT_PREFIX } from "@zihanw/pi-subagent-runtime";
export { promptRuntimeFingerprint as subagentPromptRuntimeFingerprint } from "@zihanw/pi-subagent-runtime";

export function subagentSourceProfileFingerprint(profile: AgentProfile): Fingerprint {
	return fingerprint(profile);
}

export function subagentPromptStackFingerprint(stack: PromptStack): Fingerprint {
	return fingerprint(stack);
}
