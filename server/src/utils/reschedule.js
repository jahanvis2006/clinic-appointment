// Reschedule eligibility policy (T6):
//  - Only SCHEDULED appointments may be rescheduled.
//  - CANCELLED, COMPLETED and NO_SHOW appointments are all rejected, each
//    with a distinct, explicit reason so the route/UI can show a clear
//    message instead of a generic "not allowed".
//
// This is intentionally a pure function (no Date/DB access) so it can be
// unit-tested directly, the same way canCancel() is tested in
// cancellation.test.js.
function canReschedule(appointment) {
  if (!appointment) {
    return { allowed: false, reason: "NOT_FOUND", message: "Appointment not found." };
  }
  if (appointment.status === "CANCELLED") {
    return { allowed: false, reason: "CANCELLED", message: "Cancelled appointments cannot be rescheduled." };
  }
  if (appointment.status === "COMPLETED") {
    return { allowed: false, reason: "COMPLETED", message: "Completed appointments cannot be rescheduled." };
  }
  if (appointment.status === "NO_SHOW") {
    return { allowed: false, reason: "NO_SHOW", message: "No-show appointments cannot be rescheduled." };
  }
  if (appointment.status !== "SCHEDULED") {
    return { allowed: false, reason: "INVALID_STATUS", message: "Only scheduled appointments can be rescheduled." };
  }
  return { allowed: true };
}

module.exports = { canReschedule };
