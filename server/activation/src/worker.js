// Mechanical Brush — activation Worker (Cloudflare Workers + KV).
// One code = one machine, single use. Returns an Ed25519-signed receipt the
// app verifies offline and binds to the machine.

const enc = new TextEncoder();

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getSignKey(env) {
  const der = Uint8Array.from(atob(env.SIGN_KEY_PKCS8_B64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

async function signReceipt(env, payload) {
  const key = await getSignKey(env);
  const bytes = enc.encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, bytes);
  return b64url(bytes) + "." + b64url(sig);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

export default {
  async fetch(req, env) {
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(req.url);

    if (url.pathname === "/activate" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "בקשה לא תקינה" }, 400, cors);
      }
      const code = (body.code || "").trim().toUpperCase();
      const machineId = (body.machineId || "").trim();
      if (!code || !machineId) return json({ ok: false, error: "חסרים פרטים" }, 400, cors);

      const key = "code:" + code;
      const cur = await env.CODES.get(key, "json");
      if (cur === null) return json({ ok: false, error: "קוד לא קיים" }, 200, cors);
      if (cur.machine && cur.machine !== machineId)
        return json({ ok: false, error: "הקוד כבר נוצל במחשב אחר" }, 200, cors);

      if (!cur.machine) {
        cur.machine = machineId;
        cur.activatedAt = new Date().toISOString();
        await env.CODES.put(key, JSON.stringify(cur));
      }

      const receipt = await signReceipt(env, {
        code,
        machineId,
        name: cur.name || null,
        iat: Date.now(),
        exp: cur.exp || null,
      });
      return json({ ok: true, receipt, name: cur.name || null }, 200, cors);
    }

    if (url.pathname === "/feedback" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "בקשה לא תקינה" }, 400, cors);
      }
      const message = (body.message || "").toString().slice(0, 4000).trim();
      if (!message) return json({ ok: false, error: "הודעה ריקה" }, 400, cors);
      const entry = {
        message,
        email: (body.email || "").toString().slice(0, 200),
        version: (body.version || "").toString().slice(0, 40),
        platform: (body.platform || "").toString().slice(0, 40),
        at: new Date().toISOString(),
      };
      // Store every note (kept 1 year) so nothing is lost.
      await env.CODES.put(
        "feedback:" + Date.now() + ":" + Math.random().toString(36).slice(2, 7),
        JSON.stringify(entry),
        { expirationTtl: 60 * 60 * 24 * 365 },
      );
      // Email the developer via Resend (if configured).
      if (env.RESEND_API_KEY && env.FEEDBACK_EMAIL_TO) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.RESEND_API_KEY}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              from: env.FEEDBACK_EMAIL_FROM || "onboarding@resend.dev",
              to: env.FEEDBACK_EMAIL_TO,
              reply_to: entry.email || undefined,
              subject: `המכחול המכני · משוב חדש (v${entry.version})`,
              text:
                `${entry.message}\n\n— — —\n` +
                `מאת: ${entry.email || "ללא מייל"}\nגרסה: ${entry.version}\nמערכת: ${entry.platform}\nזמן: ${entry.at}`,
            }),
          });
        } catch {
          /* best-effort */
        }
      }

      // Optional instant notification (Discord/Slack-style webhook).
      if (env.NOTIFY_WEBHOOK_URL) {
        const text =
          `📝 משוב — המכחול המכני\n${entry.message}\n— ${entry.email || "ללא מייל"} · v${entry.version} · ${entry.platform}`;
        try {
          await fetch(env.NOTIFY_WEBHOOK_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: text, text }),
          });
        } catch {
          /* notification is best-effort */
        }
      }
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === "/signup" && req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ ok: false, error: "bad request" }, 400, cors);
      }
      const email = (body.email || "").toString().slice(0, 200).trim();
      const reason = (body.reason || "").toString().slice(0, 2000).trim();
      if (!email || !/.+@.+\..+/.test(email)) return json({ ok: false, error: "אימייל לא תקין" }, 400, cors);
      const entry = { email, reason, at: new Date().toISOString() };
      await env.CODES.put(
        "signup:" + Date.now() + ":" + Math.random().toString(36).slice(2, 7),
        JSON.stringify(entry),
        { expirationTtl: 60 * 60 * 24 * 365 },
      );
      if (env.RESEND_API_KEY && env.FEEDBACK_EMAIL_TO) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
            body: JSON.stringify({
              from: env.FEEDBACK_EMAIL_FROM || "onboarding@resend.dev",
              to: env.FEEDBACK_EMAIL_TO,
              reply_to: email,
              subject: `המכחול המכני · בקשת גישה לאלפה`,
              text: `בקשת גישה חדשה:\n\nאימייל: ${email}\nלמה: ${reason || "—"}\nזמן: ${entry.at}`,
            }),
          });
        } catch {
          /* best-effort */
        }
      }
      return json({ ok: true }, 200, cors);
    }

    if (url.pathname === "/") return new Response("Mechanical Brush activation server", { headers: cors });
    return json({ ok: false, error: "not found" }, 404, cors);
  },
};
