const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

const DATA_FILE = path.join(__dirname, "orders.json");
const TOKENS_FILE = path.join(__dirname, "tokens.json");

app.use(cors());
app.use(express.json());

/* ---------- Firebase Admin ---------- */
let firebaseReady = false;
let admin = null;

try {
  admin = require("firebase-admin");
  let cred = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // local file — apna JSON filename yahan match karo
    const localKey = path.join(__dirname, "firebase-service-account.json");
    const altKey = path.join(__dirname, "swaddhist-1f08b-firebase-adminsdk.json");
    if (fs.existsSync(localKey)) {
      cred = require(localKey);
    } else if (fs.existsSync(altKey)) {
      cred = require(altKey);
    } else {
      // koi bhi *-firebase-adminsdk*.json
      const files = fs.readdirSync(__dirname).filter(function (f) {
        return f.indexOf("firebase-adminsdk") >= 0 && f.endsWith(".json");
      });
      if (files.length) cred = require(path.join(__dirname, files[0]));
    }
  }

  if (cred) {
    admin.initializeApp({ credential: admin.credential.cert(cred) });
    firebaseReady = true;
    console.log("Firebase Admin ready");
  } else {
    console.log("Firebase key not found — orders will work, push will skip");
  }
} catch (e) {
  console.log("Firebase init error:", e.message);
}

/* ---------- helpers ---------- */
function readOrders() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function writeOrders(orders) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2));
}

function readTokens() {
  try {
    if (!fs.existsSync(TOKENS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function writeTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

async function sendOrderPush(order) {
  if (!firebaseReady) return;
  const tokens = readTokens();
  if (!tokens.length) return;

  const title = "New Swaddhist Order";
  const body =
    "#" +
    order.id +
    " · " +
    ((order.address && order.address.name) || "Customer") +
    " · " +
    ((order.items && order.items.length) || 0) +
    " item(s)";

  try {
    await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: { title: title, body: body },
      data: { orderId: String(order.id || "") },
      webpush: {
        fcmOptions: { link: "/admin/orders.html" }
      }
    });
    console.log("Push sent to", tokens.length, "device(s)");
  } catch (e) {
    console.log("Push error:", e.message);
  }
}

/* ---------- routes ---------- */
app.get("/", function (req, res) {
  res.send("Swaddhist Backend is running");
});

// Admin device token save
app.post("/api/admin/token", function (req, res) {
  const token = (req.body && req.body.token) || "";
  if (!token || token.length < 20) {
    return res.status(400).json({ error: "Invalid token" });
  }
  let tokens = readTokens();
  if (tokens.indexOf(token) === -1) {
    tokens.push(token);
    writeTokens(tokens);
  }
  res.json({ success: true, count: tokens.length });
});

app.post("/api/orders", async function (req, res) {
  const body = req.body || {};
  const orders = readOrders();
  const order = {
    id: "SW" + Date.now().toString().slice(-8),
    date: new Date().toISOString(),
    status: "Placed",
    user: body.user || {},
    address: body.address || {},
    items: body.items || [],
    payment: body.payment || "cod",
    total: body.total || 0
  };
  orders.unshift(order);
  writeOrders(orders);

  // notification (async, order response pehle)
  sendOrderPush(order);

  res.json({ success: true, order: order });
});

app.get("/api/orders", function (req, res) {
  res.json(readOrders());
});

app.patch("/api/orders/:id", function (req, res) {
  const orders = readOrders();
  const i = orders.findIndex(function (o) {
    return o.id === req.params.id;
  });
  if (i < 0) return res.status(404).json({ error: "Order not found" });
  if (req.body.status) orders[i].status = req.body.status;
  writeOrders(orders);
  res.json({ success: true, order: orders[i] });
});

app.get("/api/orders/user/:email", function (req, res) {
  const email = (req.params.email || "").toLowerCase();
  const list = readOrders().filter(function (o) {
    return ((o.user && o.user.email) || "").toLowerCase() === email;
  });
  res.json(list);
});

app.listen(PORT, function () {
  console.log("Swaddhist Backend running on port " + PORT);
});