/**
 * Untrusted task/model/output text must not become terminal instructions.
 * Apply before theme styling; model-facing content and stored receipts stay untouched.
 */
export function plainSubagentText(text: string): string {
	return text
		// OSC (including clipboard/title), terminated by BEL or ST, or cut short.
		.replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "")
		// DCS, SOS, PM and APC (including inline terminal graphics).
		.replace(/(?:\x1b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c|$)/g, "")
		// Seven/eight-bit CSI: colors, cursor movement, clear-screen, private modes.
		.replace(/(?:\x1b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
		// Remaining complete ESC sequences, including charset selection and reset.
		.replace(/\x1b[ -/]*[@-~]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\t/g, " ")
		// Preserve visible Unicode and LF; remove all other C0, DEL and C1 controls.
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}
