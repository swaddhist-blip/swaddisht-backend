
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

const PORT = process.env.PORT || 5000;
const EXPECTED_PROJECT_ID = "swaddhist-3f3db";

let fcmReady = false;
let fcmError = "";
let messaging = null;

// ==================================
// FILE PATHS
// ==================================

const ORDERS_FILE = path.join(__dirname, "orders.json");
const TOKENS_FILE = path.join(__dirname, "tokens.json");

const SECRET_PATH = "/etc/secrets/firebase-service-account.json";
const LOCAL_SECRET_PATH = path.join(
  __dirname,
  "firebase-service-account.json"
);

// ==================================
// JSON HELPERS
// ==================================

function readJSON(file, fallback = []) {
  try {
    if (!fs.existsSync(file)) return fallback;

    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error("JSON Read Error:", error.message);
    return fallback;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readOrders() {
  return readJSON(ORDERS_FILE, []);
}

function readTokens() {
  const data = readJSON(TOKENS_FILE, []);
  return Array.isArray(data) ? data : [];
}

// ==================================
// FIREBASE ADMIN INITIALIZATION
// ==================================

try {
  let serviceAccount;

  if (fs.existsSync(SECRET_PATH)) {
    serviceAccount = JSON.parse(
      fs.readFileSync(SECRET_PATH, "utf8")
    );
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT
    );
  } else if (fs.existsSync(LOCAL_SECRET_PATH)) {
    serviceAccount = JSON.parse(
      fs.readFileSync(LOCAL_SECRET_PATH, "utf8")
    );
  } else {
    throw new Error("Firebase service account file not found");
  }

  if (serviceAccount.project_id !== EXPECTED_PROJECT_ID) {
    throw new Error(
      "Wrong Firebase Project ID: " + serviceAccount.project_id
    );
  }

  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount)
    });
  }

  messaging = getMessaging();
  fcmReady = true;

  console.log("Firebase Admin Ready!");
  console.log("Firebase Project:", EXPECTED_PROJECT_ID);

} catch (error) {
  fcmError = error.message;
  console.error("Firebase Admin Error:", fcmError);
}

// ==================================
// HOME / SERVER STATUS
// ==================================

app.get("/", (req, res) => {
  res.json({
    message: "Swaddhist Backend Running",
    projectId: EXPECTED_PROJECT_ID,
    fcmReady,
    fcmError: fcmReady ? null : fcmError
  });
});

// ==================================
// REGISTER ADMIN DEVICE TOKEN
// ==================================

app.post("/api/token", (req, res) => {
  try {
    const { token } = req.body || {};

    if (!token || typeof token !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Valid FCM token required"
      });
    }

    let tokens = readTokens();

    // Remove empty and duplicate tokens
    tokens = [...new Set(tokens.filter(
      t => typeof t === "string" && t.trim() !== ""
    ))];

    // Save new token without deleting other devices
    if (!tokens.includes(token)) {
      tokens.push(token);
    }

    writeJSON(TOKENS_FILE, tokens);

    console.log("Admin FCM Token Registered");
    console.log("Total Tokens:", tokens.length);

    res.json({
      ok: true,
      message: "Admin notification token saved",
      count: tokens.length
    });

  } catch (error) {
    console.error("Token Save Error:", error.message);

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
  const tokens = readTokens();

  res.json({
    count: tokens.length,
    fcmReady
  });
});

// ==================================
// SEND ORDER NOTIFICATION
// ==================================

async function sendOrderNotification(order) {
  const fcm = {
    sent: 0,
    fail: 0,
    tokens: 0,
    errors: []
  };

  if (!fcmReady || !messaging) {
    fcm.error = fcmError || "Firebase is not ready";
    return fcm;
  }

  let tokens = [...new Set(readTokens().filter(Boolean))];

  fcm.tokens = tokens.length;

  if (tokens.length === 0) {
    fcm.error = "No admin device registered";
    return fcm;
  }

  // Firebase multicast limit is 500 tokens per request
  const validTokens = [];

  for (let start = 0; start < tokens.length; start += 500) {
    const batch = tokens.slice(start, start + 500);

    try {
      const result = await messaging.sendEachForMulticast({
        tokens: batch,

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

      fcm.sent += result.successCount;
      fcm.fail += result.failureCount;

      result.responses.forEach((response, index) => {
        const currentToken = batch[index];

        if (response.success) {
          validTokens.push(currentToken);
        } else {
          const code = response.error?.code || "unknown";
          const message = response.error?.message || "Unknown error";

          console.error("FCM Error:", code, message);

          fcm.errors.push({
            code,
            message
          });

          // Remove tokens which cannot work with this Firebase project
          const permanentErrors = [
            "messaging/registration-token-not-registered",
            "messaging/invalid-registration-token",
            "messaging/mismatched-credential"
          ];

          if (!permanentErrors.includes(code)) {
            validTokens.push(currentToken);
          }
        }
      });

    } catch (error) {
      console.error("FCM Batch Error:", error.message);

      fcm.error = error.message;

      // Keep tokens if the whole batch request fails
      validTokens.push(...batch);
    }
  }

  // Save only tokens that remain usable
  writeJSON(TOKENS_FILE, validTokens);

  return fcm;
}

// ==================================
// CREATE NEW ORDER
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

  } catch (error) {
    console.error("Order Error:", error);

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
        ok: false,
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

  } catch (error) {
    console.error("Status Update Error:", error.message);

    res.status(500).json({
      ok: false,
      error: "Status update failed"
    });
  }
});

// ==================================
// START SERVER
// ==================================

app.listen(PORT, () => {
  console.log("--------------------------------");
  console.log("Swaddhist Backend Running");
  console.log("Port:", PORT);
  console.log("FCM Ready:", fcmReady);
  console.log("--------------------------------");
});
