    const express = require("express");
    const cors = require("cors");
    require("dotenv").config();
    //console.log("Environment variables:", process.env);
    const userRoutes = require("./src/config/routes/user.routes");
    const deviceRoutes = require("./src/config/routes/device.routes");
    const patientRoutes = require("./src/config/routes/patient.routes");
    const doctorRoutes = require("./src/config/routes/doctor.routes");

    const app = express();

    app.use(cors());
    app.use(express.json());
    app.use("/api", userRoutes);
    app.use("/api", deviceRoutes);
    app.use("/api", patientRoutes);
    app.use("/api", doctorRoutes);

    app.get("/", (req, res) => {
    res.json({
        message: "Rajant API is running",
    });
    });

    const PORT = process.env.PORT || 3000;
    console.log("Server will start on port:", PORT);
    app.listen(PORT, (error) => {
    // Express 5 passes listen errors (e.g. port already in use) to this callback.
    if (error) throw error;
    console.log(`Server running on http://localhost:${PORT}`);
    });