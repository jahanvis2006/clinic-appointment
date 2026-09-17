// No-show policy (T2): an appointment becomes NO_SHOW exactly when the
// simulated clock is at least 30 minutes past its start time and it has not
// been completed (or already cancelled). The "at least" boundary is
// inclusive, so exactly 30 minutes past start already counts.
//
// Pure function (no DB access) so it's directly unit-testable, mirroring
// the style of utils/cancellation.js and utils/overlap.js.
const NO_SHOW_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function isNoShowDue(startTime, now) {
  const start = new Date(startTime).getTime();
  const current = new Date(now).getTime();
  return current - start >= NO_SHOW_THRESHOLD_MS;
}

// Given a simulated `now`, returns the cutoff instant: any SCHEDULED
// appointment whose startTime is at or before this cutoff is due to become
// NO_SHOW. Exposed separately so the DB-facing service can turn this into a
// single `startTime: { lte: cutoff }` query instead of loading every row
// into memory to re-check isNoShowDue() one at a time.
function noShowCutoff(now) {
  return new Date(new Date(now).getTime() - NO_SHOW_THRESHOLD_MS);
}

module.exports = { isNoShowDue, noShowCutoff, NO_SHOW_THRESHOLD_MS };
