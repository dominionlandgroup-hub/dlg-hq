// DLG HQ foreclosure scout.
// POST or GET /foreclosure-scout?only=ruff,kania,county  (also brock_nc, brock_sc)
// Auth: header x-scout-key == app_secrets 'scout_key' (nightly cron), OR a signed-in DLG HQ user's JWT ("Run scout now").
// Reads public sources, upserts foreclosure_cases, enriches Mecklenburg parcels from county GIS, recomputes first-pass underwriting.
// Safety: a source's cases are only marked gone after a complete, sane pull. Partial/429 pulls throw and change nothing.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-scout-key", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const strip = (s: string) => s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&middot;/g, "·").replace(/&nbsp;/g, " ")
  .replace(/&#8217;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const money = (s: unknown): number | null => {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/[^0-9.]/g, "");
  return t && !isNaN(Number(t)) ? Number(t) : null;
};
const isoDate = (s: unknown): string | null => {
  const m = String(s ?? "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};
const timeOf = (s: unknown): string | null => { const m = String(s ?? "").match(/\d{1,2}:\d{2}\s*[AP]M/i); return m ? m[0].toUpperCase() : null; };
const normAddr = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const isHeirs = (s: unknown) => /\bheirs?\s+of\b|\bestate\s+of\b|\bheirs\b/i.test(String(s ?? ""));
const isPaid = (s: unknown) => /paid|dismiss|cancel|withdrawn|redeem|satisf/i.test(String(s ?? ""));
const isCommercial = (s: unknown) => /commercial|industrial|office|retail|warehouse|apartment|shopping|multi[- ]?family/i.test(String(s ?? ""));
const pid8 = (s: unknown) => { const d = String(s ?? "").replace(/\D/g, ""); return d ? d.padStart(8, "0") : null; };
const pick = (o: Record<string, unknown>, re: RegExp) => { const k = Object.keys(o).find((x) => re.test(x)); return k ? o[k] : null; };

type Row = Record<string, unknown> & { dedupe_key: string; source: string };
const keyOf = (source: string, county: unknown, caseNo: unknown, address: unknown) =>
  [source, String(county ?? "").toUpperCase(), String(caseNo ?? "").toUpperCase(), normAddr(address)].join("|");

// ---------- sources ----------
async function getText(url: URL | string, tries = 1, pauseMs = 0): Promise<{ status: number; text: string }> {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html,application/json,*/*" } });
    const text = await r.text();
    if (r.status !== 429) return { status: r.status, text };
    if (i < tries - 1) await sleep(pauseMs);
  }
  return { status: 429, text: "" };
}

// Ruff, Bond, Cobb, Wade & Bethune - Mecklenburg tax foreclosures. Columns: name | address | zip | parcel | court file | status
async function fetchRuff(): Promise<Row[]> {
  const r = await getText("https://www.rbcwb.com/tax-foreclosure-listings/");
  if (r.status !== 200) throw new Error("Ruff page HTTP " + r.status);
  const out: Row[] = [];
  for (const m of r.text.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
    const cells = [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => strip(c[1]));
    const pi = cells.findIndex((c) => /^\d{3}-\d{3}-\d{2}$/.test(c));
    if (pi < 3) continue;
    const name = cells.slice(0, pi - 2).join(" ");
    const addrRaw = cells[pi - 2];
    const zip = cells[pi - 1];
    const parcelRaw = cells[pi];
    const caseNo = cells[pi + 1];
    const status = cells.slice(pi + 2).join(" ");
    const note = (addrRaw.match(/\((NOTE[^)]*)\)/i) || [])[1] || null;
    const address = addrRaw.replace(/\(NOTE[^)]*\)/i, "").trim();
    const bid = (status.match(/Current Bid \$([\d,]+\.\d{2})/i) || [])[1];
    const upset = isoDate(status);
    const srcStatus = [status, note ? "Note: " + note : null].filter(Boolean).join(" | ");
    out.push({
      dedupe_key: keyOf("ruff", "Mecklenburg", caseNo, address),
      source: "ruff", state: "NC", county: "Mecklenburg", address, zip,
      parcel: pid8(parcelRaw.replace(/-/g, "")), case_no: caseNo, owner_name: name,
      is_heirs: isHeirs(name), property_type: /vacant lot/i.test(address) || /vacant/i.test(addrRaw) ? "Vacant lot" : "Residential/unknown",
      sale_date: null, sale_time: null, upset_last_day: upset, opening_bid: null, current_bid: money(bid),
      source_status: srcStatus, is_paid_or_dismissed: isPaid(status), is_commercial: isCommercial(addrRaw),
    });
  }
  if (out.length < 10) throw new Error("Ruff: only " + out.length + " rows parsed (expected ~24)");
  return out;
}

// Kania Law Firm - tax foreclosures, 24 NC counties, via the page's own ninja-tables data call.
async function fetchKania(): Promise<Row[]> {
  const page = await getText("https://kanialawfirm.com/tax-foreclosures/foreclosure-listings/");
  if (page.status !== 200) throw new Error("Kania page HTTP " + page.status);
  const h = page.text;
  const tableId = (h.match(/table_id\W{1,6}(\d{1,6})/) || [])[1];
  const nonce = (h.match(/ninja_table_public_nonce\W{1,6}([a-f0-9]{6,20})/i) || [])[1];
  const ajax = ((h.match(/ajax_url\W{1,6}(https?:[^"'\s,]+admin-ajax\.php)/i) || [])[1] || "https://kanialawfirm.com/wp-admin/admin-ajax.php").replace(/\\\//g, "/");
  if (!tableId || !nonce) throw new Error("Kania: table_id or nonce not found on page");
  const u = new URL(ajax);
  u.searchParams.set("action", "wp_ajax_ninja_tables_public_action");
  u.searchParams.set("table_id", tableId);
  u.searchParams.set("target_action", "get-all-data");
  u.searchParams.set("ninja_table_public_nonce", nonce);
  const d = await getText(u);
  if (d.status !== 200) throw new Error("Kania data call HTTP " + d.status);
  let data: any;
  try { data = JSON.parse(d.text); } catch { throw new Error("Kania: data call was not JSON"); }
  const list: any[] = Array.isArray(data) ? data : (data.data ?? data.rows ?? []);
  const out: Row[] = [];
  for (const item of list) {
    const v = (item && item.value) ? item.value : item;
    const county = strip(String(v.county ?? ""));
    if (!county) continue;
    const addrParts = String(pick(v, /^address$/i) ?? "").split(/<br\s*\/?>/i).map((x) => strip(x)).filter(Boolean);
    const address = addrParts[0] ?? "";
    const parcelParts = String(pick(v, /^parcel/i) ?? "").split(/<br\s*\/?>/i).map((x) => strip(x)).filter(Boolean);
    const courtFile = strip(String(pick(v, /court/i) ?? ""));
    const sdt = String(pick(v, /saledate|sale.?date/i) ?? "");
    const status = strip(String(pick(v, /status/i) ?? ""));
    const ptype = strip(String(pick(v, /propertytype|property.?type/i) ?? ""));
    const countyUp = county.toUpperCase();
    const parcel = countyUp === "MECKLENBURG" ? pid8(parcelParts[0]) : (parcelParts[0] || null);
    out.push({
      dedupe_key: keyOf("kania", county, courtFile, address),
      source: "kania", state: "NC", county: county.charAt(0) + county.slice(1).toLowerCase(), address, zip: null,
      parcel, case_no: courtFile, owner_name: null, is_heirs: false, property_type: ptype || null,
      sale_date: isoDate(sdt), sale_time: timeOf(sdt), upset_last_day: isoDate(pick(v, /close/i)),
      opening_bid: money(pick(v, /openingbid|opening/i)), current_bid: money(pick(v, /currentbid|current/i)),
      source_status: status || (isoDate(sdt) ? null : "Sale date not yet set"),
      is_paid_or_dismissed: isPaid(status), is_commercial: isCommercial(ptype),
    });
  }
  if (out.length < 50) throw new Error("Kania: only " + out.length + " rows parsed (expected ~194)");
  return out;
}

// Brock & Scott - mortgage foreclosure sales, one state per run. Pages paced; 429 -> wait 60s, up to 3 retries.
// Any incomplete page throws, so nothing is marked gone on a partial pull.
async function fetchBrock(state: "NC" | "SC"): Promise<Row[]> {
  const out: Row[] = [];
  const seen = new Set<string>();
  for (let p = 1; p <= 40; p++) {
    const u = new URL(p === 1 ? "https://www.brockandscott.com/foreclosure-sales/" : "https://www.brockandscott.com/foreclosure-sales/page/" + p + "/");
    u.searchParams.set("_sft_foreclosure_state", state.toLowerCase());
    const r = await getText(u, 4, 60000);
    if (r.status !== 200) throw new Error("Brock & Scott " + state + " page " + p + " HTTP " + r.status + " (pulled " + out.length + " so far; nothing changed)");
    const rows: Row[] = [];
    for (const m of r.text.matchAll(/<tr[\s\S]*?<\/tr>/gi)) {
      // cells: county | date · time | state | court SP # | case # | address | opening bid | book/page
      const cells = [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => strip(c[1]));
      if (cells.length < 7) continue;
      const [county, when, st, sp, caseNo, address, bid, book] = cells;
      const date = isoDate(when);
      if (!date || !/^(NC|SC)$/.test(st) || !address) continue;
      const zip = (address.match(/(\d{5})(?:-\d{4})?$/) || [])[1] || null;
      rows.push({
        dedupe_key: keyOf("brock", county, caseNo, address),
        source: "brock", state: st, county: county.trim(), address, zip, parcel: null,
        case_no: [sp, caseNo].filter(Boolean).join(" / "), owner_name: null, is_heirs: false, property_type: null,
        sale_date: date, sale_time: timeOf(when), upset_last_day: null, opening_bid: money(bid), current_bid: null,
        source_status: "Scheduled", is_paid_or_dismissed: false, is_commercial: false, book_page: (book || "").trim() || null,
      });
    }
    if (!rows.length) break; // past the last page
    for (const r2 of rows) { if (!seen.has(r2.dedupe_key)) { seen.add(r2.dedupe_key); out.push(r2); } }
    await sleep(6500);
  }
  if (out.length < 10) throw new Error("Brock & Scott " + state + ": only " + out.length + " rows (expected ~" + (state === "NC" ? 188 : 65) + ")");
  return out;
}

// ---------- Mecklenburg county enrichment (values, owner, mailing, last sale, deed book) ----------
const MECK = "https://meckgis.mecklenburgcountync.gov/server/rest/services/TaxParcel_Camaownershipvalues/FeatureServer/0/query";
const fromArcDate = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  return isoDate(v);
};
// Mecklenburg cases without a parcel (Brock & Scott lists only addresses): find the parcel by street number + street name.
async function resolveMeckParcels(sb: any, log: string[]) {
  const { data: rows, error } = await sb.from("foreclosure_cases").select("id, address").eq("county", "Mecklenburg").is("parcel", null).is("gone_since", null);
  if (error) throw new Error("parcel lookup select: " + error.message);
  let found = 0, missed = 0;
  for (const c of rows ?? []) {
    const m = String(c.address ?? "").toUpperCase().match(/^(\d+)\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\s+)?([A-Z0-9]+)/);
    if (!m || m[2].length < 2) { missed++; continue; }
    const u = new URL(MECK);
    u.searchParams.set("where", "situsaddress1 LIKE '" + m[1] + " %" + m[2].replace(/'/g, "''") + "%'");
    u.searchParams.set("outFields", "pid,situsaddress1");
    u.searchParams.set("returnGeometry", "false");
    u.searchParams.set("f", "json");
    const r = await getText(u);
    if (r.status !== 200) throw new Error("Mecklenburg GIS HTTP " + r.status);
    let j: any; try { j = JSON.parse(r.text); } catch { throw new Error("Mecklenburg GIS: not JSON"); }
    const pids = [...new Set((j.features ?? []).map((f: any) => pid8(f.attributes?.pid)).filter(Boolean))];
    if (pids.length === 1) {
      const { error: ue } = await sb.from("foreclosure_cases").update({ parcel: pids[0] }).eq("id", c.id);
      if (ue) throw new Error("parcel update: " + ue.message);
      found++;
    } else {
      const { error: ue } = await sb.from("foreclosure_cases").update({ county_data_status: pids.length ? "several county parcels match this address - check" : "address not found in county data" }).eq("id", c.id);
      if (ue) throw new Error("parcel status update: " + ue.message);
      missed++;
    }
  }
  log.push("county: " + found + " parcel(s) found by address, " + missed + " not matched");
  return { found, missed };
}

async function enrichMeck(sb: any, log: string[]) {
  const { data: cases, error } = await sb.from("foreclosure_cases").select("id, parcel, address").eq("county", "Mecklenburg").not("parcel", "is", null);
  if (error) throw new Error("county select: " + error.message);
  const byPid = new Map<string, any[]>();
  for (const c of cases ?? []) { const k = pid8(c.parcel); if (k) byPid.set(k, [...(byPid.get(k) ?? []), c]); }
  const pids = [...byPid.keys()];
  let matched = 0, unmatched = 0;
  for (let i = 0; i < pids.length; i += 40) {
    const chunk = pids.slice(i, i + 40);
    const u = new URL(MECK);
    u.searchParams.set("where", "pid IN (" + chunk.map((p) => "'" + p + "'").join(",") + ")");
    u.searchParams.set("outFields", "pid,full_owner_name,txt_mailaddr1,txt_city,txt_state,amt_totalvalue,amt_landvalue,amt_netbldgvalue,txt_propertyuse_desc,dte_dateofsale,amt_price,txt_deedbook,situsaddress1,num_totalac");
    u.searchParams.set("returnGeometry", "false");
    u.searchParams.set("f", "json");
    const r = await getText(u);
    if (r.status !== 200) throw new Error("Mecklenburg GIS HTTP " + r.status);
    let j: any; try { j = JSON.parse(r.text); } catch { throw new Error("Mecklenburg GIS: not JSON"); }
    if (j.error) throw new Error("Mecklenburg GIS: " + JSON.stringify(j.error).slice(0, 300));
    const seenPid = new Set<string>();
    for (const f of j.features ?? []) {
      const a = f.attributes ?? {};
      const pid = pid8(a.pid);
      if (!pid || !byPid.has(pid)) continue;
      seenPid.add(pid);
      for (const c of byPid.get(pid)!) {
        const county = {
          county_checked_at: new Date().toISOString(),
          county_data_status: "connected",
          county_owner: a.full_owner_name ?? null,
          county_mail_address: [a.txt_mailaddr1, a.txt_city, a.txt_state].filter(Boolean).join(", ") || null,
          county_value: a.amt_totalvalue ?? null,
          county_land_value: a.amt_landvalue ?? null,
          county_acres: a.num_totalac ?? null,
          county_use: a.txt_propertyuse_desc ?? null,
          county_last_sale_date: fromArcDate(a.dte_dateofsale),
          county_last_sale_price: a.amt_price ?? null,
          county_deed_book: a.txt_deedbook ?? null,
          updated_at: new Date().toISOString(),
        };
        // sanity: street number on the county record should match the listing's street number
        const num = (s: unknown) => (String(s ?? "").trim().match(/^\d+/) || [])[0];
        if (c.address && a.situsaddress1 && num(c.address) && num(a.situsaddress1) && num(c.address) !== num(a.situsaddress1)) {
          (county as any).county_data_status = "connected - address differs, check";
        }
        const { error: ue } = await sb.from("foreclosure_cases").update(county).eq("id", c.id);
        if (ue) throw new Error("county update: " + ue.message);
        matched++;
      }
    }
    const miss = chunk.filter((p) => !seenPid.has(p));
    unmatched += miss.length;
    for (const p of miss) for (const c of byPid.get(p)!) {
      const { error: ue } = await sb.from("foreclosure_cases").update({ county_data_status: "parcel not found in county data" }).eq("id", c.id);
      if (ue) throw new Error("county status update: " + ue.message);
    }
  }
  // parcels not in county data get an explicit status (not the "not connected" default)
  if (unmatched) log.push("county: " + unmatched + " parcel(s) not found in county data");
  log.push("county: " + matched + " case(s) enriched from Mecklenburg GIS");
  return { matched, unmatched, parcels: pids.length };
}


// ---------- Other counties: NC statewide parcel map (all 100 NC counties) + York County SC ----------
// Fills county value, owner on record, mailing address, use, acres, last sale date and deed book.
// Only cases not checked in the last 7 days are looked up, so the nightly run stays fast.
const NC1 = "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/1/query";
const YORKSC = "https://services1.arcgis.com/2AGLxyiJoNiVHKwq/arcgis/rest/services/Parcels/FeatureServer/0/query";
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const HEIRS_RE = /\bHEIRS?\b|\bESTATE\b|\bEST OF\b|\bDECEASED\b|\bDECD\b|\bUNKNOWN HEIRS\b/i;
async function arcQuery(url: string, where: string, out: string): Promise<any[]> {
  const u = new URL(url);
  u.searchParams.set("where", where); u.searchParams.set("outFields", out);
  u.searchParams.set("returnGeometry", "false"); u.searchParams.set("f", "json");
  let last = "";
  for (let t = 0; t < 3; t++) {
    try {
      const r = await getText(u);
      if (r.status === 200) { const j = JSON.parse(r.text); if (!j.error) return j.features ?? []; last = JSON.stringify(j.error).slice(0, 200); }
      else last = "HTTP " + r.status;
    } catch (e) { last = String((e as Error).message ?? e); }
    await sleep(1500);
  }
  throw new Error("county map query failed: " + last);
}
const streetParts = (addr: unknown) => {
  const m = String(addr ?? "").toUpperCase().match(/^(\d+)\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\s+)?([A-Z0-9]+)/);
  return m && m[2].length >= 2 ? { num: m[1], word: m[2].replace(/'/g, "''") } : null;
};
async function enrichOther(sb: any, log: string[], deadline: number, area: string[]) {
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const { data: rows, error } = await sb.from("foreclosure_cases")
    .select("id, state, county, parcel, address, owner_name, is_heirs, county_checked_at")
    .neq("county", "Mecklenburg").is("gone_since", null)
    .or("county_checked_at.is.null,county_checked_at.lt." + weekAgo).range(0, 4999);
  if (error) throw new Error("other-county select: " + error.message);
  // Damien's counties first; stop before Supabase's 150-second request limit (the rest continue on the next run)
  const inArea = (c: any) => area.some((a) => a.toLowerCase() === String(c.county || "").toLowerCase());
  (rows ?? []).sort((a: any, b: any) => Number(inArea(b)) - Number(inArea(a)));
  let matched = 0, missed = 0, skipped = 0, left = 0;
  const outOfTime = () => Date.now() > deadline;
  const save = async (c: any, upd: Record<string, unknown>) => {
    const { error: ue } = await sb.from("foreclosure_cases").update({ ...upd, county_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", c.id);
    if (ue) throw new Error("other-county update: " + ue.message);
  };
  const fromNC = (c: any, a: any) => {
    const yr = a.saledate ? new Date(a.saledate).getUTCFullYear() : 0;
    const book = (String(a.sourceref ?? "").match(/(\d{2,6})\s*\/\s*\d+/) || [])[1] || null;
    const upd: Record<string, unknown> = {
      county_data_status: "connected (NC statewide parcel map)",
      county_owner: a.ownname ?? null,
      county_mail_address: [[a.mailadd, a.munit].filter(Boolean).join(" "), a.mcity, a.mstate, digits(a.mzip).slice(0, 5)].filter(Boolean).join(", ") || null,
      county_value: a.parval ?? ((a.landval ?? 0) + (a.improvval ?? 0) || null),
      county_land_value: a.landval ?? null, county_acres: a.gisacres ?? null, county_use: a.parusedesc ?? null,
      county_last_sale_date: yr >= 1950 ? new Date(a.saledate).toISOString().slice(0, 10) : null,
      county_last_sale_price: null, county_deed_book: book,
    };
    if (!c.parcel && a.parno) upd.parcel = a.parno;
    if (HEIRS_RE.test(String(a.ownname ?? ""))) upd.is_heirs = true;
    return upd;
  };
  const NCOUT = "parno,altparno,ownname,mailadd,munit,mcity,mstate,mzip,parval,landval,improvval,gisacres,parusedesc,saledate,sourceref,siteadd,cntyname";
  // NC: by parcel number first (Kania lists them), then by street address (Brock & Scott lists only addresses)
  const nc = (rows ?? []).filter((c: any) => c.state === "NC");
  const byCounty = new Map<string, any[]>();
  for (const c of nc) byCounty.set(c.county, [...(byCounty.get(c.county) ?? []), c]);
  for (const [county, list] of byCounty) {
    if (outOfTime()) { left += list.length; continue; }
    const cq = String(county).replace(/'/g, "''");
    const withParcel = list.filter((c: any) => c.parcel);
    const found = new Map<number, any>();
    for (let i = 0; i < withParcel.length; i += 40) {
      const chunk = withParcel.slice(i, i + 40);
      const vals = [...new Set(chunk.flatMap((c: any) => [String(c.parcel).trim(), digits(c.parcel)]).filter((v: string) => v.length >= 3))].map((v) => "'" + v.replace(/'/g, "''") + "'");
      if (!vals.length) continue;
      const feats = await arcQuery(NC1, "cntyname='" + cq + "' AND (parno IN (" + vals.join(",") + ") OR altparno IN (" + vals.join(",") + "))", NCOUT);
      for (const c of chunk) {
        const want = [String(c.parcel).trim().toUpperCase(), digits(c.parcel)];
        const hit = feats.find((f: any) => [f.attributes.parno, f.attributes.altparno].some((x: unknown) => x && (want.includes(String(x).trim().toUpperCase()) || (digits(x).length >= 4 && digits(x) === digits(c.parcel)))));
        if (hit) found.set(c.id, hit.attributes);
      }
    }
    for (const c of list) {
      if (outOfTime()) { left++; continue; }
      let a = found.get(c.id);
      if (!a) {
        const sp = streetParts(c.address);
        if (sp) {
          const feats = await arcQuery(NC1, "cntyname='" + cq + "' AND siteadd LIKE '" + sp.num + " %" + sp.word + "%'", NCOUT);
          const pids = [...new Set(feats.map((f: any) => f.attributes.parno))];
          if (pids.length === 1) a = feats[0].attributes;
          else if (pids.length > 1) { await save(c, { county_data_status: "several county parcels match this address - check" }); missed++; continue; }
        }
      }
      if (a) { await save(c, fromNC(c, a)); matched++; }
      else { await save(c, { county_data_status: "not found in NC statewide parcel map" }); missed++; }
    }
  }
  // York County SC (Brock & Scott SC cases)
  const york = (rows ?? []).filter((c: any) => c.state === "SC" && /^york$/i.test(c.county || ""));
  for (const c of york) {
    if (outOfTime()) { left++; continue; }
    const sp = streetParts(c.address);
    if (!sp) { await save(c, { county_data_status: "address not usable for York lookup" }); missed++; continue; }
    const feats = await arcQuery(YORKSC, "PropertyAddress LIKE '" + sp.num + " %" + sp.word + "%'", "ParcelID,Owner1,Owner2,MailAddr1,MailAddr2,MailCity,MailState,MailZip,AprLandVal,AprBldgVal,GISSizeAC,LandUseDesc,DateSold,PropertyAddress");
    const pids = [...new Set(feats.map((f: any) => f.attributes.ParcelID))];
    if (pids.length !== 1) { await save(c, { county_data_status: pids.length ? "several county parcels match this address - check" : "address not found in York County data" }); missed++; continue; }
    const a = feats[0].attributes; const owner = [a.Owner1, a.Owner2].filter(Boolean).join(" & ");
    const upd: Record<string, unknown> = {
      county_data_status: "connected (York County SC)", parcel: c.parcel || a.ParcelID, county_owner: owner || null,
      county_mail_address: [[a.MailAddr1, a.MailAddr2].filter(Boolean).join(" "), a.MailCity, a.MailState, digits(a.MailZip).slice(0, 5)].filter(Boolean).join(", ") || null,
      county_value: (a.AprLandVal ?? 0) + (a.AprBldgVal ?? 0) || null, county_land_value: a.AprLandVal ?? null,
      county_acres: a.GISSizeAC ?? null, county_use: a.LandUseDesc ?? null,
      county_last_sale_date: a.DateSold ? new Date(a.DateSold).toISOString().slice(0, 10) : null, county_last_sale_price: null, county_deed_book: null,
    };
    if (HEIRS_RE.test(owner)) upd.is_heirs = true;
    await save(c, upd); matched++;
  }
  skipped = (rows ?? []).length - nc.length - york.length;
  // other SC counties are not connected yet; give them an explicit status once
  for (const c of (rows ?? []).filter((c: any) => c.state === "SC" && !/^york$/i.test(c.county || ""))) if (!outOfTime()) await save(c, { county_data_status: "county data not connected yet (SC " + (c.county || "?") + ")" });
  log.push("other counties: " + matched + " matched, " + missed + " not matched, " + skipped + " SC cases outside York, " + left + " left for the next run");
  return { matched, missed, skipped, left };
}

// ---------- first-pass underwriting (ESTIMATES; every number is labeled) ----------
function underwrite(c: any, minFee: number, today: string) {
  const usd = (n: number) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US");
  let estDebt: number | null = null; const parts: string[] = [];
  const saleYear = c.county_last_sale_date ? Number(String(c.county_last_sale_date).slice(0, 4)) : null;
  const recentLoan = c.county_last_sale_price > 0 && saleYear && Number(today.slice(0, 4)) - saleYear < 15 ? Math.round(c.county_last_sale_price * 0.8) : 0;
  if (c.source === "ruff" || c.source === "kania") {
    const taxes = c.opening_bid != null && c.opening_bid > 0 ? Number(c.opening_bid) : null;
    estDebt = (taxes ?? 15000) + recentLoan;
    parts.push(taxes != null ? "back taxes = opening bid " + usd(taxes) : "back taxes assumed " + usd(15000) + " (bid not posted yet)");
    if (recentLoan) parts.push("possible mortgage: 80% of " + saleYear + " sale price = " + usd(recentLoan));
  } else if (c.source === "brock") {
    const bid = c.opening_bid != null && c.opening_bid > 0 ? Number(c.opening_bid) : 0;
    const loanProxy = c.county_last_sale_price > 0 ? Math.round(c.county_last_sale_price * 0.8) : 0;
    if (loanProxy || bid) {
      estDebt = Math.max(loanProxy, bid);
      parts.push(estDebt === bid ? "lender opening bid " + usd(bid) : "loan: 80% of " + (saleYear ?? "last") + " sale price = " + usd(loanProxy));
    }
  }
  // Brock & Scott lists the deed of trust book. If it isn't the loan recorded with the owner's purchase deed,
  // the purchase price says nothing about the loan amount (refinance / equity loan, or an older owner's loan).
  let loanFlag = "";
  if (c.source === "brock" && c.book_page && c.county_deed_book) {
    const dotBook = parseInt(String(c.book_page).replace(/^\D+/, ""), 10), deedBook = parseInt(String(c.county_deed_book), 10);
    if (dotBook && deedBook && dotBook !== deedBook) loanFlag = dotBook > deedBook
      ? "Loan was recorded after the purchase (refinance or equity loan) - amount unknown, check the Register of Deeds"
      : "Loan is older than the current owner's deed - check the Register of Deeds";
  }
  // Outside Mecklenburg the county map has no sale price, so a recent buyer's mortgage can't be estimated.
  if (!loanFlag && (c.source === "ruff" || c.source === "kania") && c.county_last_sale_price == null && saleYear && Number(today.slice(0, 4)) - saleYear < 15)
    loanFlag = "Bought in " + saleYear + " and the county map has no sale price - there may be a mortgage, check the Register of Deeds";
  const debtMethod = estDebt !== null ? "est: " + parts.join(" + ") : null;
  const value = c.county_value != null ? Number(c.county_value) : null;
  const spread = value !== null && estDebt !== null ? Math.round(value * 0.7 - estDebt) : null;
  const note = spread !== null ? "Room = 70% of county value (" + usd(value!) + ") minus est. debt. That is what is left for the seller's payout and your fee. County value is not market value - verify with comps." : null;
  let verdict = "Review", reason = "";
  const past = (d: unknown) => !!d && String(d).slice(0, 10) < today;
  if (c.gone_since) { verdict = "Skip"; reason = "No longer on the firm's list"; }
  else if (c.is_paid_or_dismissed) { verdict = "Skip"; reason = "Paid or dismissed per the firm's list"; }
  else if (c.is_commercial) { verdict = "Skip"; reason = "Commercial / non-residential"; }
  else if (past(c.upset_last_day)) { verdict = "Skip"; reason = "Auction finished (upset period ended " + c.upset_last_day + ")"; }
  else if (c.current_bid != null || c.upset_last_day) { verdict = "Skip"; reason = "Auction already held / in the upset-bid period" + (c.upset_last_day ? " (ends " + c.upset_last_day + ")" : ""); }
  else if (past(c.sale_date)) { verdict = "Skip"; reason = "Sale date " + c.sale_date + " has passed"; }
  else if (value !== null && value < 60000) { verdict = "Skip"; reason = "Too cheap: county value " + usd(value); }
  else if (!/^connected/.test(c.county_data_status || "") && !/differs|several|not found/.test(c.county_data_status || "")) { verdict = "Review"; reason = "County data not connected yet for " + (c.county || "this county") + " - can't size equity"; }
  else if (/differs|several|not found/.test(c.county_data_status || "")) { verdict = "Review"; reason = "County record: " + c.county_data_status; }
  else if (spread === null) { verdict = "Review"; reason = "No county value or debt estimate yet - can't size equity"; }
  else if (spread < minFee) { verdict = "Skip"; reason = "Est. room " + usd(spread) + " is below your " + usd(minFee) + " minimum"; }

  else if (loanFlag) { verdict = "Review"; reason = loanFlag + ". Est. room if the loan is small: " + usd(spread); }
  else { verdict = "Pursue"; reason = "Est. room " + usd(spread) + " clears your " + usd(minFee) + " minimum" + (c.is_heirs ? ". Heirs/estate: heir research needed before any offer" : ""); }
  return { est_debt: estDebt, est_debt_method: debtMethod, est_spread: spread, est_spread_note: note, verdict, verdict_reason: reason };
}

// ---------- source sync ----------
async function syncSource(sb: any, source: string, rows: Row[], detailLog: string[], state?: string) {
  // the same case listed twice in one pull would make the upsert fail, so keep the first copy
  const uniq = new Map<string, Row>(); for (const r of rows) if (!uniq.has(r.dedupe_key)) uniq.set(r.dedupe_key, r);
  rows = [...uniq.values()];
  const keys = new Set(rows.map((r) => r.dedupe_key));
  // Brock & Scott runs one state at a time, so only that state's cases can be marked gone.
  let q = sb.from("foreclosure_cases").select("dedupe_key, gone_since").eq("source", source);
  if (state) q = q.eq("state", state);
  const { data: existing, error: se } = await q;
  if (se) throw new Error("select existing: " + se.message);
  const existingKeys = new Set((existing ?? []).map((e: any) => e.dedupe_key));
  const added = rows.filter((r) => !existingKeys.has(r.dedupe_key)).length;
  const updated = rows.length - added;
  const now = new Date().toISOString();
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200).map((r) => ({ ...r, last_seen_at: now, gone_since: null, updated_at: now }));
    const { error } = await sb.from("foreclosure_cases").upsert(batch, { onConflict: "dedupe_key" });
    if (error) throw new Error("upsert " + source + ": " + error.message);
  }
  const gone = (existing ?? []).filter((e: any) => !keys.has(e.dedupe_key) && !e.gone_since).map((e: any) => e.dedupe_key);
  for (let i = 0; i < gone.length; i += 200) {
    const { error } = await sb.from("foreclosure_cases").update({ gone_since: now }).in("dedupe_key", gone.slice(i, i + 200));
    if (error) throw new Error("mark gone " + source + ": " + error.message);
  }
  detailLog.push(source + (state ? " " + state : "") + ": " + rows.length + " rows, " + added + " new, " + gone.length + " gone");
  return { rows_found: rows.length, added, updated, disappeared: gone.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const started = Date.now();
  const url = new URL(req.url);
  const onlyParam = url.searchParams.get("only") || "ruff,kania,county";
  const only = new Set(onlyParam.split(",").map((s) => s.trim()).filter(Boolean));
  const trigger = req.headers.get("x-scout-key") ? "cron" : "manual";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // auth: nightly cron key, or a signed-in DLG HQ user
  const hdrKey = req.headers.get("x-scout-key");
  const { data: keyRow } = hdrKey ? await sb.from("app_secrets").select("value").eq("name", "scout_key").maybeSingle() : { data: null };
  let authed = !!keyRow?.value && hdrKey === keyRow.value;
  if (!authed) {
    const auth = req.headers.get("authorization") || "";
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: u } = await anon.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    authed = !!u?.user;
  }
  if (!authed) return json({ ok: false, error: "Not signed in to DLG HQ and no valid scout key." }, 401);

  const { data: minRow } = await sb.from("foreclosure_settings").select("value").eq("key", "min_fee").maybeSingle();
  const minFee = Number(minRow?.value ?? 25000);
  const detail: string[] = [];
  const results: Record<string, unknown> = {};

  const sources: [string, () => Promise<Row[]>][] = [];
  if (only.has("ruff")) sources.push(["ruff", fetchRuff]);
  if (only.has("kania")) sources.push(["kania", fetchKania]);
  if (only.has("brock_nc")) sources.push(["brock_nc", () => fetchBrock("NC")]);
  if (only.has("brock_sc")) sources.push(["brock_sc", () => fetchBrock("SC")]);

  for (const [name, fetcher] of sources) {
    const startedAt = new Date().toISOString();
    const dbSource = name.startsWith("brock") ? "brock" : name;
    try {
      const rows = await fetcher();
      const counts = await syncSource(sb, dbSource, rows, detail, name === "brock_nc" ? "NC" : name === "brock_sc" ? "SC" : undefined);
      results[name] = { ok: true, ...counts };
      await sb.from("foreclosure_scout_runs").insert({ started_at: startedAt, finished_at: new Date().toISOString(), source: name, trigger, ok: true, rows_found: counts.rows_found, added: counts.added, updated: counts.updated, disappeared: counts.disappeared });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      results[name] = { ok: false, error: msg };
      await sb.from("foreclosure_scout_runs").insert({ started_at: startedAt, finished_at: new Date().toISOString(), source: name, trigger, ok: false, error: msg });
    }
  }

  if (only.has("county")) {
    const startedAt = new Date().toISOString();
    try {
      await resolveMeckParcels(sb, detail);
      const c = await enrichMeck(sb, detail);
      const { data: areaRow } = await sb.from("foreclosure_settings").select("value").eq("key", "counties").maybeSingle();
      const o = await enrichOther(sb, detail, started + 95000, Array.isArray(areaRow?.value) ? areaRow.value : []);
      (c as any).other = o;
      results.county = { ok: true, ...c };
      await sb.from("foreclosure_scout_runs").insert({ started_at: startedAt, finished_at: new Date().toISOString(), source: "county", trigger, ok: true, rows_found: c.parcels, detail: { matched: c.matched, unmatched: c.unmatched } });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      results.county = { ok: false, error: msg };
      await sb.from("foreclosure_scout_runs").insert({ started_at: startedAt, finished_at: new Date().toISOString(), source: "county", trigger, ok: false, error: msg });
    }
  }

  // underwriting for every case (estimates; only changed rows are written)
  const { data: all, error: ae } = await sb.from("foreclosure_cases").select("*").range(0, 9999);
  if (ae) return json({ ok: false, error: "load cases: " + ae.message, results }, 500);
  let changed = 0;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  for (const c of all ?? []) {
    const uw = underwrite(c, minFee, today);
    const same = (x: unknown, y: unknown) => (x === null || x === undefined ? null : typeof y === "number" ? Number(x) : x) === (y === undefined ? null : y);
    const diff = (["est_debt", "est_spread", "verdict", "verdict_reason", "est_debt_method", "est_spread_note"] as const).some((k) => !same((c as any)[k], (uw as any)[k]));
    if (!diff) continue;
    const { error } = await sb.from("foreclosure_cases").update({ ...uw, updated_at: new Date().toISOString() }).eq("id", c.id);
    if (error) return json({ ok: false, error: "underwrite update: " + error.message, results }, 500);
    changed++;
  }
  results.underwriting = { cases: (all ?? []).length, changed, min_fee: minFee };
  return json({ ok: Object.values(results).every((r: any) => r.ok !== false), results, log: detail });
});
