const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

const app = express();
app.use(cors());
app.use(express.json());

let fcmReady = false;
let fcmError = "";
let messaging = null;

try {
  let serviceAccount = null;
  if (fs.existsSync("/etc/secrets/firebase-service-account.json")) {
    serviceAccount = JSON.parse(
      fs.readFileSync("/etc/secrets/firebase-service-account.json", "utf8")
    );
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (fs.existsSync(path.join(__dirname, "service-account.json"))) {
    serviceAccount = require("./service-account.json");
  } else {
    throw new Error("No Firebase credentials");
  }

  if (!getApps().length) {
    initializeApp({ credential: cert(serviceAccount) });
  }
  messaging = getMessaging();
  fcmReady = true;
  console.log("Firebase Admin ready");
} catch (err) {
  fcmError = err.message || String(err);
  console.error("Firebase Admin failed:", fcmError);
}

const ORDERS_FILE = path.join(__dirname, "orders.json");
const TOKENS_FILE = path.join(__dirname, "tokens.json");

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

app.get("/", (req, res) => {
  res.send(
    fcmReady
      ? "Swaddhist Backend + FCM running"
      : "Swaddhist Backend running (FCM not ready): " + fcmError
  );
});

app.post("/api/token", (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: "token required" });
  let tokens = readTokens().filter((t) => t && t !== "test-debug-token");
  if (!tokens.includes(token)) tokens.push(token);
  writeTokens(tokens);
  res.json({ ok: true, count: tokens.length });
});

app.get("/api/token-count", (req, res) => {
  res.json({ count: readTokens().filter((t) => t !== "test-debug-token").length, fcmReady });
});

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

    let fcm = { sent: 0, fail: 0, tokens: 0 };

    if (fcmReady && messaging) {
      let tokens = readTokens().filter((t) => t && t !== "test-debug-token");
      fcm.tokens = tokens.length;

      if (tokens.length > 0) {
        try {
          const result = await messaging.sendEachForMulticast({
            notification: {
              title: "New Order — Swaddhist",
              body: (order.name || "Customer") + " · " + order.id,
              icon: "https://swaddhist.vercel.app/logo.png"
            },
            webpush: {
              notification: {
                icon: "https://swaddhist.vercel.app/logo.png",
                badge: "https://swaddhist.vercel.app/logo.png"
              },
              fcmOptions: {
                link: "https://swaddhist.vercel.app/admin/orders.html"
              }
            },
            data: { orderId: String(order.id) },
            tokens
          });

          fcm.sent = result.successCount;
          fcm.fail = result.failureCount;

          // invalid tokens hatao
          const keep = [];
          result.responses.forEach((r, i) => {
            if (r.success) keep.push(tokens[i]);
            else console.log("FCM fail:", r.error && r.error.code, r.error && r.error.message);
          });
          writeTokens(keep);
        } catch (e) {
          console.error("FCM error:", e.message);
          fcm.error = e.message;
        }
      }
    }

    res.json({ ok: true, order, fcm });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save order" });
  }
});

app.get("/api/orders", (req, res) => {
  res.json(readOrders());
});

app.patch("/api/orders/:id", (req, res) => {
  const orders = readOrders();
  const i = orders.findIndex((o) => o.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "not found" });
  if (req.body.status) orders[i].status = req.body.status;
  writeOrders(orders);
  res.json({ ok: true, order: orders[i] });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Server on port", PORT));