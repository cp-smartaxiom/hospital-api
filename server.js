const app = require("./src/app");
const { connectMqtt } = require("./src/config/mqtt");

const PORT = process.env.PORT || 3000;
console.log("Server will start on port:", PORT);
app.listen(PORT, (error) => {
  // Express 5 passes listen errors (e.g. port already in use) to this callback.
  if (error) throw error;
  console.log(`Server running on http://localhost:${PORT}`);
  connectMqtt();
});
