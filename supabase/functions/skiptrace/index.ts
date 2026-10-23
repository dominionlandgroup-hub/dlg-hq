// DLG HQ <-> BatchData skip trace
//  POST /skiptrace  { test?: true } -> checks the key (no charge)
//  POST /skiptrace  { first?, last?, street?, city?, state?, zip?, mailStreet?, mailCity?, mailState?, mailZip? }
//  Signed-in DLG HQ users only. Secret: BATCHDATA_API_KEY (Supabase > Edge Functions > Secrets)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== ""));

async function call(path: string, body: unknown, key: string) {
  const r = await fetch("https://api.batchdata.com/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data: any = null; try { data = JSON.parse(text); } catch { /* keep text */ }
  return { http: r.status, data, text: data ? "" : text.slice(0, 500) };
}

function findPersons(o: any, depth = 0): any[] {
  if (!o || typeof o !== "object" || depth > 6) return [];
  if (Array.isArray(o)) { for (const x of o) { const r = findPersons(x, depth + 1); if (r.length) return r; } return []; }
  for (const k of ["persons", "people", "owners"]) if (Array.isArray(o[k]) && o[k].length) return o[k];
  for (const v of Object.values(o)) { const r = findPersons(v, depth + 1); if (r.length) return r; }
  return [];
}
const nm = (n: any) => typeof n === "string" ? n : [n?.first ?? n?.firstName, n?.middle ?? n?.middleName, n?.last ?? n?.lastName].filter(Boolean).join(" ") || n?.full || n?.fullName || "";
const addr = (a: any) => !a ? "" : typeof a === "string" ? a : [a.street ?? a.streetAddress ?? a.address, a.city, a.state, a.zip ?? a.zipCode].filter(Boolean).join(", ");
function summarize(data: any) {
  const persons = findPersons(data);
  return (Array.isArray(persons) ? persons : []).map((p: any) => ({
    name: nm(p?.name ?? p),
    age: p?.age ?? p?.dob?.age ?? p?.dateOfBirth?.age ?? null,
    deceased: p?.death?.deceased ?? p?.deceased ?? p?.isDeceased ?? null,
    mailing: addr(p?.mailingAddress ?? p?.currentAddress ?? p?.address),
    phones: (p?.phoneNumbers ?? p?.phones ?? []).map((x: any) => ({ number: x?.number ?? x?.phoneNumber ?? x?.phone ?? (typeof x === "string" ? x : ""), type: x?.type ?? x?.phoneType ?? "", carrier: x?.carrier ?? "", score: x?.score ?? null, reachable: x?.reachable ?? null })),
    emails: (p?.emails ?? p?.emailAddresses ?? []).map((x: any) => x?.email ?? x?.emailAddress ?? x).filter((x: any) => typeof x === "string"),
    relatives: (p?.relatives ?? p?.associates ?? []).slice(0, 10).map((x: any) => nm(x?.name ?? x)).filter(Boolean),
    keys: Object.keys(p || {}),
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const auth = req.headers.get("authorization") || "";
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: u } = await sb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
    if (!u?.user) return json({ ok: false, error: "Not signed in to DLG HQ." }, 401);
    const key = Deno.env.get("BATCHDATA_API_KEY");
    if (!key) return json({ ok: false, error: "BATCHDATA_API_KEY is not set in Supabase > Edge Functions > Secrets." }, 500);
    const b = await req.json().catch(() => ({}));

    if (b.test) {
      const r = await call("v1/property/skip-trace", { requests: [] }, key);
      const bad = r.http === 401 || r.http === 403;
      return json({ ok: !bad, http: r.http, message: bad ? "BatchData rejected the key (check the token is enabled and has property-skip-trace)." : "Key accepted by BatchData.", raw: r.data ?? r.text });
    }

    const one = clean({
      propertyAddress: b.street || b.city ? clean({ street: b.street, city: b.city, state: b.state, zip: b.zip }) : undefined,
      mailingAddress: b.mailStreet ? clean({ street: b.mailStreet, city: b.mailCity, state: b.mailState, zip: b.mailZip }) : undefined,
      name: b.first || b.last ? clean({ first: b.first, last: b.last }) : undefined,
    });
    if (!one.propertyAddress && !one.mailingAddress) return json({ ok: false, error: "Need at least a street address or a city/state to search." }, 400);

    const tries: any[] = [];
    for (const path of ["v3/property/skip-trace", "v1/property/skip-trace"]) {
      const r = await call(path, { requests: [one] }, key);
      const people = summarize(r.data);
      tries.push({ path, http: r.http, status: r.data?.status ?? null, found: people.length, error: r.http >= 400 ? (r.data?.status?.message || r.data?.message || r.text || "HTTP " + r.http) : null });
      if (r.http < 400 && people.length) return json({ ok: true, via: path, people, tries, raw: b.debug ? r.data : undefined });
      if (r.http === 401 || r.http === 403) break;
    }
    const err = tries.find(t => t.error)?.error;
    return json({ ok: false, error: err ? "BatchData error: " + err : "BatchData found no match for that person/address.", tries });
  } catch (e) {
    return json({ ok: false, error: "Skip trace failed: " + (e as Error).message }, 500);
  }
});
