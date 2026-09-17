// Simulated clinic clock (T1/T2 + "CLOCK API" requirement).
//
// Automated grading needs a deterministic way to say "pretend it is this
// moment" rather than depending on the real system clock, so POST
// /api/clock stores a simulated `now` here. Every other request that needs
// "the current time" (the no-show sweep, the morning-reminder sweep) reads
// it back through getClockNow() instead of calling `new Date()` directly.
//
// This is deliberately a simple in-memory singleton, not a DB row: the
// clock is a test/simulation control, not clinic data, and keeping it out
// of the database means it never shows up in exports, backups, or the
// Outbox it drives. If no simulated time has been set yet, getClockNow()
// falls back to the real wall-clock time, so the app behaves normally
// until a test explicitly takes control of the clock.
let simulatedNow = null;

function setClockNow(date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) {
    throw new Error("Invalid simulated clock value.");
  }
  simulatedNow = d;
  return simulatedNow;
}

function getClockNow() {
  return simulatedNow ? new Date(simulatedNow.getTime()) : new Date();
}

// Test-only helper: drop back to using the real system clock.
function resetClock() {
  simulatedNow = null;
}

module.exports = { setClockNow, getClockNow, resetClock };
