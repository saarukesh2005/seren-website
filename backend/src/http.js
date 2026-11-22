// Responses, CORS and request parsing.

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify({ success: status < 400, ...data }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers },
  });
}

export const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

export function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

const MAX_BODY = 16 * 1024;

export async function readJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("application/json")) throw new HttpError(415, "Send JSON");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request too large");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "That request wasn't valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Send a JSON object");
  return body;
}

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Only the SEREN website may call the public API from a browser.
export function withCors(response, request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return response;
  const res = new Response(response.body, response);
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Vary", "Origin");
  return res;
}

export function preflight(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    },
  });
}

export const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "local";
