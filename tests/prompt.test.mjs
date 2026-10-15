// tests/prompt.test.mjs
// Node unit tests for prompt.js — JSON validation/normalization.
// Run with:  node --test tests/prompt.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAndNormalize, EVENT_SCHEMA, SYSTEM_PROMPT } from "../prompt.js";

test("validateAndNormalize — accepts a well-formed object", () => {
  const out = validateAndNormalize({
    title: "Jazz Night",
    startDateTime: "2026-03-15T19:30:00-05:00",
    endDateTime:   "2026-03-15T22:00:00-05:00",
    location: "The Velvet Lounge",
    description: "Doors at 7. $20 cover.",
    rawText: "Jazz Night\nMarch 15\n7:30 PM",
    confidence: { title: "high", startDateTime: "high", location: "medium" },
  });
  assert.equal(out.title, "Jazz Night");
  // -05:00 means 19:30 local = 00:30 UTC next day. The validator
  // re-emits a stable ISO string in UTC.
  assert.equal(out.startDateTime, "2026-03-16T00:30:00.000Z");
  assert.equal(out.endDateTime,   "2026-03-16T03:00:00.000Z");
  assert.equal(out.confidence.title, "high");
  assert.equal(out.confidence.startDateTime, "high");
  assert.equal(out.confidence.location, "medium");
});

test("validateAndNormalize — accepts JSON in a string (with fences)", () => {
  const out = validateAndNormalize(
    '```json\n{"title":"Show","startDateTime":"2026-04-01T20:00:00Z"}\n```'
  );
  assert.equal(out.title, "Show");
  assert.equal(out.startDateTime.startsWith("2026-04-01"), true);
});

test("validateAndNormalize — throws on missing title", () => {
  assert.throws(
    () => validateAndNormalize({ startDateTime: "2026-04-01T20:00:00Z" }),
    /title/i
  );
});

test("validateAndNormalize — throws on missing startDateTime", () => {
  assert.throws(
    () => validateAndNormalize({ title: "Show" }),
    /start/i
  );
});

test("validateAndNormalize — throws on unparseable date", () => {
  assert.throws(
    () => validateAndNormalize({ title: "X", startDateTime: "not a date" }),
    /unparseable/i
  );
});

test("validateAndNormalize — defaults endDateTime to start + 1h", () => {
  const out = validateAndNormalize({
    title: "X",
    startDateTime: "2026-04-01T20:00:00Z",
  });
  assert.equal(out.endDateTime, "2026-04-01T21:00:00.000Z");
});

test("validateAndNormalize — drops unknown confidence levels", () => {
  const out = validateAndNormalize({
    title: "X",
    startDateTime: "2026-04-01T20:00:00Z",
    confidence: { title: "very-high", startDateTime: "low" },
  });
  assert.equal(out.confidence.title, undefined);
  assert.equal(out.confidence.startDateTime, "low");
});

test("validateAndNormalize — coerces non-string title to trimmed string", () => {
  const out = validateAndNormalize({ title: "  Hello  ", startDateTime: "2026-04-01T20:00:00Z" });
  assert.equal(out.title, "Hello");
});

test("EVENT_SCHEMA — has the required fields", () => {
  assert.equal(EVENT_SCHEMA.required.includes("title"), true);
  assert.equal(EVENT_SCHEMA.required.includes("startDateTime"), true);
});

test("SYSTEM_PROMPT — instructs the model to return JSON", () => {
  assert.match(SYSTEM_PROMPT, /Return ONLY a JSON object/);
  assert.match(SYSTEM_PROMPT, /title/);
  assert.match(SYSTEM_PROMPT, /startDateTime/);
});
