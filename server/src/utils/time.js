// Centralized date/time helpers.
// The clinic operates in India (Asia/Kolkata, UTC+05:30).
// Timestamps are ALWAYS stored in the database as absolute UTC instants
// (Prisma DateTime -> ISO string in SQLite). We never store or compare
// raw strings for scheduling logic - only real Date/instant objects.
//
// The frontend sends a wall-clock date ("YYYY-MM-DD") and time ("HH:mm")
// that represent India local time. We convert that IST wall-clock time
// into a real UTC instant using a fixed +05:30 offset (India does not
// observe DST), so all comparisons downstream are instant-based and
// therefore correct regardless of server timezone.

const IST_OFFSET = "+05:30";

function combineDateAndTimeIST(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const iso = `${dateStr}T${timeStr}:00${IST_OFFSET}`;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

// Returns the [start, end) instant range for a given IST calendar date, where
// start is 00:00:00.000 IST on that date and end is 00:00:00.000 IST on the
// NEXT date (i.e. an exclusive upper bound). Using an exclusive next-day
// boundary (instead of e.g. "23:59") avoids silently dropping any
// appointment that starts in the last minute of the day.
function getISTDayRange(dateStr) {
  const start = combineDateAndTimeIST(dateStr, "00:00");
  if (!start) return null;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

// Fixed IST offset in milliseconds (+05:30, no DST) - mirrors the offset
// used by combineDateAndTimeIST above, kept as a single constant so the
// "shift into IST, read the calendar fields" trick below can't drift out
// of sync with the rest of this file.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Given any instant, returns the "YYYY-MM-DD" calendar date it falls on in
// Asia/Kolkata. Used by the clock/notification automation (T1/T2) to decide
// which appointments count as "today" for a given simulated `now`, without
// relying on the server's own local timezone.
function toISTDateString(date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatISTDate(date) {
  return new Date(date).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatISTTime(date) {
  return new Date(date).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

module.exports = {
  combineDateAndTimeIST,
  getISTDayRange,
  formatISTDate,
  formatISTTime,
  toISTDateString,
  IST_OFFSET_MS,
};
