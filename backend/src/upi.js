// Direct UPI payment links (the same format every UPI app understands). No gateway, no fees.

export function upiLink({ upiId, upiName }, amountPaise, orderCode) {
  const params = new URLSearchParams({
    pa: upiId,
    pn: upiName,
    am: (amountPaise / 100).toFixed(2),
    cu: "INR",
    tn: `SEREN order ${orderCode}`,
  });
  // URLSearchParams writes spaces as "+", which some UPI apps show literally.
  return `upi://pay?${params.toString().replace(/\+/g, "%20")}`;
}

// UPI reference numbers (UTR / RRN) are 12 digits.
export function checkUtr(value) {
  const utr = String(value ?? "").replace(/\s+/g, "");
  if (!/^\d{12}$/.test(utr)) return { error: "The UPI reference is the 12-digit number in your payment app's receipt (UTR / UPI Ref No.)" };
  return { value: utr };
}
