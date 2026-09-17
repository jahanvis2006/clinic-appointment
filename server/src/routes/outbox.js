const express = require("express");
const prisma = require("../db");
const { authenticate } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate);

// GET /api/outbox
// Optional filters: ?type=APPOINTMENT_REMINDER, ?appointmentId=1, ?patientId=1
// Lets the evaluator (or the UI, or a test) inspect every notification the
// Notification Service has recorded, newest first.
router.get("/", async (req, res, next) => {
  try {
    const { type, appointmentId, patientId } = req.query;
    const where = {};

    if (type) where.type = String(type);
    if (appointmentId) {
      const a = Number(appointmentId);
      if (!Number.isInteger(a)) return res.status(400).json({ message: "Invalid appointmentId." });
      where.appointmentId = a;
    }
    if (patientId) {
      const p = Number(patientId);
      if (!Number.isInteger(p)) return res.status(400).json({ message: "Invalid patientId." });
      where.patientId = p;
    }

    const entries = await prisma.outbox.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    res.json({
      outbox: entries.map((entry) => ({
        ...entry,
        payload: JSON.parse(entry.payload),
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
