const express = require("express");
const { authenticate } = require("../middleware/auth");
const { setClockNow, getClockNow } = require("../state/clock");
const { processNoShows } = require("../services/noShowService");
const { generateMorningReminders } = require("../services/notificationService");

const router = express.Router();
router.use(authenticate);

// GET /api/clock - read the current simulated (or real, if never set) time.
router.get("/", (req, res) => {
  res.json({ now: getClockNow().toISOString() });
});

// POST /api/clock
// body: { "now": "2026-09-17T08:00:00+05:30" }
//
// Advances the simulated clinic clock to `now` and, as a side effect, runs
// the two pieces of clock-driven automation:
//   1. T2 - flip any SCHEDULED appointment at least 30 minutes past its
//      start time to NO_SHOW.
//   2. T1 - generate a reminder notification (recorded in the Outbox) for
//      every appointment still SCHEDULED on `now`'s IST calendar day.
// Both are idempotent, so calling this repeatedly with the same or an
// earlier `now` never double-processes anything.
router.post("/", async (req, res, next) => {
  try {
    const { now } = req.body || {};
    if (!now) {
      return res.status(400).json({ message: 'Request body must include "now", e.g. "2026-09-17T08:00:00+05:30".' });
    }

    const parsed = new Date(now);
    if (isNaN(parsed.getTime())) {
      return res.status(400).json({ message: "Invalid 'now' timestamp. Use an ISO-8601 datetime with an offset." });
    }

    setClockNow(parsed);

    const noShowsMarked = await processNoShows(parsed);
    const reminders = await generateMorningReminders(parsed);

    res.json({
      message: "Clock advanced.",
      now: parsed.toISOString(),
      noShowsMarked,
      remindersGenerated: reminders.length,
      reminders: reminders.map((r) => ({ ...r, payload: JSON.parse(r.payload) })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
