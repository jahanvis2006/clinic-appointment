# ClinicFlow — Solution Reasoning

## 1. Understanding the Problem

The main problem is a clinic front desk accidentally double-booking doctors and inconsistently handling appointment cancellations.

The most important business rule is that two active appointments for the same doctor must never overlap.

The solution was therefore designed around three priorities:

1. Prevent overlapping appointments on the backend.
2. Apply the cancellation rule consistently on the backend.
3. Make appointment lookup and daily scheduling easy for the receptionist.

The additional twists were then implemented without weakening these core rules:

- T6 — rescheduling
- T1 — morning appointment reminders
- T2 — automatic no-show detection

---

## 2. Technology Choice

The application uses:

- React for the frontend
- Vite for frontend development
- Tailwind CSS for styling
- Node.js and Express for the REST API
- Prisma as the ORM
- SQLite as the database
- JWT for authentication
- bcryptjs for password hashing

SQLite was selected because the application is intended to be easy to run locally and in GitHub Codespaces without requiring a separate database server.

---

## 3. Architecture

The application follows a simple full-stack architecture:

```text
React/Vite frontend
        |
        | REST API
        v
Express backend
        |
        | Prisma
        v
SQLite database
