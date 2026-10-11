import assert from "node:assert/strict";
import test from "node:test";
import { plainSubagentText } from "../src/ui/plain-text.ts";

test("human text strips cursor/clear/color CSI and keeps visible text", () => {
	assert.equal(plainSubagentText("ok\x1b[2J\x1b[H\x1b[31mred\x1b[0m\u009b2Jend"), "okredend");
});

test("human text drops OSC clipboard/title/hyperlinks and DCS/APC payloads", () => {
	for (const payload of ["\x1b]52;c;HIDDEN\x07", "\x1b]0;HIDDEN\x1b\\", "\u009d52;c;HIDDEN\u009c", "\x1bPtmux;HIDDEN\x1b\\", "\x1b_HIDDEN\x1b\\", "\u0090HIDDEN\u009c", "\u009fHIDDEN\u009c", "\x1bXHIDDEN\x1b\\", "\x1b^HIDDEN\x1b\\"])
		assert.equal(plainSubagentText(`left${payload}right`), "leftright", JSON.stringify(payload));
	assert.equal(plainSubagentText("\x1b]8;;https://example.invalid\x07visible link\x1b]8;;\x07"), "visible link");
});

test("unterminated control strings cannot leak terminal payloads", () => {
	for (const payload of ["\x1b]52;c;HIDDEN", "\x1bPDEFERRED", "\u009dHIDDEN", "\u009fHIDDEN"])
		assert.equal(plainSubagentText(`left${payload}`), "left");
});

test("preserve CJK/emoji/newlines and literal escape spellings, normalize CRLF and tabs", () => {
	assert.equal(plainSubagentText("中文🙂\r\nrow\t2\x00\b\x7f\u0085\u009c\\x1b[2J"), "中文🙂\nrow 2\\x1b[2J");
});
