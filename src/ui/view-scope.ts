import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Public scope only. Ordinary descendant appends are not a branch switch. */
export function subagentViewScopeGuard(ctx: ExtensionContext): () => boolean {
	const read = () => ({ cwd: ctx.cwd, session: ctx.sessionManager?.getSessionId?.(), leaf: ctx.sessionManager?.getLeafId?.() });
	let initial: ReturnType<typeof read>;
	try { initial = read(); } catch { return () => false; }
	let acceptedLeaf = initial.leaf;
	let expired = false;
	return () => {
		if (expired) return false;
		try {
			const current = read();
			if (current.cwd !== initial.cwd || current.session !== initial.session) { expired = true; return false; }
			if (current.leaf === acceptedLeaf) return true;
			if (acceptedLeaf == null || ctx.sessionManager?.getBranch?.().some((entry) => entry.id === acceptedLeaf)) {
				acceptedLeaf = current.leaf;
				return true;
			}
		} catch { /* A disposed/unreadable context must not keep a private view alive. */ }
		expired = true;
		return false;
	};
}
