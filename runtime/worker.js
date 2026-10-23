// Generic form Worker, copied into every built site. Same shape as the
// phasen.digital enquiry Worker: exact asset matches never reach this code,
// everything else goes through env.ASSETS.fetch so 404.html still works.
import forms from "./forms.json";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const RESEND_URL = "https://api.resend.com/emails";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LENGTHS = { text: 200, email: 254, tel: 40, textarea: 5000, choice: 1000 };

export default {
  async fetch(request, env) {
    const match = new URL(request.url).pathname.match(/^\/api\/forms\/([a-z0-9]+)$/);
    if (!match) return env.ASSETS.fetch(request);

    const form = forms[match[1]];
    if (!form) return json({ ok: false, error: "Unknown form." }, 404);
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid request body." }, 400);
    }

    // Honeypot: bots get a fake success so they don't retry.
    if (clean(body.website)) return json({ ok: true }, 200);

    const values = [];
    let replyTo = "";
    for (const field of form.fields) {
      const value = clean(body[field.id]);
      if (field.required && !value) {
        return json({ ok: false, error: `Please fill in "${field.label}".` }, 400);
      }
      if (value.length > (MAX_LENGTHS[field.type] || 200) || (field.type === "email" && value && !EMAIL_RE.test(value))) {
        return json({ ok: false, error: `"${field.label}" doesn't look right, please check it and try again.` }, 400);
      }
      if (field.type === "email" && value && !replyTo) replyTo = value;
      values.push(`${field.label}:${field.type === "textarea" ? "\n" : " "}${value || "-"}`);
    }

    const token = clean(body["cf-turnstile-response"]);
    if (!token) return json({ ok: false, error: "Please complete the captcha." }, 400);

    const verify = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") || "",
      }),
    });
    if (!(await verify.json()).success) {
      return json({ ok: false, error: "Captcha check failed, please try again." }, 400);
    }

    const text = `New "${form.name}" message from ${env.SITE_NAME}\n\n${values.join("\n\n")}\n`;

    // No key (local `wrangler dev`): log instead of sending.
    if (!env.RESEND_API_KEY) {
      console.log("RESEND_API_KEY not set, would have sent:\n" + text);
      return json({ ok: true }, 200);
    }

    const sent = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${env.SITE_NAME} website <${env.FROM_ADDRESS}>`,
        to: [form.to],
        ...(replyTo && { reply_to: replyTo }),
        subject: `New ${form.name} message from your website`,
        text,
      }),
    });
    if (!sent.ok) {
      console.error("Resend send failed", sent.status, await sent.text());
      return json({ ok: false, error: "Sorry, something went wrong sending your message. Please try again later." }, 502);
    }
    return json({ ok: true }, 200);
  },
};

// Checkbox groups and multi-selects arrive as arrays of strings: joined, never just the last one.
function clean(value) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean).join(", ");
  return typeof value === "string" ? value.trim() : "";
}

function json(payload, status) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
