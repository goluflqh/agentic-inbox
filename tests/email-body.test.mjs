import assert from "node:assert/strict";
import test from "node:test";
import { prepareEmailBodyForIframe } from "../app/lib/emailBody.ts";

test("formats plain-text forwarding confirmation email with preserved newlines and clickable links", () => {
	const plain = [
		"dongpinmh15@gmail.com da yeu cau tu dong chuyen tiep thu.",
		"",
		"Vui long nhap vao duong lien ket ben duoi:",
		"https://mail-settings.google.com/mail/vf-%5BANGjdJ8zq6-49goduszMMP%5D-Ima-Fymivki8SS.",
		"",
		"Hoac xem them tai: http://support.google.com/mail/bin/answer.py?answer=184973&hl=vi.",
	].join("\r\n");

	const formatted = prepareEmailBodyForIframe(plain);
	assert.match(formatted, /^<div class="plain-text-email">/);
	assert.ok(formatted.includes("\n\nVui long nhap vao duong lien ket ben duoi:\n"));
	assert.ok(
		formatted.includes(
			'<a href="https://mail-settings.google.com/mail/vf-%5BANGjdJ8zq6-49goduszMMP%5D-Ima-Fymivki8SS" target="_blank" rel="noopener noreferrer">https://mail-settings.google.com/mail/vf-%5BANGjdJ8zq6-49goduszMMP%5D-Ima-Fymivki8SS</a>.',
		),
	);
	assert.ok(
		formatted.includes(
			'<a href="http://support.google.com/mail/bin/answer.py?answer=184973&amp;hl=vi" target="_blank" rel="noopener noreferrer">http://support.google.com/mail/bin/answer.py?answer=184973&amp;hl=vi</a>.',
		),
	);
});

test("escapes raw script tags in plain-text emails", () => {
	const formatted = prepareEmailBodyForIframe("Hello <script>alert(1)</script>\nhttps://example.com");
	assert.ok(formatted.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
	assert.ok(!formatted.includes("<script>"));
});

test("leaves existing HTML email bodies untouched", () => {
	const html = "<div><p>Hello <a href=\"https://example.com\">world</a></p></div>";
	assert.equal(prepareEmailBodyForIframe(html), html);
});
