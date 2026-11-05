// DLG HQ - buy box alert (Nov 2026)
// When someone submits the buy box form, submit_buybox() creates a task "New buy box: <name> (<company>)".
// A database trigger on that task calls this function, which texts Damien's buyer Quo line (980) 217-8806 from (704) 275-5457.
// Safe to leave open (no JWT): it only sends for a "New buy box" task created in the last 10 minutes, once per task.
// Secrets used: QUO_API_KEY (already set for the quo function).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ALERT_TO = "+19802178806";      // Damien's buyer Quo line
const ALERT_FROM = "+17042755457";    // spare Quo line (a number cannot text itself)

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return k.default || Object.values(k)[0] as string; } catch { return ""; }
}
const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: true, service: "buybox-alert" });
  const { task_id } = await req.json().catch(() => ({}));
  if (!task_id) return json({ error: "task_id needed" }, 400);
  const { data: t } = await sb.from("tasks").select("id,title,created_at").eq("id", task_id).maybeSingle();
  if (!t || !/^New buy box: /.test(t.title || "")) return json({ error: "not a buy box task" }, 400);
  if (Date.now() - new Date(t.created_at).getTime() > 10 * 60 * 1000) return json({ error: "too old" }, 400);
  const { error: dup } = await sb.from("buybox_alerts").insert({ task_id });
  if (dup) return json({ ok: true, skipped: "already sent" });

  // the buyer the form just saved: newest buyer touched with this name
  const name = t.title.replace(/^New buy box: /, "").replace(/\s*\(.*\)\s*$/, "").trim();
  const { data: b } = await sb.from("buyers").select("id,name,company,phone,email,counties,buy_box").ilike("name", name).order("id", { ascending: false }).limit(1).maybeSingle();
  const parts = [t.title];
  if (b?.counties?.length) parts.push(b.counties.join(", "));
  if (b?.buy_box) parts.push(String(b.buy_box).replace(/\s+/g, " ").slice(0, 160));
  if (b?.phone) parts.push(b.phone);
  parts.push("landiq.land/#buyers");
  const text = parts.join(" · ").slice(0, 600);

  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return json({ error: "Quo API key not set" }, 400);
  const res = await fetch("https://api.quo.com/v1/messages", { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ content: text, from: ALERT_FROM, to: [ALERT_TO] }) });
  const out = await res.json().catch(() => ({}));
  await sb.from("buybox_alerts").update({ sent: res.ok, error: res.ok ? null : (out?.message || `Quo error ${res.status}`) }).eq("task_id", task_id);
  return json({ ok: res.ok, error: res.ok ? undefined : out?.message });
});
