const mqtt = require("mqtt");
require("dotenv").config();

const { handleMqttMessage } = require("./controller/event.controller");

const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
// One wildcard covers vitals, spo2, skin_temperature, activity, environment and alert for every device.
const MQTT_TOPIC = process.env.MQTT_TOPIC || "sa/qstat/+/monitoring/#";

const connectMqtt = () => {
  const client = mqtt.connect(MQTT_URL, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    console.log(`MQTT connected to ${MQTT_URL}`);

    client.subscribe(MQTT_TOPIC, (error) => {
      if (error) {
        console.error("MQTT subscribe error:", error);
        return;
      }
      console.log(`MQTT subscribed to ${MQTT_TOPIC}`);
    });
  });

  client.on("message", handleMqttMessage);

  client.on("reconnect", () => console.log("MQTT reconnecting..."));
  client.on("error", (error) => console.error("MQTT error:", error.message));

  return client;
};

module.exports = { connectMqtt };
