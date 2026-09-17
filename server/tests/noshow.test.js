const test = require("node:test");
const assert = require("node:assert");
const { isNoShowDue, noShowCutoff } = require("../src/utils/noshow");

test("29 minutes after start -> not yet due for NO_SHOW", () => {
  const start = new Date("2026-09-17T09:00:00+05:30");
  const now = new Date("2026-09-17T09:29:00+05:30");
  assert.strictEqual(isNoShowDue(start, now), false);
});

test("exactly 30 minutes after start -> due for NO_SHOW", () => {
  const start = new Date("2026-09-17T09:00:00+05:30");
  const now = new Date("2026-09-17T09:30:00+05:30");
  assert.strictEqual(isNoShowDue(start, now), true);
});

test("more than 30 minutes after start -> due for NO_SHOW", () => {
  const start = new Date("2026-09-17T09:00:00+05:30");
  const now = new Date("2026-09-17T10:15:00+05:30");
  assert.strictEqual(isNoShowDue(start, now), true);
});

test("before start time -> never due", () => {
  const start = new Date("2026-09-17T09:00:00+05:30");
  const now = new Date("2026-09-17T08:59:00+05:30");
  assert.strictEqual(isNoShowDue(start, now), false);
});

test("noShowCutoff: is exactly 30 minutes before `now`", () => {
  const now = new Date("2026-09-17T09:30:00+05:30");
  const cutoff = noShowCutoff(now);
  assert.strictEqual(cutoff.toISOString(), new Date("2026-09-17T09:00:00+05:30").toISOString());
});
