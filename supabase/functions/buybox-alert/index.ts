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
  // only a unique violation means this task was already handled; any other error is a real failure
  if (dup) return dup.code === "23505" ? json({ ok: true, skipped: "already sent" }) : json({ error: dup.message }, 500);

  // the buyer the form just saved: the buyers row submit_buybox stamped (bb_submitted_at) within 10 minutes of the task,
  // whose name is exactly the name in the task title ("New buy box: <name> (<company>)")
  const rest = t.title.replace(/^New buy box: /, "");
  const since = new Date(new Date(t.created_at).getTime() - 10 * 60 * 1000).toISOString();
  const cols = "id,name,company,phone,email,counties,buy_box,bb_submitted_at";
  const { data: recent } = await sb.from("buyers").select(cols).gte("bb_submitted_at", since).order("bb_submitted_at", { ascending: false }).limit(25);
  const exact = (x: any) => rest === x.name || rest === `${x.name} (${x.company})` || rest.startsWith(`${x.name} (`);
  let b: any = (recent || []).find(x => x.name && exact(x)) || null;
  if (!b) {
    const likeEsc = (s: string) => s.replace(/[\\%_]/g, c => "\\" + c);
    const name = rest.replace(/\s*\([^()]*\)(\s*\([^()]*\))?\s*$/, "").trim();
    const { data } = await sb.from("buyers").select(cols).ilike("name", likeEsc(name)).gte("bb_submitted_at", since).order("bb_submitted_at", { ascending: false }).limit(1).maybeSingle();
    b = data;
  }
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
