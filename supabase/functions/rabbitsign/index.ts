// DLG HQ <-> RabbitSign bridge
//  POST /rabbitsign/send     Send a contract PDF for e-signature (signed-in user only)
//  POST /rabbitsign/status   Refresh a deal's signing status; when everyone signed, save the signed PDF to the deal (signed-in user only)
//  POST /rabbitsign          RabbitSign webhook (someone signed). Never trusts the body: re-reads the folder from RabbitSign.
// Secrets (Supabase > Edge Functions > Secrets): RABBITSIGN_KEY_ID, RABBITSIGN_KEY_SECRET
// Deploy with "Verify JWT" OFF (the webhook has no Supabase login); send/status check the user's login themselves.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { unzipSync } from "npm:fflate@0.8.2";

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return k.default || Object.values(k)[0] as string; } catch { return ""; }
}
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(SB_URL, serviceKey(), { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const RS = "https://www.rabbitsign.com";

async function sha512(s: string) {
  const h = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}
async function rs(method: string, path: string, body?: unknown) {
  const id = Deno.env.get("RABBITSIGN_KEY_ID"), secret = Deno.env.get("RABBITSIGN_KEY_SECRET");
  if (!id || !secret) throw new Error("RabbitSign key not set up yet (Supabase > Edge Functions > Secrets: RABBITSIGN_KEY_ID and RABBITSIGN_KEY_SECRET)");
  const t = new Date().toISOString().split(".")[0] + "Z";
  const headers: Record<string, string> = {
    "x-rabbitsign-api-time-utc": t, "x-rabbitsign-api-key-id": id,
    "x-rabbitsign-api-signature": await sha512(`${method} ${path} ${t} ${secret}`),
    "User-Agent": "DLG-HQ/1.0", "Accept": "*/*",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(RS + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data, text };
}
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

async function userOk(req: Request) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!tok) return false;
  const { data } = await sb.auth.getUser(tok);
  return !!data?.user;
}

async function milestone(dealId: number, kind: "offer" | "purchase") {
  const { data: d } = await sb.from("deals").select("property_id,purchase_price,lead_id").eq("id", dealId).single();
  if (!d) return;
  const { data: ex } = await sb.from("transactions").select("id").eq("deal_id", dealId).eq("kind", kind).like("notes", "HQ:%").limit(1);
  if ((ex || []).length) return;
  const label = kind === "offer" ? "offer made" : "under contract";
  await sb.from("transactions").insert({ deal_id: dealId, property_id: d.property_id || null, kind, tx_date: today(), price: d.purchase_price || null, costs: 0, notes: "HQ: " + label });
  if (d.lead_id) {
    const order = ["record", "new", "contacted", "interested", "offer", "under_contract", "assigned", "closed"];
    const to = kind === "offer" ? "offer" : "under_contract";
    const { data: l } = await sb.from("leads").select("status").eq("id", d.lead_id).single();
    if (order.indexOf(l?.status) < order.indexOf(to) && !["dead", "not_selling"].includes(l?.status))
      await sb.from("leads").update({ status: to, updated_at: new Date().toISOString() }).eq("id", d.lead_id);
    await sb.from("activity").insert({ lead_id: d.lead_id, kind: "status", body: label[0].toUpperCase() + label.slice(1) + (d.purchase_price ? " · $" + Number(d.purchase_price).toLocaleString() : "") + " (RabbitSign)" });
  }
}

async function send(b: any) {
  const pdf = Uint8Array.from(atob(b.pdf_base64), c => c.charCodeAt(0));
  const up = await rs("POST", "/api/v1/upload-url");
  if (!up.ok || !up.data?.uploadUrl) throw new Error("RabbitSign upload-url failed: " + up.status + " " + up.text);
  const put = await fetch(up.data.uploadUrl, { method: "PUT", headers: { "Content-Type": "binary/octet-stream" }, body: pdf });
  if (!put.ok) throw new Error("Upload to RabbitSign failed: " + put.status + " " + await put.text());
  let fid = 0;
  const signerInfo = (withOrder: boolean) => Object.fromEntries((b.signers || []).map((s: any, i: number) => [String(s.email).trim().toLowerCase(), {
    name: s.name, ...(withOrder ? { signingOrder: s.order ?? i + 1 } : {}),
    fields: (s.fields || []).map((f: any) => ({ id: ++fid, type: f.type, currentValue: "", position: { docNumber: 0, pageIndex: f.page, x: Math.round(f.x), y: Math.round(f.y), width: Math.round(f.w), height: Math.round(f.h) } })),
  }]));
  const folder = (withOrder: boolean) => ({ folder: { title: b.title, summary: b.summary || "", docInfo: [{ url: up.data.uploadUrl, docTitle: b.file_name || "Contract.pdf" }], signerInfo: signerInfo(withOrder) }, date: today() });
  let r = await rs("POST", "/api/v1/folder", folder(true)); let ordered = true;
  if (!r.ok && r.status === 400 && /signingOrder|json/i.test(r.text)) { fid = 0; r = await rs("POST", "/api/v1/folder", folder(false)); ordered = false; }
  if (!r.ok || !r.data?.folderId) throw new Error("RabbitSign create folder failed: " + r.status + " " + r.text);
  const folderId = r.data.folderId;
  if (b.deal_id) {
    await sb.from("deals").update({ rs_folder_id: folderId, rs_status: "sent", rs_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", b.deal_id);
    await milestone(Number(b.deal_id), "offer");
  }
  return { folderId, ordered };
}

async function sync(dealId: number | null, folderId: string) {
  const r = await rs("GET", "/api/v1/folder/" + folderId);
  if (!r.ok) throw new Error("RabbitSign status failed: " + r.status + " " + r.text);
  const f = r.data || {};
  if (!dealId) {
    const { data: d } = await sb.from("deals").select("id").eq("rs_folder_id", folderId).maybeSingle();
    dealId = d?.id ?? null;
  }
  const signers = (f.signers || []).map((s: any) => ({ name: s.name, email: s.email, status: s.status }));
  const allSigned = !!f.downloadUrl || (signers.length > 0 && signers.every((s: any) => s.status === "SIGNED"));
  let saved: string[] = [];
  if (dealId) {
    const { data: deal } = await sb.from("deals").select("rs_status,property_id").eq("id", dealId).single();
    const upd: Record<string, unknown> = { rs_status: allSigned ? "signed" : (f.folderStatus || "sent").toLowerCase(), rs_signers: signers, updated_at: new Date().toISOString() };
    if (allSigned && f.downloadUrl && deal?.rs_status !== "signed") {
      const zip = new Uint8Array(await (await fetch(f.downloadUrl)).arrayBuffer());
      let files: Record<string, Uint8Array> = {};
      try { files = unzipSync(zip); } catch { files = { "Signed contract.zip": zip }; }
      for (const [name, bytes] of Object.entries(files)) {
        if (!bytes.length || name.endsWith("/")) continue;
        const base = name.split("/").pop()!;
        const nice = /audit/i.test(base) ? "Signing record (RabbitSign)" : "SIGNED - " + base.replace(/\.pdf$/i, "");
        const path = `${dealId}/${Date.now()}-${(nice + (base.match(/\.\w+$/)?.[0] || ".pdf")).replace(/[^\w.\- ]+/g, "_")}`;
        const type = /\.pdf$/i.test(base) ? "application/pdf" : /\.zip$/i.test(base) ? "application/zip" : "application/octet-stream";
        const { error } = await sb.storage.from("deal-files").upload(path, bytes, { contentType: type });
        if (!error) { await sb.from("deal_files").insert({ deal_id: dealId, property_id: deal?.property_id || null, name: `${nice} (${today()})`, storage_path: path, source: "rabbitsign" }); saved.push(nice); }
      }
      upd.rs_signed_at = new Date().toISOString();
      await milestone(dealId, "purchase");
    }
    await sb.from("deals").update(upd).eq("id", dealId);
  }
  return { dealId, folderStatus: f.folderStatus, allSigned, signers, saved };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/rabbitsign/, "") || "/";
  try {
    if (route === "/send" || route === "/status") {
      if (!(await userOk(req))) return json({ error: "Please sign in to DLG HQ" }, 401);
      const b = await req.json();
      if (route === "/send") return json(await send(b));
      const { data: d } = await sb.from("deals").select("rs_folder_id").eq("id", b.deal_id).single();
      if (!d?.rs_folder_id) return json({ error: "This deal has not been sent through RabbitSign" }, 400);
      if (b.remind) { const r = await rs("POST", "/api/v1/folder-notify/" + d.rs_folder_id); if (!r.ok) throw new Error("Reminder failed: " + r.status + " " + r.text); }
      return json(await sync(Number(b.deal_id), d.rs_folder_id));
    }
    // Webhook: pull the folder id out of whatever RabbitSign sent, then re-read it from RabbitSign itself.
    const raw = await req.text();
    let ev: any = {}; try { ev = JSON.parse(raw); } catch { /* ignore */ }
    const folderId = ev.folderId || ev.folder_id || ev?.folder?.folderId || ev?.data?.folderId || (raw.match(/[0-9A-F]{20,}/i) || [])[0];
    if (!folderId) return json({ ok: true, note: "no folder id" });
    await sync(null, String(folderId));
    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
