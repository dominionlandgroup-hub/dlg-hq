// DLG HQ <-> Quo (OpenPhone) bridge
// NOTE: the deployed copy also logs rejected webhook signatures to quo_events (added in the dashboard); keep that when redeploying.
//  POST /quo            Quo webhook (texts, calls, recordings, transcripts, summaries) -> inbox
//  POST /quo/send       Send a text from the DLG HQ inbox (signed-in user only)
// Secrets (set in Supabase > Edge Functions > Secrets): QUO_API_KEY, QUO_WEBHOOK_SECRET
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return k.default || Object.values(k)[0] as string; } catch { return ""; }
}
const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const d10 = (p?: string | null) => (p || "").replace(/\D/g, "").slice(-10);
const e164 = (p: string) => "+1" + d10(p);

async function verify(raw: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get("QUO_WEBHOOK_SECRET");
  if (!secret) return true; // not configured yet: accept (set the secret to enforce)
  if (!header) return false;
  for (const part of header.split(",")) {
    const [scheme, ver, ts, sig] = part.trim().split(";");
    if (scheme !== "hmac" || ver !== "1" || !ts || !sig) continue;
    if (Math.abs(Date.now() - Number(ts)) > 10 * 60 * 1000 && Math.abs(Date.now() / 1000 - Number(ts)) > 600) continue;
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret), c => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    for (const body of [raw, JSON.stringify(JSON.parse(raw))]) {
      const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ts + "." + body));
      if (btoa(String.fromCharCode(...new Uint8Array(mac))) === sig) return true;
    }
  }
  return false;
}

// Works with both Quo payload styles: data.object (classic) and data.resource + data.context (2026 API)
function parts(ev: any) {
  const r = ev?.data?.resource ?? ev?.data?.object ?? {};
  const c = ev?.data?.context ?? {};
  const dir: "in" | "out" = (r.direction || "").startsWith("in") ? "in" : "out";
  let ours = "", theirs = "";
  if (c.participants) { ours = c.participants.workspace?.[0] || ""; theirs = c.participants.external?.[0] || ""; }
  else if (c.senderIdentifier) { if (dir === "in") { theirs = c.senderIdentifier; ours = c.recipientIdentifiers?.[0] || ""; } else { ours = c.senderIdentifier; theirs = c.recipientIdentifiers?.[0] || ""; } }
  else { const to = Array.isArray(r.to) ? r.to[0] : r.to; if (dir === "in") { theirs = r.from; ours = to; } else { ours = r.from; theirs = to; } }
  return { r, c, dir, ours, theirs, pn: c.phoneNumberId || r.phoneNumberId };
}

async function ourNumber(pn: string | undefined, fallback: string) {
  if (fallback) return fallback;
  if (!pn) return "";
  const { data } = await sb.from("phone_numbers").select("number").eq("quo_id", pn).maybeSingle();
  return data?.number || "";
}

async function thread(theirs: string, ours: string) {
  const { data, error } = await sb.rpc("quo_thread", { their: theirs, ours });
  if (error) throw error;
  return data as { thread_id: number; lead_id: number; inbox: string };
}

async function upsertMsg(row: Record<string, unknown>) {
  // Blocked numbers (thread muted in DLG HQ): keep the text, but mark it read and leave the thread archived.
  const { data: thr } = await sb.from("threads").select("muted").eq("id", row.thread_id as number).maybeSingle();
  const blocked = !!thr?.muted;
  if (blocked && row.direction === "in") row.is_read = true;
  const { error } = await sb.from("messages").upsert(row, { onConflict: "external_id", ignoreDuplicates: false });
  if (error) throw error;
  await sb.from("threads").update(blocked ? { last_at: row.created_at } : { last_at: row.created_at, archived: false }).eq("id", row.thread_id as number);
  if (row.lead_id) await sb.from("leads").update({ last_contact_at: row.created_at }).eq("id", row.lead_id as number);
}

async function saveRecording(url: string, id: string) {
  try {
    const res = await fetch(url, { headers: { Authorization: Deno.env.get("QUO_API_KEY") || "" } });
    const res2 = res.ok ? res : await fetch(url);
    if (!res2.ok) return url;
    const path = `quo/${id}.mp3`;
    const { error } = await sb.storage.from("call-recordings").upload(path, await res2.arrayBuffer(), { contentType: "audio/mpeg", upsert: true });
    return error ? url : "storage:" + path;
  } catch { return url; }
}

async function handle(ev: any) {
  const t: string = ev.type || "";
  const { r, dir, ours: o0, theirs, pn } = parts(ev);
  if (t.startsWith("message.")) {
    if (t !== "message.received" && t !== "message.delivered") return;
    const ours = await ourNumber(pn, o0);
    const th = await thread(theirs, ours);
    const media = (r.media || []).map((m: any) => m.url).filter(Boolean);
    await upsertMsg({ external_id: "quo-" + r.id, thread_id: th.thread_id, lead_id: th.lead_id, inbox: th.inbox, channel: "sms", direction: dir,
      body: [r.text ?? r.body ?? "", ...media].filter(Boolean).join("\n"), our_number: d10(ours), their_number: d10(theirs),
      is_read: dir === "out", created_at: r.createdAt || new Date().toISOString() });
    return;
  }
  if (t === "call.completed" || t === "call.recording.completed") {
    const ours = await ourNumber(pn, o0);
    const th = await thread(theirs, ours);
    const dur = r.duration ?? (r.answeredAt && r.completedAt ? Math.round((Date.parse(r.completedAt) - Date.parse(r.answeredAt)) / 1000) : 0);
    const missed = dir === "in" && !r.answeredAt && !dur;
    const row: Record<string, unknown> = { external_id: "quo-" + r.id, thread_id: th.thread_id, lead_id: th.lead_id, inbox: th.inbox,
      channel: r.hasVoicemail || r.voicemail ? "voicemail" : "call", direction: dir, duration_s: dur || 0, our_number: d10(ours), their_number: d10(theirs),
      is_read: dir === "out" || !missed ? true : false, created_at: r.createdAt || new Date().toISOString() };
    const rec = r.recordings?.[0]?.url || (Array.isArray(r.media) ? r.media[0]?.url : null) || r.voicemail?.url;
    if (rec) row.recording_url = await saveRecording(rec, r.id);
    const { data: ex } = await sb.from("messages").select("id,body").eq("external_id", "quo-" + r.id).maybeSingle();
    if (ex) { delete row.created_at; if (ex.body) delete row.body; await sb.from("messages").update(row).eq("id", ex.id); const { data: thr2 } = await sb.from("threads").select("muted").eq("id", th.thread_id).maybeSingle(); await sb.from("threads").update(thr2?.muted ? { last_at: new Date().toISOString() } : { last_at: new Date().toISOString(), archived: false }).eq("id", th.thread_id); }
    else await upsertMsg({ ...row, body: missed ? "Missed call" : null });
    const { data: pend } = await sb.from("quo_events").select("id,payload").like("id", "pending-" + r.id + "-%");
    for (const p of pend || []) { await handle(p.payload); await sb.from("quo_events").delete().eq("id", p.id); }
    return;
  }
  if (t === "call.transcript.completed" || t === "call.summary.completed") {
    const callId = r.callId || r.id;
    let text = "";
    if (t === "call.transcript.completed") text = (r.dialogue || []).map((x: any) => `${x.userId ? "Me" : "Them"}: ${x.content}`).join("\n");
    else text = ["Summary: " + (r.summary || []).join(" "), (r.nextSteps || []).length ? "Next steps: " + r.nextSteps.join(" ") : ""].filter(Boolean).join("\n");
    if (!text) return;
    const { data: ex } = await sb.from("messages").select("id,body").eq("external_id", "quo-" + callId).maybeSingle();
    if (!ex) { await sb.from("quo_events").upsert({ id: "pending-" + callId + "-" + t, type: t, payload: ev, error: "call not logged yet" }); return; }
    const body = t === "call.summary.completed" ? [text, ex.body && !/^Missed call$/.test(ex.body) ? ex.body : ""].filter(Boolean).join("\n\n")
      : [ex.body && ex.body.startsWith("Summary:") ? ex.body : "", text].filter(Boolean).join("\n\n");
    await sb.from("messages").update({ body }).eq("id", ex.id);
  }
}

async function send(req: Request) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(tok);
  if (!u?.user) return json({ error: "Sign in again" }, 401);
  const { thread_id, text } = await req.json();
  if (!thread_id || !String(text || "").trim()) return json({ error: "Nothing to send" }, 400);
  const { data: th } = await sb.from("threads").select("id,inbox,lead_id,phone,our_number").eq("id", thread_id).single();
  if (!th?.phone) return json({ error: "This conversation has no phone number" }, 400);
  let from = d10(th.our_number);
  if (!from) { const { data: n } = await sb.from("phone_numbers").select("number").eq("inbox", th.inbox).eq("active", true).limit(1).maybeSingle(); from = n?.number || ""; }
  if (!from) return json({ error: "No Quo number set for this inbox" }, 400);
  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return json({ error: "Quo API key not set yet" }, 400);
  const res = await fetch("https://api.quo.com/v1/messages", { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify({ content: text, from: e164(from), to: [e164(th.phone)] }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: out?.message || out?.title || `Quo error ${res.status}`, code: out?.code }, 400);
  const m = out.data || {};
  await upsertMsg({ external_id: "quo-" + m.id, thread_id: th.id, lead_id: th.lead_id, inbox: th.inbox, channel: "sms", direction: "out", body: text,
    our_number: from, their_number: d10(th.phone), is_read: true, created_at: m.createdAt || new Date().toISOString(), sender: u.user.email });
  return json({ ok: true, id: m.id, status: m.status });
}

async function numbers(req: Request) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(tok);
  if (!u?.user) return json({ error: "Sign in again" }, 401);
  const key = Deno.env.get("QUO_API_KEY");
  if (!key) return json({ error: "Quo API key not set yet" }, 400);
  const res = await fetch("https://api.quo.com/v1/phone-numbers", { headers: { Authorization: key } });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) return json({ error: out?.message || out?.title || `Quo error ${res.status}` }, 400);
  const list = (out.data || []).map((n: any) => ({ number: d10(n.number || n.phoneNumber || n.formattedNumber), quo_id: n.id, name: n.name || "" })).filter((n: any) => n.number);
  for (const n of list) {
    const { data: ex } = await sb.from("phone_numbers").select("number").eq("number", n.number).maybeSingle();
    if (ex) await sb.from("phone_numbers").update({ quo_id: n.quo_id }).eq("number", n.number);
    else await sb.from("phone_numbers").insert({ number: n.number, quo_id: n.quo_id, inbox: "seller", label: n.name ? "Quo: " + n.name : "Quo number" });
  }
  return json({ ok: true, numbers: list });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  if (url.pathname.endsWith("/send")) return send(req);
  if (url.pathname.endsWith("/numbers")) return numbers(req);
  if (req.method !== "POST") return json({ ok: true, service: "dlg-quo" });
  const raw = await req.text();
  if (!(await verify(raw, req.headers.get("openphone-signature")))) return json({ error: "bad signature" }, 401);
  let ev: any; try { ev = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const id = ev.id || crypto.randomUUID();
  try { await handle(ev); await sb.from("quo_events").upsert({ id, type: ev.type, payload: ev }); }
  catch (e) { await sb.from("quo_events").upsert({ id, type: ev.type, payload: ev, error: String((e as Error)?.message || e) }); }
  return json({ ok: true });
});
