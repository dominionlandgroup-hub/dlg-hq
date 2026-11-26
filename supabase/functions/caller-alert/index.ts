// caller-alert: texts Damien when a caller sets an appointment or hits Text Damien, and sends the caller's
// "Send text" messages to sellers from that caller's own Quo line (caller_accounts.quo_line, Nov 2026).
// Called by the owner_alerts insert trigger (sql/callers.sql) with x-cron-key = app_secrets 'caller_alert'.
// Only ever texts Damien's own cell, from the seller line. Deploy with "Verify JWT" OFF.
// Secrets used: QUO_API_KEY (already set for the quo function).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const TO = "+12023215846";   // Damien's cell
const FROM = "+17043873482"; // DLG seller line (Quo)
const CALLER_LINE = "+17042755457"; // default caller line (Olivia) when a caller has no quo_line set

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return k.default || Object.values(k)[0] as string; } catch { return ""; }
}
const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  const { data: sec } = await sb.from("app_secrets").select("value").eq("name", "caller_alert").maybeSingle();
  if (!sec?.value || req.headers.get("x-cron-key") !== sec.value) return json({ error: "unauthorized" }, 401);
  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return json({ error: "QUO_API_KEY not set" }, 500);
  const { data: rows } = await sb.from("owner_alerts").select("id,body").is("sent_at", null)
    .gte("created_at", new Date(Date.now() - 86400000).toISOString()).order("id").limit(10);
  const out: unknown[] = [];
  for (const a of rows || []) {
    const res = await fetch("https://api.quo.com/v1/messages", { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ content: a.body, from: FROM, to: [TO] }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) await sb.from("owner_alerts").update({ sent_at: new Date().toISOString(), error: null }).eq("id", a.id);
    else await sb.from("owner_alerts").update({ error: body?.message || body?.title || `Quo error ${res.status}` }).eq("id", a.id);
    out.push({ id: a.id, ok: res.ok });
  }
  // caller texts to sellers (Send text button), from her line
  const { data: texts } = await sb.from("caller_texts").select("id,caller_id,deal_id,lead_id,phone,body").is("sent_at", null).is("error", null)
    .gte("created_at", new Date(Date.now() - 3600000).toISOString()).order("id").limit(20);
  for (const t of texts || []) {
    // each caller texts from their own Quo line (caller_accounts.quo_line)
    const { data: acc } = await sb.from("caller_accounts").select("quo_line").eq("id", t.caller_id).maybeSingle();
    const from = (acc?.quo_line || "").trim() || CALLER_LINE;
    const res = await fetch("https://api.quo.com/v1/messages", { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ content: t.body, from, to: [t.phone] }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { await sb.from("caller_texts").update({ error: body?.message || body?.title || `Quo error ${res.status}` }).eq("id", t.id); out.push({ text: t.id, ok: false }); continue; }
    await sb.from("caller_texts").update({ sent_at: new Date().toISOString() }).eq("id", t.id);
    const { data: c } = await sb.from("caller_accounts").select("name").eq("id", t.caller_id).maybeSingle();
    const d = t.phone.replace(/\D/g, "").slice(-10), fmt = `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    const et = new Date().toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" });
    const line = `[${et} ET] ${c?.name || "Caller"} (caller) - TEXT SENT to ${fmt}\n${t.body}`;
    const { data: deal } = await sb.from("deals").select("notes").eq("id", t.deal_id).maybeSingle();
    const notes = deal?.notes || "";
    await sb.from("deals").update({ notes: notes + (notes.includes("CALLER NOTES") ? "\n\n" : "\n\n---------- CALLER NOTES ----------\n") + line, updated_at: new Date().toISOString() }).eq("id", t.deal_id);
    if (t.lead_id) await sb.from("activity").insert({ lead_id: t.lead_id, kind: "sms", body: line });
    out.push({ text: t.id, ok: true });
  }
  return json({ ok: true, sent: out });
});
