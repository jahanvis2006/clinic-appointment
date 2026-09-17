// Integration tests for the three assessment twists (T6 reschedule, T1
// notifications, T2 no-show automation) plus the /clock and /outbox API
// surface. Unlike overlap.test.js/cancellation.test.js/reschedule.test.js/
// noshow.test.js (pure functions, no I/O), these tests exercise the real
// Express app, real routes/middleware, and the real Prisma/SQLite database
// end-to-end - the same database `npm run db:push` sets up.
//
// Everything in this file is deliberately kept in ONE test file (subtests
// run sequentially within a file) rather than split across multiple files,
// because Node's test runner executes separate files in parallel and
// SQLite only supports one writer at a time; splitting DB-touching tests
// across files risks intermittent "database is locked" errors that have
// nothing to do with the feature logic.
//
// To avoid colliding with the seed data (which uses *today*/*tomorrow* in
// IST), every appointment created here uses a fixed simulated date/time far
// in the future (2031-2033) that no seed data or other test could ever
// reasonably occupy.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const app = require("../src/index");
const prisma = require("../src/db");

let server;
let baseUrl;
let authHeaders;
let doctor;
let patient;

async function api(path, { method = "GET", body, headers } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, body: data };
}

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/api`;

  const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  const registerRes = await api("/auth/register", {
    method: "POST",
    body: {
      name: "Integration Test User",
      email: `integration_${uniqueSuffix}@clinicflow.test`,
      password: "password123",
    },
  });
  assert.strictEqual(registerRes.status, 201);
  authHeaders = { Authorization: `Bearer ${registerRes.body.token}` };

  const doctorRes = await api("/doctors", {
    method: "POST",
    body: { name: `Dr. Twist Test ${uniqueSuffix}`, specialization: "Testing" },
  });
  assert.strictEqual(doctorRes.status, 201);
  doctor = doctorRes.body.doctor;

  const patientRes = await api("/patients", {
    method: "POST",
    body: { name: `Twist Patient ${uniqueSuffix}`, phone: "9999999999" },
  });
  assert.strictEqual(patientRes.status, 201);
  patient = patientRes.body.patient;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function book(date, startTime, endTime) {
  return api("/appointments", {
    method: "POST",
    body: { doctorId: doctor.id, patientId: patient.id, date, startTime, endTime },
  });
}

// --- T6: Reschedule -------------------------------------------------------

test("T6: successful reschedule moves the appointment to the new time", async () => {
  const created = await book("2031-01-10", "09:00", "09:30");
  assert.strictEqual(created.status, 201);
  const id = created.body.appointment.id;

  const rescheduled = await api(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    body: { date: "2031-01-10", startTime: "14:00", endTime: "14:30" },
  });

  assert.strictEqual(rescheduled.status, 200);
  assert.strictEqual(rescheduled.body.appointment.status, "SCHEDULED");
  assert.strictEqual(rescheduled.body.appointment.doctor.id, doctor.id);
  assert.strictEqual(rescheduled.body.appointment.patient.id, patient.id);

  const fetched = await api(`/appointments/${id}`);
  assert.strictEqual(
    new Date(fetched.body.appointment.startTime).getTime(),
    new Date("2031-01-10T14:00:00+05:30").getTime()
  );
});

test("T6: rescheduling into an overlapping slot for the same doctor -> 409", async () => {
  const a = await book("2031-01-11", "09:00", "09:30");
  const b = await book("2031-01-11", "10:00", "10:30");
  assert.strictEqual(a.status, 201);
  assert.strictEqual(b.status, 201);

  // Try to move `a` on top of `b`.
  const conflictRes = await api(`/appointments/${a.body.appointment.id}/reschedule`, {
    method: "PATCH",
    body: { date: "2031-01-11", startTime: "10:15", endTime: "10:45" },
  });

  assert.strictEqual(conflictRes.status, 409);

  // `a` must be unchanged after the rejected reschedule.
  const stillA = await api(`/appointments/${a.body.appointment.id}`);
  assert.strictEqual(
    new Date(stillA.body.appointment.startTime).getTime(),
    new Date("2031-01-11T09:00:00+05:30").getTime()
  );
});

test("T6: boundary-touching reschedule (ends exactly when another starts) succeeds", async () => {
  const a = await book("2031-01-12", "09:00", "09:30");
  const b = await book("2031-01-12", "10:00", "10:30");
  assert.strictEqual(a.status, 201);
  assert.strictEqual(b.status, 201);

  // Move `a` to end exactly when `b` starts (09:30-10:00) - touching, not overlapping.
  const touching = await api(`/appointments/${a.body.appointment.id}/reschedule`, {
    method: "PATCH",
    body: { date: "2031-01-12", startTime: "09:30", endTime: "10:00" },
  });

  assert.strictEqual(touching.status, 200);
});

test("T6: reschedule keeps the same patient and doctor", async () => {
  const created = await book("2031-01-13", "09:00", "09:30");
  const id = created.body.appointment.id;

  const rescheduled = await api(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    // Even if a caller tried to sneak a different doctor/patient in, the
    // route only ever reads date/startTime/endTime from the body.
    body: { date: "2031-01-13", startTime: "16:00", endTime: "16:30", doctorId: 999999, patientId: 999999 },
  });

  assert.strictEqual(rescheduled.status, 200);
  assert.strictEqual(rescheduled.body.appointment.doctorId, doctor.id);
  assert.strictEqual(rescheduled.body.appointment.patientId, patient.id);
});

test("T6: a cancelled appointment's old slot does not block a reschedule into it", async () => {
  const toCancel = await book("2031-01-14", "09:00", "09:30");
  const toMove = await book("2031-01-14", "11:00", "11:30");

  const cancelRes = await api(`/appointments/${toCancel.body.appointment.id}/cancel`, { method: "PATCH" });
  assert.strictEqual(cancelRes.status, 200);

  // Move the second appointment into the now-cancelled slot - must succeed.
  const moved = await api(`/appointments/${toMove.body.appointment.id}/reschedule`, {
    method: "PATCH",
    body: { date: "2031-01-14", startTime: "09:00", endTime: "09:30" },
  });

  assert.strictEqual(moved.status, 200);
});

test("T6: cancelled/completed appointments cannot be rescheduled", async () => {
  const created = await book("2031-01-15", "09:00", "09:30");
  const id = created.body.appointment.id;
  await api(`/appointments/${id}/cancel`, { method: "PATCH" });

  const attempt = await api(`/appointments/${id}/reschedule`, {
    method: "PATCH",
    body: { date: "2031-01-16", startTime: "09:00", endTime: "09:30" },
  });

  assert.strictEqual(attempt.status, 400);
});

// --- T1 / T2 / Clock API ---------------------------------------------------

test("Clock: GET /api/clock returns an ISO timestamp", async () => {
  const res = await api("/clock");
  assert.strictEqual(res.status, 200);
  assert.ok(!isNaN(new Date(res.body.now).getTime()));
});

test("Clock: POST /api/clock rejects a missing/invalid `now`", async () => {
  const missing = await api("/clock", { method: "POST", body: {} });
  assert.strictEqual(missing.status, 400);

  const invalid = await api("/clock", { method: "POST", body: { now: "not-a-date" } });
  assert.strictEqual(invalid.status, 400);
});

test("T1: morning reminder is generated for a today-scheduled appointment, and is idempotent", async () => {
  const appt = await book("2032-02-01", "09:00", "09:30");
  const id = appt.body.appointment.id;

  const firstTick = await api("/clock", { method: "POST", body: { now: "2032-02-01T08:00:00+05:30" } });
  assert.strictEqual(firstTick.status, 200);
  assert.ok(firstTick.body.remindersGenerated >= 1);

  const outboxAfterFirst = await api(`/outbox?appointmentId=${id}`);
  assert.strictEqual(outboxAfterFirst.status, 200);
  assert.strictEqual(outboxAfterFirst.body.outbox.length, 1);
  assert.strictEqual(outboxAfterFirst.body.outbox[0].type, "APPOINTMENT_REMINDER");
  assert.strictEqual(outboxAfterFirst.body.outbox[0].appointmentId, id);
  assert.strictEqual(outboxAfterFirst.body.outbox[0].patientId, patient.id);
  assert.ok(outboxAfterFirst.body.outbox[0].payload.message.length > 0);

  // Calling /clock again for the SAME morning must not create a duplicate.
  const secondTick = await api("/clock", { method: "POST", body: { now: "2032-02-01T08:30:00+05:30" } });
  assert.strictEqual(secondTick.status, 200);

  const outboxAfterSecond = await api(`/outbox?appointmentId=${id}`);
  assert.strictEqual(outboxAfterSecond.body.outbox.length, 1, "no duplicate reminder for the same morning");
});

test("T1: cancelled and completed appointments never get a reminder", async () => {
  const cancelled = await book("2032-02-02", "09:00", "09:30");
  await api(`/appointments/${cancelled.body.appointment.id}/cancel`, { method: "PATCH" });

  const completedAppt = await book("2032-02-02", "11:00", "11:30");
  await prisma.appointment.update({
    where: { id: completedAppt.body.appointment.id },
    data: { status: "COMPLETED" },
  });

  await api("/clock", { method: "POST", body: { now: "2032-02-02T08:00:00+05:30" } });

  const cancelledOutbox = await api(`/outbox?appointmentId=${cancelled.body.appointment.id}`);
  assert.strictEqual(cancelledOutbox.body.outbox.length, 0);

  const completedOutbox = await api(`/outbox?appointmentId=${completedAppt.body.appointment.id}`);
  assert.strictEqual(completedOutbox.body.outbox.length, 0);
});

test("T2: 29 minutes after start -> still SCHEDULED", async () => {
  const appt = await book("2033-03-01", "09:00", "09:30");
  const id = appt.body.appointment.id;

  await api("/clock", { method: "POST", body: { now: "2033-03-01T09:29:00+05:30" } });

  const fetched = await api(`/appointments/${id}`);
  assert.strictEqual(fetched.body.appointment.status, "SCHEDULED");
});

test("T2: exactly 30 minutes after start -> NO_SHOW", async () => {
  const appt = await book("2033-03-02", "09:00", "09:30");
  const id = appt.body.appointment.id;

  await api("/clock", { method: "POST", body: { now: "2033-03-02T09:30:00+05:30" } });

  const fetched = await api(`/appointments/${id}`);
  assert.strictEqual(fetched.body.appointment.status, "NO_SHOW");
});

test("T2: more than 30 minutes after start -> NO_SHOW", async () => {
  const appt = await book("2033-03-03", "09:00", "09:30");
  const id = appt.body.appointment.id;

  await api("/clock", { method: "POST", body: { now: "2033-03-03T10:15:00+05:30" } });

  const fetched = await api(`/appointments/${id}`);
  assert.strictEqual(fetched.body.appointment.status, "NO_SHOW");
});

test("T2: a completed appointment stays COMPLETED even long after its start time", async () => {
  const appt = await book("2033-03-04", "09:00", "09:30");
  const id = appt.body.appointment.id;
  await prisma.appointment.update({ where: { id }, data: { status: "COMPLETED" } });

  await api("/clock", { method: "POST", body: { now: "2033-03-04T12:00:00+05:30" } });

  const fetched = await api(`/appointments/${id}`);
  assert.strictEqual(fetched.body.appointment.status, "COMPLETED");
});

test("T2: a cancelled appointment stays CANCELLED even long after its start time", async () => {
  const appt = await book("2033-03-05", "09:00", "09:30");
  const id = appt.body.appointment.id;
  await api(`/appointments/${id}/cancel`, { method: "PATCH" });

  await api("/clock", { method: "POST", body: { now: "2033-03-05T12:00:00+05:30" } });

  const fetched = await api(`/appointments/${id}`);
  assert.strictEqual(fetched.body.appointment.status, "CANCELLED");
});
