// DLG HQ <-> RabbitSign bridge
//  POST /rabbitsign/send     Send a contract PDF for e-signature (signed-in user only)
//  POST /rabbitsign/status   Refresh a deal's signing status; when everyone signed, save the signed PDF to the deal (signed-in user only)
//  Assignments (doc_kind "asg") are tracked in their own columns (as_*) so they never overwrite the purchase agreement.
//  When an assignment is signed by everyone: signed copy saved to the deal, deal moved to Buyer Deals > Escrow (or "Assigned to Buyer - No EMD"), fee on the card,
//  assignment price + buyer filled in, lead marked "assigned".
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
  if (b.deal_id && b.doc_kind === "asg") {
    await sb.from("deals").update({ as_folder_id: folderId, as_status: "sent", as_sent_at: new Date().toISOString(), as_signed_at: null, as_signers: null, as_meta: b.asg_meta || null, updated_at: new Date().toISOString() }).eq("id", b.deal_id);
  } else if (b.deal_id) {
    await sb.from("deals").update({ rs_folder_id: folderId, rs_status: "sent", rs_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", b.deal_id);
    await milestone(Number(b.deal_id), "offer");
  }
  return { folderId, ordered };
}

async function saveSigned(dealId: number, propertyId: number | null, downloadUrl: string, prefix: string) {
  const zip = new Uint8Array(await (await fetch(downloadUrl)).arrayBuffer());
  let files: Record<string, Uint8Array> = {};
  try { files = unzipSync(zip); } catch { files = { "Signed contract.zip": zip }; }
  const saved: string[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!bytes.length || name.endsWith("/")) continue;
    const base = name.split("/").pop()!;
    const nice = /audit/i.test(base) ? `Signing record (RabbitSign)${prefix === "SIGNED ASSIGNMENT" ? " - assignment" : ""}` : `${prefix} - ` + base.replace(/\.pdf$/i, "");
    const path = `${dealId}/${Date.now()}-${(nice + (base.match(/\.\w+$/)?.[0] || ".pdf")).replace(/[^\w.\- ]+/g, "_")}`;
    const type = /\.pdf$/i.test(base) ? "application/pdf" : /\.zip$/i.test(base) ? "application/zip" : "application/octet-stream";
    const { error } = await sb.storage.from("deal-files").upload(path, bytes, { contentType: type });
    if (!error) { await sb.from("deal_files").insert({ deal_id: dealId, property_id: propertyId, name: `${nice} (${today()})`, storage_path: path, source: "rabbitsign" }); saved.push(nice); }
  }
  return saved;
}

// Assignment fully signed: Buyer Deals > Escrow (or "Assigned to Buyer - No EMD"), fee on the card, assignment price and buyer filled in, lead marked assigned.
async function assigned(dealId: number) {
  const { data: d } = await sb.from("deals").select("purchase_price,assignment_price,buyer_id,lead_id,as_meta,board,stage_id").eq("id", dealId).single();
  if (!d) return;
  const m = d.as_meta || {};
  const upd: Record<string, unknown> = { updated_at: new Date().toISOString(), status: "open" };
  const fee = Number(m.fee);
  if (Number.isFinite(fee)) upd.value = fee; // Buyer Deals cards show the deal's value = the fee
  if (Number.isFinite(fee) && d.purchase_price) upd.assignment_price = Number(d.purchase_price) + fee;
  else if (m.assignment_price) upd.assignment_price = Number(m.assignment_price);
  if (m.buyer_id && !d.buyer_id) upd.buyer_id = Number(m.buyer_id);
  const { data: st } = await sb.from("board_stages").select("id,name,board,position").eq("board", "buyer").order("position");
  const L = st || [];
  const esc = L.find((s: any) => /escrow/i.test(s.name)) || L.find((s: any) => /assigned.*no emd/i.test(s.name)) || L.find((s: any) => /assigned/i.test(s.name)) || L[0];
  if (esc) { upd.board = "buyer"; upd.stage_id = esc.id; }
  await sb.from("deals").update(upd).eq("id", dealId);
  await milestone(dealId, "purchase");
  if (d.lead_id) {
    const order = ["record", "new", "contacted", "interested", "offer", "under_contract", "assigned", "closed"];
    const { data: l } = await sb.from("leads").select("status").eq("id", d.lead_id).single();
    if (order.indexOf(l?.status) < order.indexOf("assigned") && !["dead", "not_selling"].includes(l?.status))
      await sb.from("leads").update({ status: "assigned", updated_at: new Date().toISOString() }).eq("id", d.lead_id);
    const price = (upd.assignment_price as number) || d.assignment_price;
    await sb.from("activity").insert({ lead_id: d.lead_id, kind: "status", body: `Assigned${m.assignee ? " to " + m.assignee : ""}${Number.isFinite(fee) ? " · $" + fee.toLocaleString() + " fee" : ""}${price ? " · $" + Number(price).toLocaleString() + " total" : ""} · moved to ${esc?.name || "Buyer Deals"} (RabbitSign)` });
  }
}

async function sync(dealId: number | null, folderId: string, kind?: "psa" | "asg") {
  const r = await rs("GET", "/api/v1/folder/" + folderId);
  if (!r.ok) throw new Error("RabbitSign status failed: " + r.status + " " + r.text);
  const f = r.data || {};
  if (!dealId || !kind) {
    const { data: a } = await sb.from("deals").select("id").eq("as_folder_id", folderId).maybeSingle();
    if (a) { dealId = a.id; kind = "asg"; }
    else {
      const { data: d } = await sb.from("deals").select("id").eq("rs_folder_id", folderId).maybeSingle();
      dealId = d?.id ?? dealId ?? null; kind = "psa";
    }
  }
  const signers = (f.signers || []).map((s: any) => ({ name: s.name, email: s.email, status: s.status }));
  const allSigned = !!f.downloadUrl || (signers.length > 0 && signers.every((s: any) => s.status === "SIGNED"));
  let saved: string[] = [];
  if (dealId) {
    const A = kind === "asg";
    const { data: deal } = await sb.from("deals").select("rs_status,as_status,property_id").eq("id", dealId).single();
    const was = A ? deal?.as_status : deal?.rs_status;
    const upd: Record<string, unknown> = { [A ? "as_status" : "rs_status"]: allSigned ? "signed" : (f.folderStatus || "sent").toLowerCase(), [A ? "as_signers" : "rs_signers"]: signers, updated_at: new Date().toISOString() };
    if (allSigned && f.downloadUrl && was !== "signed") {
      saved = await saveSigned(dealId, deal?.property_id || null, f.downloadUrl, A ? "SIGNED ASSIGNMENT" : "SIGNED");
      upd[A ? "as_signed_at" : "rs_signed_at"] = new Date().toISOString();
      await sb.from("deals").update(upd).eq("id", dealId);
      if (A) await assigned(dealId); else await milestone(dealId, "purchase");
    } else await sb.from("deals").update(upd).eq("id", dealId);
  }
  return { dealId, kind, folderStatus: f.folderStatus, allSigned, signers, saved };
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
      const kind = b.kind === "asg" ? "asg" : "psa";
      const { data: d } = await sb.from("deals").select("rs_folder_id,as_folder_id").eq("id", b.deal_id).single();
      const fid = kind === "asg" ? d?.as_folder_id : d?.rs_folder_id;
      if (!fid) return json({ error: kind === "asg" ? "The assignment has not been sent through RabbitSign" : "This deal has not been sent through RabbitSign" }, 400);
      if (b.remind) { const r = await rs("POST", "/api/v1/folder-notify/" + fid); if (!r.ok) throw new Error("Reminder failed: " + r.status + " " + r.text); }
      return json(await sync(Number(b.deal_id), fid, kind));
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
