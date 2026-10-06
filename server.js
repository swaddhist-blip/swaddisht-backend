const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 5000;
const DATA_FILE = path.join(__dirname, "orders.json");

app.use(cors());
app.use(express.json());

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

app.get("/", (req, res) => {
  res.send("Swaddhist Backend is running");
});

app.post("/api/orders", (req, res) => {
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
  res.json({ success: true, order: order });
});

app.get("/api/orders", (req, res) => {
  res.json(readOrders());
});

app.patch("/api/orders/:id", (req, res) => {
  const orders = readOrders();
  const i = orders.findIndex(function (o) { return o.id === req.params.id; });
  if (i < 0) return res.status(404).json({ error: "Order not found" });
  if (req.body.status) orders[i].status = req.body.status;
  writeOrders(orders);
  res.json({ success: true, order: orders[i] });
});

app.get("/api/orders/user/:email", (req, res) => {
  const email = (req.params.email || "").toLowerCase();
  const list = readOrders().filter(function (o) {
    return ((o.user && o.user.email) || "").toLowerCase() === email;
  });
  res.json(list);
});

app.listen(PORT, function () {
  console.log("Swaddhist Backend running on http://localhost:" + PORT);
});