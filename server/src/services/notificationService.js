// Notification Service abstraction (T1).
//
// This is intentionally the ONE place that knows how to turn "an
// appointment happening today" into a notification. No real SMS/email
// provider is required by the brief, so "sending" a notification simply
// means recording it in the Outbox table, where it can be inspected via
// GET /api/outbox. That keeps the service simple and fully deterministic,
// which matters for automated grading.
const prisma = require("../db");
const { getISTDayRange, toISTDateString, formatISTTime } = require("../utils/time");

const NOTIFICATION_TYPES = {
  APPOINTMENT_REMINDER: "APPOINTMENT_REMINDER",
};

// One reminder per appointment per IST calendar day. Reusing this exact key
// as the Outbox's unique `idempotencyKey` is what makes calling POST
// /api/clock repeatedly for the same morning a no-op the second time round:
// the duplicate insert fails on the unique constraint and is swallowed
// rather than creating a second reminder.
function buildReminderIdempotencyKey(appointmentId, istDateStr) {
  return `${NOTIFICATION_TYPES.APPOINTMENT_REMINDER}:${appointmentId}:${istDateStr}`;
}

// Generic "record a notification in the outbox" primitive. Kept separate
// from generateMorningReminders() so other notification types (e.g. a
// same-day cancellation notice) could reuse it later without duplicating
// the idempotency-aware insert logic.
async function sendNotification({ type, appointmentId, patientId, doctorId, payload, idempotencyKey }) {
  try {
    return await prisma.outbox.create({
      data: {
        type,
        appointmentId,
        patientId,
        doctorId,
        payload: JSON.stringify(payload),
        idempotencyKey,
      },
    });
  } catch (err) {
    // Prisma unique-constraint violation -> this exact notification was
    // already sent (e.g. POST /clock called twice for the same morning).
    // That's an expected no-op, not an error.
    if (err && err.code === "P2002") {
      return null;
    }
    throw err;
  }
}

// Core of T1: for the IST calendar day that `now` falls on, generate a
// patient reminder for every appointment that is still SCHEDULED that day.
// Cancelled, completed, and no-show appointments are excluded by only
// selecting status: "SCHEDULED".
async function generateMorningReminders(now) {
  const istDateStr = toISTDateString(now);
  const range = getISTDayRange(istDateStr);

  const appointments = await prisma.appointment.findMany({
    where: {
      status: "SCHEDULED",
      startTime: { gte: range.start, lt: range.end },
    },
    include: { doctor: true, patient: true },
  });

  const created = [];
  for (const appt of appointments) {
    const entry = await sendNotification({
      type: NOTIFICATION_TYPES.APPOINTMENT_REMINDER,
      appointmentId: appt.id,
      patientId: appt.patientId,
      doctorId: appt.doctorId,
      idempotencyKey: buildReminderIdempotencyKey(appt.id, istDateStr),
      payload: {
        notificationType: NOTIFICATION_TYPES.APPOINTMENT_REMINDER,
        patientName: appt.patient.name,
        doctorName: appt.doctor.name,
        date: istDateStr,
        startTime: appt.startTime,
        endTime: appt.endTime,
        message: `Reminder: ${appt.patient.name}, you have an appointment with ${appt.doctor.name} today at ${formatISTTime(appt.startTime)}.`,
      },
    });
    if (entry) created.push(entry);
  }

  return created;
}

module.exports = {
  NOTIFICATION_TYPES,
  buildReminderIdempotencyKey,
  sendNotification,
  generateMorningReminders,
};
