// DLG HQ - builder text drip (Nov 2026)
// Called every 30 minutes by pg_cron (sql/builder_drip.sql). Sends the next due buy-box text to each active builder
// in builder_drip from the builders line (980) 217-8806, through Quo.
// Up to 4 texts: day 0, 3, 7, 14. Weekdays 9am-6pm Eastern only. Max 25 texts per run.
// Before every text it stops the builder if they replied, texted STOP, filled out the buy box form, or are suppressed.
// Safe to leave open (no JWT): it only ever sends texts that are due, once per step.
// Secrets used: QUO_API_KEY (already set for the quo function).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const FROM = "+19802178806";   // builders line
const LINK = "dominionlandgroup.land/buybox";
const DAYS = [0, 3, 7, 14];    // when each text goes out, counted from enrollment
const MAX_PER_RUN = 25;

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return k.default || Object.values(k)[0] as string; } catch { return ""; }
}
const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
const d10 = (p?: string | null) => (p || "").replace(/\D/g, "").slice(-10);

// Every text opens "Hi <first name>, this is Damien with Dominion Land Group" and ends "Reply STOP to unsubscribe".
function message(step: number, first: string, county: string) {
  const hi = `Hi ${first || "there"}, this is Damien with Dominion Land Group.`;
  const where = county ? `${county} County` : "your area";
  const end = "Reply STOP to unsubscribe";
  return [
    `${hi} I specialize in sourcing lots for builders in ${where}. Are you currently buying more lots? If so, can you fill out my buy box form so I can get to hunting ASAP? ${LINK} ${end}`,
    `${hi} Following up on lots in ${where}. If you're buying, my 2-minute buy box tells me exactly what to look for: ${LINK} ${end}`,
    `${hi} I'm getting ready to reach out to vacant lot owners in ${where}. If you want me hunting for you there, fill out the buy box: ${LINK} ${end}`,
    `${hi} Last note from me. If you ever need lots in ${where}, the buy box is here: ${LINK} ${end}`,
  ][step];
}

// Weekdays 9:00-17:59 Eastern
function inHours(now = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  return !["Sat", "Sun"].includes(p.weekday) && h >= 9 && h < 18;
}

async function stopReason(d: any): Promise<[string, string] | null> {
  const ph = d10(d.phone);
  // any text back from them since they were enrolled
  const { data: inMsg } = await sb.from("messages").select("body,created_at").eq("their_number", ph).eq("direction", "in")
    .gte("created_at", d.enrolled_at).order("created_at", { ascending: false }).limit(1);
  if (inMsg?.length) {
    const b = String(inMsg[0].body || "").trim();
    if (/^\s*(stop|unsubscribe|cancel|end|quit|stop all)\b/i.test(b)) return ["stopped", "Texted STOP"];
    return ["replied", "Replied: " + b.slice(0, 120)];
  }
  // another number at the same company already replied, filled out the buy box or texted STOP: stop this one too
  const { data: sib } = await sb.from("builder_drip").select("id,status,stop_reason").ilike("company", d.company).neq("id", d.id).in("status", ["replied", "buybox", "stopped"]).limit(1);
  if (sib?.length) return ["stopped", "Another number at " + d.company + ": " + (sib[0].stop_reason || sib[0].status)];
  // filled out the buy box form (same phone)
  const { data: bb } = await sb.from("buyers").select("id,bb_submitted_at,phone").not("bb_submitted_at", "is", null).ilike("phone", "%" + ph.slice(-4) + "%").limit(20);
  if ((bb || []).some(x => d10(x.phone) === ph)) return ["buybox", "Filled out the buy box"];
  // suppression list (do not contact)
  const { data: sup } = await sb.from("suppression").select("phone").ilike("phone", "%" + ph.slice(-4) + "%").limit(20);
  if ((sup || []).some(x => d10(x.phone) === ph)) return ["stopped", "On the suppression list"];
  return null;
}

Deno.serve(async (req) => {
  const force = new URL(req.url).searchParams.get("check") === "1";
  if (!inHours() && !force) return json({ ok: true, skipped: "outside weekday 9-6 Eastern" });
  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return json({ error: "Quo API key not set" }, 400);

  const { data: due, error } = await sb.from("builder_drip").select("*").eq("status", "active").lte("next_at", new Date().toISOString())
    .order("next_at").limit(MAX_PER_RUN);
  if (error) return json({ error: error.message }, 500);
  const out: any[] = [];
  for (const d of due || []) {
    const stop = await stopReason(d);
    if (stop) { await sb.from("builder_drip").update({ status: stop[0], stop_reason: stop[1] }).eq("id", d.id); out.push({ id: d.id, stopped: stop[1] }); continue; }
    if (d.step >= DAYS.length) { await sb.from("builder_drip").update({ status: "done", stop_reason: "All 4 texts sent" }).eq("id", d.id); continue; }
    if (force) { out.push({ id: d.id, would_send: d.step + 1 }); continue; }

    // claim this step first so a double run can't send it twice
    const { data: claimed } = await sb.from("builder_drip").update({ step: d.step + 1, last_sent_at: new Date().toISOString() })
      .eq("id", d.id).eq("step", d.step).eq("status", "active").select("id");
    if (!claimed?.length) continue;

    const body = message(d.step, (d.first_name || "").trim(), (d.county || "").trim());
    const res = await fetch("https://api.quo.com/v1/messages", { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ content: body, from: FROM, to: ["+1" + d10(d.phone)] }) });
    const r = await res.json().catch(() => ({}));
    const err = res.ok ? null : (r?.message || `Quo error ${res.status}`);
    await sb.from("builder_drip_log").insert({ drip_id: d.id, step: d.step + 1, body, ok: res.ok, error: err });
    const next = d.step + 1 < DAYS.length ? new Date(new Date(d.enrolled_at).getTime() + DAYS[d.step + 1] * 86400000).toISOString() : null;
    if (res.ok) await sb.from("builder_drip").update(next ? { next_at: next, last_error: null } : { status: "done", stop_reason: "All 4 texts sent", next_at: null, last_error: null }).eq("id", d.id);
    else await sb.from("builder_drip").update({ status: "error", last_error: err, step: d.step }).eq("id", d.id);
    out.push({ id: d.id, step: d.step + 1, ok: res.ok, error: err });
  }
  return json({ ok: true, ran: out.length, out });
});
