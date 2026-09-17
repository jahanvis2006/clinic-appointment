// No-show automation (T2). Single source of truth for "which appointments
// are due to flip to NO_SHOW right now?", driven by POST /api/clock.
const prisma = require("../db");
const { noShowCutoff } = require("../utils/noshow");

// Only SCHEDULED appointments can ever become NO_SHOW - COMPLETED and
// CANCELLED are left untouched no matter how much time has passed, and an
// appointment already marked NO_SHOW is simply matched by nothing further
// (idempotent: calling this repeatedly for the same `now` re-matches zero
// rows the second time).
async function processNoShows(now) {
  const cutoff = noShowCutoff(now);
  const result = await prisma.appointment.updateMany({
    where: {
      status: "SCHEDULED",
      startTime: { lte: cutoff },
    },
    data: { status: "NO_SHOW" },
  });
  return result.count;
}

module.exports = { processNoShows };
