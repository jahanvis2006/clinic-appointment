require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const doctorRoutes = require("./routes/doctors");
const patientRoutes = require("./routes/patients");
const appointmentRoutes = require("./routes/appointments");
const clockRoutes = require("./routes/clock");
const outboxRoutes = require("./routes/outbox");
const { errorHandler } = require("./middleware/errorHandler");

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(",") : "*",
  })
);
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ status: "ok", service: "clinicflow-api" }));

app.use("/api/auth", authRoutes);
app.use("/api/doctors", doctorRoutes);
app.use("/api/patients", patientRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/clock", clockRoutes);
app.use("/api/outbox", outboxRoutes);

app.use((req, res) => res.status(404).json({ message: "Route not found." }));
app.use(errorHandler);

// Exported (rather than only listening here) so the test suite can import
// this exact app, attach it to its own ephemeral HTTP server, and exercise
// the real routes/middleware end-to-end without spawning a separate process
// or hardcoding a port. `require.main === module` keeps `node src/index.js`
// (and `npm run dev`/`start`) behaving exactly as before.
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`ClinicFlow API listening on http://localhost:${PORT}`);
  });
}
