
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const {
  initializeApp,
  cert,
  getApps
} = require("firebase-admin/app");

const { getMessaging } = require("firebase-admin/messaging");

const app = express();

app.use(cors());
app.use(express.json());

let fcmReady = false;
let fcmError = "";
let messaging = null;

// ==================================
// FIREBASE ADMIN INITIALIZATION
// ==================================

try {
  let serviceAccount = null;

  const secretPath = "/etc/secrets/firebase-service-account.json";
  const localPath = path.join(__dirname, "firebase-service-account.json");
  const oldLocalPath = path.join(__dirname, "service-account.json");

  if (fs.existsSync(secretPath)) {
    serviceAccount = JSON.parse(
      fs.readFileSync(secretPath, "utf8")
    );
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } else if (fs.existsSync(localPath)) {
    serviceAccount = JSON.parse(
      fs.readFileSync(localPath, "utf8")
    );
  } else if (fs.existsSync(oldLocalPath)) {
    serviceAccount = JSON.parse(
      fs.readFileSync(oldLocalPath, "utf8")
    );
  } else {
    throw new Error("Firebase service account file not found");
  }

  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  }

  messaging = getMessaging();
  fcmReady = true;

  console.log("Firebase Admin Ready!");

} catch (err) {
  fcmError = err.message || String(err);
  console.error("Firebase Admin Error:", fcmError);
}

// ==================================
// FILE PATHS
// ==================================

const ORDERS_FILE = path.join(__dirname, "orders.json");
const TOKENS_FILE = path.join(__dirname, "tokens.json");

// ==================================
// JSON HELPERS
// ==================================

function readJSON(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const data = JSON.parse(
      fs.readFileSync(file, "utf8")
    );

    return data;
  } catch (err) {
    console.error("File read error:", file, err.message);
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2)
  );
}

function readOrders() {
  return readJSON(ORDERS_FILE, []);
}

function readTokens() {
  return readJSON(TOKENS_FILE, []);
}

// ==================================
// HOME / SERVER STATUS
// ==================================

app.get("/", (req, res) => {
  res.json({
    message: "Swaddhist Backend Running",
    fcmReady,
    fcmError: fcmReady ? null : fcmError
  });
});

// ==================================
// SAVE ADMIN FCM TOKEN
// ==================================

app.post("/api/token", (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Token required"
      });
    }

    let tokens = readTokens();

    tokens = tokens.filter(
      t => t && t !== "test-debug-token"
    );

    if (!tokens.includes(token)) {
      tokens.push(token);
    }

    writeJSON(TOKENS_FILE, tokens);

    res.json({
      ok: true,
      message: "Admin notification token saved",
      count: tokens.length
    });

  } catch (err) {
    console.error("Token save error:", err);

    res.status(500).json({
      ok: false,
      error: "Token save failed"
    });
  }
});

// ==================================
// TOKEN COUNT
// ==================================

app.get("/api/token-count", (req, res) => {
  const tokens = readTokens().filter(Boolean);

  res.json({
    count: tokens.length,
    fcmReady
  });
});

// ==================================
// SEND NEW ORDER NOTIFICATION
// ==================================

async function sendOrderNotification(order) {
  const fcm = {
    sent: 0,
    fail: 0,
    tokens: 0
  };

  if (!fcmReady || !messaging) {
    fcm.error = "Firebase is not ready";
    return fcm;
  }

  const tokens = readTokens().filter(
    t => t && t !== "test-debug-token"
  );

  fcm.tokens = tokens.length;

  if (!tokens.length) {
    fcm.error = "No admin device token registered";
    return fcm;
  }

  try {
    const result = await messaging.sendEachForMulticast({
      tokens,

      notification: {
        title: "New Order - Swaddhist",
        body: `${order.name || "Customer"} placed a new order. Order ID: ${order.id}`
      },

      data: {
        orderId: String(order.id),
        type: "NEW_ORDER"
      },

      webpush: {
        notification: {
          title: "New Order - Swaddhist",
          body: `${order.name || "Customer"} placed a new order`,
          icon: "https://swaddhist.vercel.app/logo.png",
          badge: "https://swaddhist.vercel.app/logo.png",
          tag: String(order.id),
          requireInteraction: true
        },

        fcmOptions: {
          link: "https://swaddhist.vercel.app/admin/orders.html"
        }
      }
    });

    fcm.sent = result.successCount;
    fcm.fail = result.failureCount;

    const validTokens = [];

    result.responses.forEach((response, index) => {
      if (response.success) {
        validTokens.push(tokens[index]);
      } else {
        const error = response.error;

        console.log(
          "FCM Error:",
          error?.code,
          error?.message
        );

        // Keep tokens unless they are permanently invalid.
        if (
          error?.code !== "messaging/registration-token-not-registered" &&
          error?.code !== "messaging/invalid-registration-token"
        ) {
          validTokens.push(tokens[index]);
        }
      }
    });

    writeJSON(TOKENS_FILE, validTokens);

  } catch (err) {
    console.error("Notification error:", err.message);
    fcm.error = err.message;
  }

  return fcm;
}

// ==================================
// NEW ORDER API
// ==================================

app.post("/api/orders", async (req, res) => {
  try {
    const order = {
      ...req.body,
      id: "ORD" + Date.now(),
      status: "Pending",
      createdAt: new Date().toISOString()
    };

    const orders = readOrders();

    orders.unshift(order);

    writeJSON(ORDERS_FILE, orders);

    console.log("New Order Received:", order.id);

    const fcm = await sendOrderNotification(order);

    res.json({
      ok: true,
      message: "Order saved successfully",
      order,
      fcm
    });

  } catch (err) {
    console.error("Order error:", err);

    res.status(500).json({
      ok: false,
      error: "Could not save order"
    });
  }
});

// ==================================
// GET ALL ORDERS
// ==================================

app.get("/api/orders", (req, res) => {
  res.json(readOrders());
});

// ==================================
// UPDATE ORDER STATUS
// ==================================

app.patch("/api/orders/:id", (req, res) => {
  try {
    const orders = readOrders();

    const index = orders.findIndex(
      order => order.id === req.params.id
    );

    if (index === -1) {
      return res.status(404).json({
        error: "Order not found"
      });
    }

    if (req.body.status) {
      orders[index].status = req.body.status;
    }

    writeJSON(ORDERS_FILE, orders);

    res.json({
      ok: true,
      order: orders[index]
    });

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Status update failed"
    });
  }
});

// ==================================
// START SERVER
// ==================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("--------------------------------");
  console.log("Swaddhist Backend Running");
  console.log("Port:", PORT);
  console.log("FCM Ready:", fcmReady);
  console.log("--------------------------------");
});
