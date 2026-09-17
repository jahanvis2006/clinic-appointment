const express = require("express");
const prisma = require("../db");
const { authenticate } = require("../middleware/auth");
const { combineDateAndTimeIST, getISTDayRange } = require("../utils/time");
const { canCancel } = require("../utils/cancellation");
const { canReschedule } = require("../utils/reschedule");
const { appointmentsOverlap } = require("../utils/overlap");
const { getClockNow } = require("../state/clock");

const router = express.Router();
router.use(authenticate);

const SORTABLE_FIELDS = {
  startTime: "startTime",
  patientName: "patient", // handled specially
  createdAt: "createdAt",
};

// GET /api/appointments
// Query params: search, doctorId, date, status, page, limit, sort, order
router.get("/", async (req, res, next) => {
  try {
    const {
      search,
      doctorId,
      date,
      status,
      page = "1",
      limit = "10",
      sort = "startTime",
      order = "asc",
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));

    const where = {};

    if (search) {
      where.patient = { name: { contains: String(search) } };
    }
    if (doctorId) {
      const d = Number(doctorId);
      if (!Number.isInteger(d)) return res.status(400).json({ message: "Invalid doctorId." });
      where.doctorId = d;
    }
    if (status) {
      const validStatuses = ["SCHEDULED", "CANCELLED", "COMPLETED", "NO_SHOW"];
      if (!validStatuses.includes(String(status).toUpperCase())) {
        return res.status(400).json({ message: "Invalid status filter." });
      }
      where.status = String(status).toUpperCase();
    }
    if (date) {
      const range = getISTDayRange(String(date));
      if (!range) return res.status(400).json({ message: "Invalid date filter." });
      // Exclusive upper bound so an appointment starting in the last minute
      // of the day (e.g. 23:45) is never silently dropped from the results.
      where.startTime = { gte: range.start, lt: range.end };
    }

    let orderBy;
    const sortOrder = order === "desc" ? "desc" : "asc";
    if (sort === "patientName") {
      orderBy = { patient: { name: sortOrder } };
    } else if (sort === "createdAt") {
      orderBy = { createdAt: sortOrder };
    } else {
      orderBy = { startTime: sortOrder };
    }

    const [total, appointments] = await Promise.all([
      prisma.appointment.count({ where }),
      prisma.appointment.findMany({
        where,
        include: { doctor: true, patient: true },
        orderBy,
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

    res.json({
      appointments,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
      sort: { field: sort, order: sortOrder },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/appointments/:id
router.get("/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid appointment id." });
    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: { doctor: true, patient: true },
    });
    if (!appointment) return res.status(404).json({ message: "Appointment not found." });
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

// POST /api/appointments
router.post("/", async (req, res, next) => {
  try {
    const { doctorId, patientId, date, startTime, endTime } = req.body;

    if (!doctorId || !patientId || !date || !startTime || !endTime) {
      return res.status(400).json({
        message: "doctorId, patientId, date, startTime and endTime are all required.",
      });
    }

    const docId = Number(doctorId);
    const patId = Number(patientId);
    if (!Number.isInteger(docId) || !Number.isInteger(patId)) {
      return res.status(400).json({ message: "doctorId and patientId must be valid ids." });
    }

    const doctor = await prisma.doctor.findUnique({ where: { id: docId } });
    if (!doctor) return res.status(404).json({ message: "Doctor not found." });

    const patient = await prisma.patient.findUnique({ where: { id: patId } });
    if (!patient) return res.status(404).json({ message: "Patient not found." });

    const start = combineDateAndTimeIST(date, startTime);
    const end = combineDateAndTimeIST(date, endTime);

    if (!start || !end) {
      return res.status(400).json({ message: "Invalid date, startTime or endTime." });
    }
    if (start.getTime() >= end.getTime()) {
      return res.status(400).json({ message: "End time must be after start time." });
    }

    // CRITICAL RULE: no overlapping appointments for the same doctor.
    // newStart < existingEnd AND newEnd > existingStart (see utils/overlap.js),
    // only against active (non-cancelled) appointments.
    //
    // The read (conflict check) and write (create) are wrapped in a single
    // Prisma transaction so that, under concurrent requests for the same
    // doctor, one request's check-then-create is not interleaved with
    // another's — closing most of the race window a plain read-then-write
    // would leave open (SQLite itself has no exclusion/overlap constraint
    // to fall back on).
    let appointment;
    try {
      appointment = await prisma.$transaction(async (tx) => {
        const candidates = await tx.appointment.findMany({
          where: { doctorId: docId, status: { not: "CANCELLED" } },
          select: { startTime: true, endTime: true },
        });

        const conflict = candidates.find((c) =>
          appointmentsOverlap(start, end, c.startTime, c.endTime)
        );

        if (conflict) {
          const conflictErr = new Error(`Dr. ${doctor.name} is already booked during this time slot.`);
          conflictErr.status = 409;
          conflictErr.conflict = { startTime: conflict.startTime, endTime: conflict.endTime };
          throw conflictErr;
        }

        return tx.appointment.create({
          data: {
            doctorId: docId,
            patientId: patId,
            startTime: start,
            endTime: end,
            status: "SCHEDULED",
            cancellationFee: 0,
          },
          include: { doctor: true, patient: true },
        });
      });
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({ message: err.message, conflict: err.conflict });
      }
      throw err;
    }

    res.status(201).json({ message: "Appointment booked successfully.", appointment });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/appointments/:id/cancel
router.patch("/:id/cancel", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid appointment id." });

    const appointment = await prisma.appointment.findUnique({ where: { id } });
    if (!appointment) return res.status(404).json({ message: "Appointment not found." });

    // Single source of truth for every cancellation rule (already
    // cancelled/completed/started, and the fee itself) — see utils/cancellation.js.
    // Uses getClockNow() (real time unless POST /api/clock has simulated a
    // moment) so cancellation behaves consistently with the rest of the
    // clock-driven automation during testing.
    const decision = canCancel(appointment, getClockNow());
    if (!decision.allowed) {
      return res.status(400).json({ message: decision.message });
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: "CANCELLED", cancellationFee: decision.fee },
      include: { doctor: true, patient: true },
    });

    res.json({
      message: "Appointment cancelled successfully.",
      cancellationType: decision.type,
      cancellationFee: decision.fee,
      appointment: updated,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/appointments/:id/reschedule
// body: { date, startTime, endTime } - same shape as booking.
//
// T6: moves an existing SCHEDULED appointment to a new date/time for the
// SAME doctor and SAME patient (neither is accepted in the body at all, so
// there's no way to smuggle a doctor/patient change through this endpoint).
// Re-runs the exact same server-side overlap check used at booking time
// (see POST / above), excluding this appointment's own current row from
// its own conflict check, and rejects cancelled/completed/no-show
// appointments up front via canReschedule().
router.patch("/:id/reschedule", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "Invalid appointment id." });

    const { date, startTime, endTime } = req.body;
    if (!date || !startTime || !endTime) {
      return res.status(400).json({ message: "date, startTime and endTime are all required." });
    }

    const appointment = await prisma.appointment.findUnique({ where: { id } });
    if (!appointment) return res.status(404).json({ message: "Appointment not found." });

    const decision = canReschedule(appointment);
    if (!decision.allowed) {
      return res.status(400).json({ message: decision.message });
    }

    const start = combineDateAndTimeIST(date, startTime);
    const end = combineDateAndTimeIST(date, endTime);
    if (!start || !end) {
      return res.status(400).json({ message: "Invalid date, startTime or endTime." });
    }
    if (start.getTime() >= end.getTime()) {
      return res.status(400).json({ message: "End time must be after start time." });
    }

    // Same transactional check-then-write pattern as booking (see POST /
    // above): the conflict read and the update happen in one transaction
    // so a concurrent request for the same doctor can't slip in between
    // them. The appointment being rescheduled is excluded from its own
    // conflict check via `id: { not: id }`, and cancelled appointments
    // never block a slot, same as at booking time.
    let updated;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const candidates = await tx.appointment.findMany({
          where: {
            doctorId: appointment.doctorId,
            status: { not: "CANCELLED" },
            id: { not: id },
          },
          select: { startTime: true, endTime: true },
        });

        const conflict = candidates.find((c) =>
          appointmentsOverlap(start, end, c.startTime, c.endTime)
        );

        if (conflict) {
          const conflictErr = new Error("This doctor is already booked during the requested time slot.");
          conflictErr.status = 409;
          conflictErr.conflict = { startTime: conflict.startTime, endTime: conflict.endTime };
          throw conflictErr;
        }

        return tx.appointment.update({
          where: { id },
          data: { startTime: start, endTime: end },
          include: { doctor: true, patient: true },
        });
      });
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({ message: err.message, conflict: err.conflict });
      }
      throw err;
    }

    res.json({ message: "Appointment rescheduled successfully.", appointment: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
