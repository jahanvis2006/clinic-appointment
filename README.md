# ClinicFlow

**Conflict-free clinic appointment scheduling.**

## Overview

ClinicFlow is a front-desk appointment management system for a small clinic with a
handful of doctors. It solves the exact problem described in the brief: front-desk
staff were accidentally double-booking doctors, letting two patients grab the same
slot, and manually (and inconsistently) applying a cancellation fee. ClinicFlow
enforces scheduling correctness on the **backend** — never the frontend — so a
doctor cannot be double-booked through the API, and cancellation fees are always
calculated the same way, on the server, based on how much notice the patient gave.

## Features

- Receptionist registration and login (JWT-based)
- Doctor management (add / list doctors)
- Patient management (add / list / search patients)
- Appointment booking with **server-enforced** doctor-overlap prevention
- **Reschedule an existing appointment** to a new date/time, with the same
  server-enforced overlap check used at booking time
- **Automatic no-show detection** — a scheduled appointment nobody showed up
  for is automatically marked `NO_SHOW` once the clinic clock passes 30
  minutes after its start time
- **Morning reminder notifications** for every appointment scheduled that
  day, recorded in an inspectable Outbox (no real SMS/email provider)
- A simulated **clinic clock** (`POST /api/clock`) so the reminder and
  no-show automation can be driven deterministically, without waiting on
  the real system clock
- Doctor daily schedule (chronological view of one doctor's day)
- Patient-name search across appointments (case-insensitive, server-side)
- Filtering by doctor, date and status
- Sorting by appointment time, patient name, or newest
- Pagination
- Automatic, backend-calculated cancellation fees (free vs. ₹200 late fee)
- One-page marketing landing page
- Dashboard with live summary counts pulled from the real database

## Tech Stack

**Frontend:** React 18, Vite, React Router, Tailwind CSS
**Backend:** Node.js, Express.js
**Database:** SQLite
**ORM:** Prisma
**Auth:** JWT + bcryptjs password hashing

## Architecture

```text
Frontend (React/Vite) → REST API (Express) → Prisma ORM → SQLite database
```

The client (`/client`) is a standalone Vite SPA that talks only to the REST API
over `fetch`. The server (`/server`) is a standalone Express app; all business
rules (overlap prevention, cancellation fee calculation) live there, never in the
frontend. The frontend may show helpful hints, but the server response is always
the source of truth.

## Database Schema

- **User** — receptionist accounts (`id`, `name`, `email` [unique], `passwordHash`, `createdAt`)
- **Doctor** — `id`, `name`, `specialization`, `createdAt`
- **Patient** — `id`, `name`, `phone`, `email`, `createdAt`
- **Appointment** — `id`, `doctorId` (FK), `patientId` (FK), `startTime`, `endTime`,
  `status` (`SCHEDULED` | `CANCELLED` | `COMPLETED` | `NO_SHOW`), `cancellationFee`, `createdAt`, `updatedAt`
- **Outbox** — `id`, `type`, `appointmentId`, `patientId`, `doctorId`, `payload`
  (JSON string), `createdAt`, `idempotencyKey` (unique) — every notification the
  Notification Service has generated (see "Clinic clock, no-show automation
  (T2) and morning reminders (T1)" below)

`status` is a plain `String`, not a Prisma enum, because this project uses
SQLite, which Prisma doesn't support native enums for. The four valid values
are enforced in application code, not the database schema.

Indexes: `Appointment(doctorId, startTime)` for fast overlap/schedule lookups,
`Appointment(patientId)`, `Appointment(status)`, and `name` indexes on `Doctor`
and `Patient` for search. Passwords are never stored in plaintext — only a
bcrypt hash.

## Business Rules

### 1. No overlapping appointments for the same doctor

Enforced in `POST /api/appointments` on the server, against active
(non-cancelled) appointments only. The exact predicate lives in one place,
`server/src/utils/overlap.js`, and is imported by both the route and the
test suite so the tests always exercise the real rule:

```text
newStart < existingEnd
AND
newEnd > existingStart
```

If any active appointment for that doctor satisfies this condition, the new
booking is rejected with `409 Conflict`. Appointments that merely touch at a
boundary (one ends exactly when the other starts) are **allowed**. Cancelled
appointments never block a new booking. The conflict check and the insert
happen inside a single Prisma transaction, so two near-simultaneous booking
requests for the same doctor can't both pass the check before either one
writes (SQLite itself has no exclusion/overlap constraint to fall back on,
so this transaction is the actual safeguard).

### 2. Cancellation policy

The brief didn't specify an exact threshold, so ClinicFlow defines and documents
one clearly:

- **More than 2 hours** before the appointment start → **₹0** (free)
- **2 hours or less** before the appointment start → **₹200** (late fee)
- **Exactly 2 hours remaining** counts as **late** (₹200)
- If the appointment's start time has **already passed**, it cannot be
  cancelled through the normal cancel action (the API returns `400`)

This is implemented once, server-side, in `server/src/utils/cancellation.js`,
and used by the `PATCH /api/appointments/:id/cancel` route — the frontend only
displays whatever the server decides.

### 3. Rescheduling (T6)

`PATCH /api/appointments/:id/reschedule` moves an existing appointment to a
new `date`/`startTime`/`endTime`. The **patient and doctor never change** —
the endpoint doesn't even accept `doctorId`/`patientId` in the body, so
there's no way to smuggle a change through it. Before saving, the server
re-runs the **exact same overlap predicate used at booking time**
(`server/src/utils/overlap.js`), against the same doctor's other active
appointments, with one addition: the appointment being rescheduled is
excluded from its own conflict check (`id: { not: id }`), otherwise every
reschedule would "conflict" with itself. As with booking:

- Cancelled appointments never block a new slot.
- Boundary-touching times (one ends exactly when another starts) are allowed.
- A true overlap is rejected with `409 Conflict`.
- The conflict check and the update happen inside one Prisma transaction,
  same as booking, to close the same concurrent-request race window.

Only `SCHEDULED` appointments can be rescheduled — `CANCELLED`, `COMPLETED`
and `NO_SHOW` are all rejected with `400` and a specific reason
(`server/src/utils/reschedule.js`, `canReschedule()`), mirroring how
`canCancel()` centralizes the cancellation rules above. All of this
validation happens **server-side**; the frontend's Reschedule form is a
convenience, not the source of truth.

### 4. Clinic clock, no-show automation (T2) and morning reminders (T1)

Both of these are driven by one endpoint, `POST /api/clock`, which lets
tests (and the evaluator) simulate "what time is it right now?" instead of
depending on the real system clock. See [Clock & Outbox API](#clock--outbox-api-t1--t2)
below for the full request/response shape. Every call to `POST /api/clock`:

1. **Flips overdue appointments to `NO_SHOW`.** An appointment becomes
   `NO_SHOW` exactly when the simulated clock is **at least 30 minutes**
   past its `startTime` and it is still `SCHEDULED` (`server/src/utils/noshow.js`
   + `server/src/services/noShowService.js`). `COMPLETED` and `CANCELLED`
   appointments are never touched, no matter how much simulated time passes.
   This is a single `updateMany` guarded by `status: "SCHEDULED"`, so it's
   naturally idempotent — calling `/clock` again re-matches nothing that's
   already been flipped.
2. **Generates today's reminders.** For every appointment still `SCHEDULED`
   on the simulated `now`'s IST calendar day, the Notification Service
   (`server/src/services/notificationService.js`) records an
   `APPOINTMENT_REMINDER` notification in the `Outbox` table — no real
   SMS/email provider, per the brief. Cancelled, completed and no-show
   appointments are excluded by construction (the query only selects
   `status: "SCHEDULED"`). Duplicate-safe: each reminder's `idempotencyKey`
   is `APPOINTMENT_REMINDER:<appointmentId>:<YYYY-MM-DD>`, which is a
   `@unique` column on `Outbox`, so calling `/clock` twice for the same
   morning inserts the first time and silently no-ops the second.

The simulated time itself lives in a small in-memory module
(`server/src/state/clock.js`) rather than the database — it's a
test/simulation control, not clinic data. `PATCH /api/appointments/:id/cancel`
also reads the current simulated time (falling back to the real clock if
`/clock` was never called), so cancellation behaves consistently with the
rest of the clock-driven automation during testing.

## API Endpoints

All endpoints return JSON. Protected endpoints require an `Authorization: Bearer <token>`
header (obtained from register/login).

### Auth

```text
POST /api/auth/register      Register a new receptionist account.        Public
POST /api/auth/login         Authenticate and receive a JWT.             Public
GET  /api/auth/me            Get the current authenticated user.         Protected
```

### Doctors

```text
GET  /api/doctors                  List doctors (optional ?search=name)  Protected
POST /api/doctors                  Create a doctor                       Protected
GET  /api/doctors/:id              Get one doctor                        Protected
GET  /api/doctors/:id/schedule     Doctor's appointments for a date       Protected
                                    ?date=YYYY-MM-DD (required)
```

### Patients

```text
GET  /api/patients            List patients (optional ?search=name)      Protected
POST /api/patients            Create a patient                          Protected
GET  /api/patients/:id        Get one patient                           Protected
```

### Appointments

```text
GET   /api/appointments                 List appointments                Protected
                                         ?search=name        (patient name, case-insensitive)
                                         &doctorId=1
                                         &date=YYYY-MM-DD
                                         &status=SCHEDULED|CANCELLED|COMPLETED|NO_SHOW
                                         &sort=startTime|patientName|createdAt
                                         &order=asc|desc
                                         &page=1&limit=10
POST  /api/appointments                 Book a new appointment            Protected
                                         body: { doctorId, patientId, date, startTime, endTime }
                                         409 if it overlaps an existing appointment
                                         for the same doctor
GET   /api/appointments/:id             Get one appointment               Protected
PATCH /api/appointments/:id/cancel      Cancel an appointment and         Protected
                                         compute the cancellation fee
PATCH /api/appointments/:id/reschedule  Move a SCHEDULED appointment to a  Protected
                                         new date/time (same patient, same
                                         doctor). body: { date, startTime, endTime }
                                         409 if the new time overlaps another
                                         appointment for the same doctor;
                                         400 if the appointment isn't SCHEDULED
```

### Clock & Outbox API (T1 / T2)

```text
GET  /api/clock     Read the current simulated (or real) clinic time.     Protected
                     -> { "now": "2026-09-17T02:30:00.000Z" }

POST /api/clock      Advance the simulated clinic clock and run the       Protected
                     clock-driven automation (no-show sweep, then
                     morning-reminder sweep).
                     body:   { "now": "2026-09-17T08:00:00+05:30" }
                     -> {
                          "message": "Clock advanced.",
                          "now": "2026-09-17T02:30:00.000Z",
                          "noShowsMarked": 2,
                          "remindersGenerated": 3,
                          "reminders": [ { "id": 1, "type": "APPOINTMENT_REMINDER",
                                            "appointmentId": 10, "patientId": 4,
                                            "doctorId": 1, "payload": { "message": "..." },
                                            "createdAt": "...", "idempotencyKey": "..." } ]
                        }
                     400 if "now" is missing or not a valid ISO-8601 datetime.
                     Calling this again with the same (or an earlier) morning
                     is safe: no duplicate reminders, and appointments already
                     flipped to NO_SHOW simply aren't matched again.

GET  /api/outbox     Inspect every notification generated so far.         Protected
                     Optional filters: ?type=APPOINTMENT_REMINDER
                                       &appointmentId=10
                                       &patientId=4
                     -> { "outbox": [ { "id": 1, "type": "APPOINTMENT_REMINDER",
                                         "appointmentId": 10, "patientId": 4,
                                         "doctorId": 1,
                                         "payload": { "patientName": "...", "doctorName": "...",
                                                       "date": "2026-09-17", "message": "..." },
                                         "createdAt": "...", "idempotencyKey": "..." } ] }
```

### Status codes used throughout

`200` success · `201` created · `400` invalid input · `401` auth error ·
`404` not found · `409` appointment conflict · `500` unexpected server error

## Search

Patient-name search is server-side and case-insensitive (`?search=rahul` matches
"Rahul Sharma"). It's surfaced prominently at the top of the Appointments page,
directly answering the brief's requirement to "find a patient's appointment by
name." Doctor and patient lists also support the same `?search=` pattern.

## Pagination

`GET /api/appointments` accepts `page` (default `1`) and `limit` (default `10`,
capped at `100`). The response includes a `pagination` object:
`{ page, limit, total, totalPages }`, which the Appointments page uses to render
a "Showing X–Y of Z" summary and page controls.

## Sorting

Supported `sort` values: `startTime` (default), `patientName`, `createdAt`.
Combine with `order=asc|desc`. The Appointments page exposes these as a single
dropdown (e.g. "Appointment Time (earliest first)").

## Authentication

Registration hashes the password with bcrypt (`bcryptjs`, 10 salt rounds) and
never stores or returns the plaintext password or the hash. Login verifies the
hash and issues a signed JWT (`JWT_SECRET`, default expiry `7d`, both
configurable via environment variables). All clinic-management endpoints
(doctors, patients, appointments) require a valid `Authorization: Bearer <token>`
header; missing or invalid tokens return `401`.

## Setup

Requires Node.js 18+. Works in GitHub Codespaces out of the box.

```bash
# From the project root
npm install          # installs the root dev tooling (concurrently)
npm run install:all  # installs server + client dependencies
npm run setup        # generates the Prisma client, creates/syncs the SQLite
                      # schema (via `prisma db push`), and seeds demo data
npm run dev           # runs the API and the Vite dev server together
```

`npm run setup` is equivalent to running, in order: `npm run install:all`,
`npm run db:push` (creates `server/prisma/dev.db` and its tables directly
from `schema.prisma`), and `npm run seed`. This project intentionally uses
`prisma db push` for the automated setup path instead of checked-in
migration files, so a fresh clone always gets a correctly-shaped database
with zero manual steps. If you'd rather have a versioned migration history
(e.g. to practice a production-style workflow), you can run
`npm run prisma:migrate --prefix server` once instead of `npm run db:push` —
both produce the same schema.

Environment variables are provided with working defaults in
`server/.env.example` and `client/.env.example`; copy them if you want to
customize anything:

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

`npm run dev` (root) starts the API on **http://localhost:4000** and the
Vite dev server on **http://localhost:5173** together, using `concurrently`
so both processes' logs are labeled and a single Ctrl+C stops both — the
more common `a & b` shell trick used by some Node projects only backgrounds
the first process and doesn't reliably clean it up when you stop the second,
and behaves inconsistently across shells. If you prefer two terminals, the
per-app scripts still work: `npm run dev:server` and `npm run dev:client`.

Demo login (created by the seed script): **reception@clinicflow.test** / **password123**

> If running in GitHub Codespaces, make sure the forwarded port for the client
> is set to "Public" if you need to access it outside the Codespace, and update
> `client/.env` (`VITE_API_URL`) and `server/.env` (`CLIENT_ORIGIN`) to match the
> forwarded URLs if you don't use the default localhost ports.

## Environment Variables

**server/.env**

| Variable | Purpose |
|---|---|
| `PORT` | Port the Express API listens on (default `4000`) |
| `DATABASE_URL` | SQLite connection string used by Prisma (`file:./dev.db`) |
| `JWT_SECRET` | Secret used to sign/verify JWTs — change in production |
| `JWT_EXPIRES_IN` | JWT expiry, e.g. `7d` |
| `CLIENT_ORIGIN` | Allowed CORS origin(s) for the frontend |

**client/.env**

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Base URL of the backend REST API |

## Date/Time Handling

The clinic operates in India. All appointment timestamps are stored in the
database as real UTC instants (Prisma `DateTime`). The frontend sends a wall-clock
`date` (`YYYY-MM-DD`) and `time` (`HH:mm`) that represent India local time; the
server combines them with a fixed `+05:30` offset (`server/src/utils/time.js`)
into a genuine `Date` instant before storing or comparing anything. Because all
comparisons (overlap checks, cancellation-window checks) operate on real instants
rather than strings, they are correct regardless of the server's own timezone.
Display formatting on the frontend explicitly uses the `Asia/Kolkata` timezone.

"Search by date" (`GET /api/appointments?date=...` and the doctor schedule
endpoint) uses `getISTDayRange()`, which resolves a calendar date to
`[00:00:00.000 IST that day, 00:00:00.000 IST the next day)` — an exclusive
upper bound — rather than assuming the day ends at `23:59`. That distinction
matters: a naive `"23:59"` cutoff silently drops any appointment starting in
the last minute of the day (e.g. 23:59:30); the exclusive next-day boundary
doesn't have that gap.

The clock/no-show/reminder automation (T1/T2) reuses this same machinery: a
new `toISTDateString()` helper turns any instant (the simulated `now`) into
the `"YYYY-MM-DD"` it falls on in `Asia/Kolkata`, which is then fed straight
back into `getISTDayRange()` to find "today's" appointments — so "what day is
it, for reminder purposes" is answered with the exact same IST math as
everything else in the app, not a second, separately-drifting implementation.

## Testing

### Automated tests

```bash
npm test              # from the project root, runs the server's test suite
# or
cd server && npm test
```

Uses Node's built-in test runner (`node --test`) — no extra test framework
dependency. There are two kinds of test file:

**Pure-function unit tests** (no database, no HTTP — instant, no setup required
beyond `npm install`), covering the exact functions the routes call, not
copies of the logic:

- `tests/overlap.test.js` — the overlap predicate (`src/utils/overlap.js`,
  used by both booking and rescheduling): touching boundaries allowed, true
  overlaps rejected, plus the exact scenarios from the assignment brief (A,
  C, F, G, H).
- `tests/cancellation.test.js` — cancellation fee calculation and the full
  `canCancel()` decision (`src/utils/cancellation.js`).
- `tests/reschedule.test.js` — the T6 `canReschedule()` eligibility rule:
  `SCHEDULED` allowed, `CANCELLED`/`COMPLETED`/`NO_SHOW` each rejected with a
  distinct reason.
- `tests/noshow.test.js` — the T2 30-minute boundary rule (`src/utils/noshow.js`):
  29 minutes after start (not due), exactly 30 (due), and past 30 (due).

**Integration tests** (`tests/twists.integration.test.js`) — these spin up
the real Express app (`src/index.js`, exported as a module rather than only
listening) on an ephemeral port and drive it with real HTTP requests against
the real SQLite database, so they need the database set up first
(`npm run db:push`, which `npm run setup` already does). They cover, end to
end, everything a pure function can't:

- **T6** — a successful reschedule; rescheduling into an overlapping slot
  (`409`); a boundary-touching reschedule (success); the patient/doctor
  staying the same even if different ids are sent; a cancelled appointment's
  old slot not blocking a reschedule into it; cancelled/completed
  appointments being rejected.
- **T1** — a reminder is generated for a today-scheduled appointment; calling
  `/clock` twice for the same morning does not duplicate it; cancelled and
  completed appointments never get a reminder.
- **T2** — 29 minutes after start (still `SCHEDULED`), exactly 30 minutes
  (`NO_SHOW`), more than 30 minutes (`NO_SHOW`), a completed appointment
  staying `COMPLETED`, and a cancelled appointment staying `CANCELLED`,
  regardless of how much simulated time passes.

All of these tests use dates far in the future (2031-2033) so they can never
collide with the seed data's "today"/"tomorrow" appointments, and everything
in `twists.integration.test.js` runs as one file (Node's test runner executes
separate files in parallel, but tests within a single file run in the order
they're declared) since SQLite only supports one writer at a time.

Scenarios B and D from the original booking brief (same-doctor back-to-back
booking succeeding, and two different doctors booked for the identical slot)
depend on status filtering and doctor-id scoping that live in the route/
database layer rather than in a pure function, so they're exercised via the
manual API test plan below instead of a unit test. Scenario E (a cancelled
appointment's old slot being re-bookable) now has both a manual scenario
below **and** an automated equivalent for rescheduling (T6, above).

### Manual test scenarios

Run these with `npm run dev` up and a token from `/api/auth/login` (or just
click through the UI — every one of these has a corresponding screen).

1. **Book a valid appointment** — Appointments → Book Appointment → fill form → succeeds.
2. **Overlapping appointment, same doctor (A/C)** — book a second appointment for the
   same doctor with a time range that overlaps an existing one → rejected with
   a `409` and a friendly "Dr. X is already booked..." message.
3. **Back-to-back, same doctor (B)** — book 10:30–11:00 right after an existing
   10:00–10:30 for the same doctor → succeeds (boundaries touch, no overlap).
4. **Same time, different doctor (D)** — book the same time slot for a different
   doctor → succeeds.
5. **Re-book a cancelled slot (E)** — cancel an appointment, then book a new
   appointment for the same doctor in the exact same slot → succeeds, because
   cancelled appointments never block a slot.
6. **Cancel > 2 hours before** — cancel an appointment more than two hours out
   → fee shown as ₹0.
7. **Cancel within 2 hours** — cancel an appointment starting soon → fee shown
   as ₹200.
8. **Cancel an already-cancelled or already-started appointment** — both are
   rejected by the server with a `400` and a clear message.
9. **Search** — type a patient's first name into the Appointments search box →
   only their appointments appear, case-insensitively.
10. **Pagination** — with more than 10 appointments, page through results and
    confirm the "Showing X–Y of Z" counts and rows change.
11. **Sorting** — switch the sort dropdown between appointment time, patient
    name, and newest, and confirm row order changes accordingly.

### How to test the twists manually

12. **Reschedule (T6)** — book an appointment, click **Reschedule** on it,
    pick a new date/time that's free for that doctor → succeeds and the row
    updates in place, still showing the same patient and doctor.
13. **Reschedule into a conflict (T6)** — with two appointments booked for
    the same doctor, try to reschedule one on top of the other's time range
    → rejected with a `409` and a clear message; the appointment keeps its
    original time.
14. **Clock + reminders (T1)** — get a token, then:
    ```bash
    curl -X POST http://localhost:4000/api/clock \
      -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
      -d '{"now": "2026-09-17T08:00:00+05:30"}'
    curl http://localhost:4000/api/outbox -H "Authorization: Bearer <token>"
    ```
    The first call's response includes `remindersGenerated` for every
    appointment scheduled that day; the outbox lists one `APPOINTMENT_REMINDER`
    per such appointment. Repeat the same `POST /api/clock` call → `remindersGenerated`
    for the already-covered appointments stays at zero the second time, and
    `GET /api/outbox` shows no duplicates.
15. **No-show automation (T2)** — book an appointment for, say, `09:00`
    today, then call `POST /api/clock` with `"now"` set to `09:30` or later
    the same day → `GET /api/appointments/:id` (or the Appointments table)
    shows `NO_SHOW`. Calling `/clock` with a time only 10-20 minutes past
    start leaves it `SCHEDULED`; cancelled or completed appointments are
    never affected no matter how far the clock is advanced.

## Notes on Seed Data

The seed script (`server/prisma/seed.js`) creates one demo user, 3 doctors,
10 patients, and appointments spread across today and tomorrow — including one
cancelled and one completed appointment — deliberately built with **no
overlapping times for the same doctor**, so the app demonstrates cleanly out of
the box.

## Three Features That Could Be Built Next

1. A real SMS/email provider behind the Notification Service abstraction
   (today it only records notifications to the Outbox)
2. Patient self-service online booking
3. Doctor availability / working-hours management
