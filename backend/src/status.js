// Order life cycle and which moves the owner may make.

export const STATUS = Object.freeze({
  awaiting_payment: "Waiting for payment",
  payment_submitted: "Payment sent, checking",
  paid: "Paid, confirmed",
  on_tab: "Sent to kitchen, pay at the end",
  preparing: "Being made",
  ready: "Ready",
  out_for_delivery: "Out for delivery",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired (not paid)",
});

// Owner moves. "paid" is reached only through the confirm-payment action (it issues the invoice).
const NEXT = Object.freeze({
  awaiting_payment: ["cancelled"],
  payment_submitted: ["awaiting_payment", "cancelled"],
  paid: ["preparing", "ready", "out_for_delivery", "completed", "cancelled"],
  on_tab: ["preparing", "ready", "completed", "cancelled"],
  preparing: ["ready", "out_for_delivery", "completed", "cancelled"],
  ready: ["out_for_delivery", "completed", "cancelled"],
  out_for_delivery: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  expired: [],
});

export const canMove = (from, to) => (NEXT[from] || []).includes(to);
export const canConfirmPayment = (status) => status === "awaiting_payment" || status === "payment_submitted" || status === "expired";
// Moves the kitchen login may make.
export const KITCHEN_MOVES = ["preparing", "ready"];
// Orders the kitchen should be working on.
export const TO_MAKE = ["paid", "on_tab", "preparing"];

export const isPaid = (status) => ["paid", "preparing", "ready", "out_for_delivery", "completed"].includes(status);
