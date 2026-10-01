const express = require("express");
const router = express.Router();

const { createUser } = require("../controller/user.controller");

router.post("/users", createUser);

console.log("User routes have been set up.");

module.exports = router;