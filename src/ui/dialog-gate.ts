/** Pi exposes one dialog slot per UI. Never replace a pending approval with a view. */
interface DialogGate {
	tail: Promise<void>;
	pending: number;
}
const gates = new WeakMap<object, DialogGate>();

function gateFor(ui: object): DialogGate {
	let gate = gates.get(ui);
	if (!gate) {
		gate = { tail: Promise.resolve(), pending: 0 };
		gates.set(ui, gate);
	}
	return gate;
}

/** Approvals queue in order, including behind an already-open human view. */
export function withSubagentDialog<T>(ui: object, work: () => Promise<T>): Promise<T> {
	const gate = gateFor(ui);
	gate.pending++;
	const next = gate.tail.then(work);
	// A rejected/cancelled dialog must not poison the following queue.
	gate.tail = next.then(() => undefined, () => undefined);
	return next.finally(() => { gate.pending--; });
}

/** Human views decline immediately while a dialog is active or queued. */
export async function trySubagentView<T>(ui: object, work: () => Promise<T>): Promise<
	{ opened: false } | { opened: true; value: T }
> {
	if (gateFor(ui).pending > 0) return { opened: false };
	// No await between the occupancy check and synchronous reservation.
	return withSubagentDialog(ui, async () => ({ opened: true as const, value: await work() }));
}
