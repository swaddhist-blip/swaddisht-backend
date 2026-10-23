const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// ---------- Firebase Admin (FCM) ----------
let fcmReady = false;
try {
  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    credential = admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    );
  } else if (fs.existsSync("/etc/secrets/firebase-service-account.json")) {
    const sa = JSON.parse(
      fs.readFileSync("/etc/secrets/firebase-service-account.json", "utf8")
    );
    credential = admin.credential.cert(sa);
  } else if (fs.existsSync(path.join(__dirname, "service-account.json"))) {
    credential = admin.credential.cert(require("./service-account.json"));
  } else {
    throw new Error("No Firebase credentials found");
  }

  if (!admin.apps.length) {
    admin.initializeApp({ credential });
  }
  fcmReady = true;
  console.log("Firebase Admin ready");
} catch (err) {
  console.error("Firebase Admin failed:", err.message);
  fcmReady = false;
}

// ---------- Orders ----------
const ORDERS_FILE = path.join(__dirname, "orders.json");

function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];
    return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ---------- FCM tokens ----------
const TOKENS_FILE = path.join(__dirname, "tokens.json");

function readTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

// Health
app.get("/", (req, res) => {
  res.send(
    fcmReady
      ? "Swaddhist Backend + FCM running"
      : "Swaddhist Backend running (FCM not ready)"
  );
});

// Save admin device token
app.post("/api/token", (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token required" });

  let tokens = readTokens();
  if (!tokens.includes(token)) {
    tokens.push(token);
    writeTokens(tokens);
  }
  res.json({ ok: true, count: tokens.length });
});

// Create order + notify
app.post("/api/orders", async (req, res) => {
  try {
    const order = {
      id: "ORD" + Date.now(),
      ...req.body,
      status: "Pending",
      createdAt: new Date().toISOString()
    };

    const orders = readOrders();
    orders.unshift(order);
    writeOrders(orders);

    if (fcmReady) {
      const tokens = readTokens();
      if (tokens.length > 0) {
        try {
          const result = await admin.messaging().sendEachForMulticast({
            notification: {
              title: "New Order — Swaddhist",
              body: (order.name || "Customer") + " · " + order.id
            },
            data: { orderId: String(order.id) },
            tokens: tokens
          });
          console.log(
            "FCM:",
            result.successCount,
            "ok,",
            result.failureCount,
            "fail"
          );
        } catch (e) {
          console.error("FCM send error:", e.message);
        }
      }
    }

    res.json({ ok: true, order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save order" });
  }
});

// All orders
app.get("/api/orders", (req, res) => {
  res.json(readOrders());
});

// Update status
app.patch("/api/orders/:id", (req, res) => {
  const orders = readOrders();
  const i = orders.findIndex((o) => o.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "not found" });

  if (req.body.status) orders[i].status = req.body.status;
  writeOrders(orders);
  res.json({ ok: true, order: orders[i] });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Server on port", PORT);
});