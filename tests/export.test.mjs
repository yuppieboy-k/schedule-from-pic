// tests/export.test.mjs
// Node unit tests for the .ics generator and Google Calendar URL builder.
// Run with:  node --test tests/export.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateICS, googleCalendarURL } from "../export.js";

const sample = {
  title: "Jazz Night",
  startDateTime: "2026-03-15T19:30:00.000Z",
  endDateTime:   "2026-03-15T22:00:00.000Z",
  location: "123 Main Street",
  description: "Doors at 7. $20 cover.",
};

test("generateICS — contains required headers", () => {
  const ics = generateICS(sample);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nVERSION:2\.0\r\n/);
  assert.match(ics, /\r\nPRODID:/);
  assert.match(ics, /\r\nBEGIN:VEVENT\r\n/);
  assert.match(ics, /\r\nEND:VEVENT\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
});

test("generateICS — uses CRLF line endings", () => {
  const ics = generateICS(sample);
  assert.equal(ics.includes("\r\n"), true);
  // No bare LF outside of CRLF pairs
  const bareLF = ics.match(/(?<!\r)\n/);
  assert.equal(bareLF, null);
});

test("generateICS — DTSTART/DTEND in UTC Z form", () => {
  const ics = generateICS(sample);
  assert.match(ics, /\r\nDTSTART:20260315T193000Z\r\n/);
  assert.match(ics, /\r\nDTEND:20260215T220000Z|\r\nDTEND:20260315T220000Z\r\n/);
});

test("generateICS — escapes special chars in summary", () => {
  const ics = generateICS({ ...sample, title: "Hi, Friends; Party\\Tonight" });
  assert.match(ics, /SUMMARY:Hi\\, Friends\\; Party\\\\Tonight/);
});

test("generateICS — escapes newlines in description", () => {
  const ics = generateICS({ ...sample, description: "Line 1\nLine 2" });
  assert.match(ics, /DESCRIPTION:Line 1\\nLine 2/);
});

test("generateICS — folds long lines at 75 octets", () => {
  const long = "x".repeat(200);
  const ics = generateICS({ ...sample, description: long });
  // First content line should be <= 75 octets; continuation lines start with " "
  const lines = ics.split("\r\n");
  const descLine = lines.find((l) => l.startsWith("DESCRIPTION:"));
  assert.ok(descLine.length <= 75, `DESCRIPTION line too long: ${descLine.length}`);
  const contLines = lines.filter((l) => l.startsWith(" "));
  assert.ok(contLines.length > 0, "expected at least one folded continuation");
});

test("generateICS — every VEVENT has a UID", () => {
  const ics = generateICS(sample);
  assert.match(ics, /\r\nUID:[^\r\n]+@schedulefrompic\r\n/);
});

test("generateICS — defaults end to start + 1h when missing", () => {
  const ics = generateICS({ ...sample, endDateTime: undefined });
  assert.match(ics, /\r\nDTEND:20260315T203000Z\r\n/);
});

test("generateICS — throws on missing title", () => {
  assert.throws(() => generateICS({ ...sample, title: "" }), /title/i);
});

test("generateICS — throws on missing startDateTime", () => {
  assert.throws(() => generateICS({ ...sample, startDateTime: "" }), /start/i);
});

test("googleCalendarURL — contains action=TEMPLATE", () => {
  const url = googleCalendarURL(sample);
  assert.match(url, /action=TEMPLATE/);
  // URLSearchParams encodes spaces as "+" (both forms are valid per RFC 3986).
  assert.match(url, /text=Jazz(\+|%20)Night/);
});

test("googleCalendarURL — has UTC start/end in compact form", () => {
  const url = googleCalendarURL(sample);
  // 20260315T193000Z/20260315T220000Z
  assert.match(url, /dates=20260315T193000Z%2F20260315T220000Z/);
});

test("googleCalendarURL — includes location and details", () => {
  const url = googleCalendarURL(sample);
  assert.match(url, /location=123/);
  assert.match(url, /details=Doors/);
});
