const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Firebase Admin (modular)
const serviceAccountPath = path.join(__dirname, "firebase-service-account.json");
if (!fs.existsSync(serviceAccountPath)) {
  console.error("firebase-service-account.json nahi mili!");
  process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
  });
}

const messaging = getMessaging();

const ORDERS_FILE = path.join(__dirname, "orders.json");
const TOKENS_FILE = path.join(__dirname, "admin-tokens.json");

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function readOrders() {
  return readJSON(ORDERS_FILE, []);
}
function writeOrders(orders) {
  writeJSON(ORDERS_FILE, orders);
}

function readTokens() {
  return readJSON(TOKENS_FILE, []);
}
function writeTokens(tokens) {
  writeJSON(TOKENS_FILE, tokens);
}

app.get("/", (req, res) => {
  res.send("Swaddhist Backend + FCM running");
});

app.post("/api/admin-token", (req, res) => {
  const token = (req.body && req.body.token) || "";
  if (!token) return res.status(400).json({ error: "token required" });

  let tokens = readTokens();
  if (!tokens.includes(token)) {
    tokens.push(token);
    writeTokens(tokens);
  }
  res.json({ ok: true, count: tokens.length });
});

app.post("/api/orders", async (req, res) => {
  try {
    const body = req.body || {};
    const orders = readOrders();
    const id = "ORD" + Date.now();
    const order = {
      id,
      ...body,
      status: body.status || "Pending",
      createdAt: new Date().toISOString(),
    };
    orders.unshift(order);
    writeOrders(orders);

    const tokens = readTokens();
    if (tokens.length > 0) {
      const name = (body.name || body.customerName || "Customer").toString();
      try {
        const result = await messaging.sendEachForMulticast({
          tokens,
          notification: {
            title: "New Order — Swaddhist",
            body: "#" + id + " · " + name,
          },
          data: {
            orderId: String(id),
            type: "new_order",
          },
        });
        console.log("FCM:", result.successCount, "ok,", result.failureCount, "fail");

        if (result.failureCount > 0) {
          const valid = [];
          result.responses.forEach((r, i) => {
            if (r.success) valid.push(tokens[i]);
          });
          writeTokens(valid);
        }
      } catch (fcmErr) {
        console.error("FCM error:", fcmErr.message);
      }
    }

    res.json({ ok: true, order });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/orders", (req, res) => {
  res.json(readOrders());
});

app.patch("/api/orders/:id", (req, res) => {
  const orders = readOrders();
  const i = orders.findIndex((o) => o.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "not found" });
  if (req.body && req.body.status) orders[i].status = req.body.status;
  writeOrders(orders);
  res.json({ ok: true, order: orders[i] });
});

app.listen(PORT, () => {
  console.log("Swaddhist Backend + FCM on http://localhost:" + PORT);
});