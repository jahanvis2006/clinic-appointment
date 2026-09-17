const test = require("node:test");
const assert = require("node:assert");
const { canReschedule } = require("../src/utils/reschedule");

test("canReschedule: SCHEDULED appointment is allowed", () => {
  const d = canReschedule({ status: "SCHEDULED" });
  assert.strictEqual(d.allowed, true);
});

test("canReschedule: CANCELLED appointment is rejected", () => {
  const d = canReschedule({ status: "CANCELLED" });
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, "CANCELLED");
});

test("canReschedule: COMPLETED appointment is rejected", () => {
  const d = canReschedule({ status: "COMPLETED" });
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, "COMPLETED");
});

test("canReschedule: NO_SHOW appointment is rejected", () => {
  const d = canReschedule({ status: "NO_SHOW" });
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, "NO_SHOW");
});

test("canReschedule: missing appointment is rejected", () => {
  const d = canReschedule(null);
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.reason, "NOT_FOUND");
});
