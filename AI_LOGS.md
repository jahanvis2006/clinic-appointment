# AI Usage Log

This project was built with Claude (Anthropic) as the AI coding assistant, as permitted
by the Builder Round rules. This log summarizes how AI was used.

## Tool

Claude (Anthropic), used interactively to generate the full project (backend, frontend,
schema, seed data, tests, README) from the assignment brief.

## Process

1. **Requirements intake** — Provided Claude the full assignment brief (storyline,
   mandatory requirements, tech stack preferences, business rules for double-booking
   prevention and the cancellation policy).
2. **Schema & backend generation** — Claude generated the Prisma schema (User, Doctor,
   Patient, Appointment), the Express REST API (auth, doctors, patients, appointments),
   the overlap-prevention logic (`newStart < existingEnd AND newEnd > existingStart`
   checked server-side against non-cancelled appointments only), and the cancellation-fee
   logic (free if >2h notice, ₹200 otherwise, blocked if the appointment already started).
3. **Frontend generation** — Claude generated the React/Vite/Tailwind client: landing
   page, register/login, dashboard, appointments (search/filter/sort/paginate/book/cancel),
   doctors, patients, and doctor daily schedule pages, all calling the real REST API.
4. **Seed data** — Claude generated seed data (3 doctors, 10 patients, appointments across
   two days) deliberately constructed with no overlapping slots per doctor.
5. **Automated tests** — Claude generated Node's built-in test-runner unit tests for the
   overlap predicate and the cancellation-fee calculation (`server/tests/`), and these were
   run and confirmed passing (8/8) as part of this process.
6. **Verification performed in this environment**:
   - `node --check` on every backend source file (all passed).
   - `node --test tests/*.test.js` — 8/8 unit tests passing, covering: rejected overlaps,
     allowed boundary-touching appointments, free vs. ₹200 vs. already-started cancellations.
   - `npm install` + `vite build` on the client — built successfully with no errors.
   - Prisma client generation / migration could **not** be executed in this sandboxed
     environment because it requires downloading a query-engine binary from
     `binaries.prisma.sh`, a domain not reachable from this sandbox's network egress list.
     This is an environment limitation, not a code issue — running `npx prisma migrate dev`
     in a normal Codespaces/local environment (as documented in the README Setup section)
     will fetch the engine and apply the migration normally.
7. **Manual review** — The generated business-rule logic (overlap check, cancellation
   window, HTTP status codes) was checked line-by-line against the brief's explicit
   examples (e.g. 10:00-10:30 vs 10:20-10:50 → reject; 10:00-10:30 vs 10:30-11:00 → allow;
   exactly-2-hours-remaining → ₹200) before being accepted.

## What was NOT auto-accepted without review

- The exact cancellation threshold (>2h free / ≤2h ₹200) was specified by the brief itself,
  not invented by the AI; it is documented explicitly in the README.
- All REST endpoint paths, status codes, and the overlap/cancellation semantics were
  cross-checked against the brief's worked examples before finalizing.
- Timezone handling (IST, fixed +05:30 offset, instant-based comparisons) was reviewed to
  ensure overlap and cancellation comparisons operate on real Date instants rather than
  strings, per the brief's explicit warning about timezone bugs.

## Human-authored decisions

- Choice to keep the UI to a clean timeline (not a calendar library) for the doctor
  schedule page, per the brief's suggestion.
- Choice of ₹ as currency and IST as the operating timezone, per the brief's India context.
- Project structure (`client/` + `server/` + root scripts) follows the structure suggested
  in the brief.

