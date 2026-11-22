// WhatsApp: ready-made messages the owner sends with one tap (free), and optional automatic messages
// through Meta's WhatsApp Cloud API (paid per message; needs the WHATSAPP_TOKEN secret and approved templates).
import { rupees } from "./util.js";

export function fillTemplate(template, vars) {
  return String(template).replace(/\{(name|code|total|link)\}/g, (_, k) => String(vars[k] ?? ""));
}

// A wa.me link that opens the owner's WhatsApp with the message ready to send to the customer.
export function waMeLink(phone10, text) {
  return `https://wa.me/91${phone10}?text=${encodeURIComponent(text)}`;
}

export function orderVars(order, link) {
  return { name: (order.customer_name || "").split(" ")[0] || "there", code: order.code, total: rupees(order.total), link };
}

// Sends an approved template message. Never throws: a failed message must not break the order.
export async function sendTemplate(env, settings, phone10, template, params) {
  const api = settings.waApi;
  if (!api.enabled || !env.WHATSAPP_TOKEN || !template || !/^[6-9]\d{9}$/.test(phone10 || "")) return false;
  try {
    const res = await fetch(`https://graph.facebook.com/${api.version}/${api.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: `91${phone10}`,
        type: "template",
        template: {
          name: template,
          language: { code: api.lang },
          components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text: String(text).slice(0, 200) })) }],
        },
      }),
    });
    if (!res.ok) console.error("whatsapp send failed", res.status, (await res.text()).slice(0, 300));
    return res.ok;
  } catch (e) {
    console.error("whatsapp send failed", e.message);
    return false;
  }
}
