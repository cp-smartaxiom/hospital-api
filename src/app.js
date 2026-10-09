const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
require("dotenv").config();
const authRoutes = require("./config/routes/auth.routes");
const userRoutes = require("./config/routes/user.routes");
const deviceRoutes = require("./config/routes/device.routes");
const patientRoutes = require("./config/routes/patient.routes");
const doctorRoutes = require("./config/routes/doctor.routes");
const eventRoutes = require("./config/routes/event.routes");

// Express app without listen()/MQTT, so tests can load it (see server.js for startup).
const app = express();

app.use(cors());
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use("/api", authRoutes);
app.use("/api", userRoutes);
app.use("/api", deviceRoutes);
app.use("/api", patientRoutes);
app.use("/api", doctorRoutes);
app.use("/api", eventRoutes);

app.get("/", (req, res) => {
  res.json({
    message: "Rajant API is running",
  });
});

module.exports = app;
