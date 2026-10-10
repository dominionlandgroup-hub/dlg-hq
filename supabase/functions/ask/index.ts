// DLG HQ assistant: answers questions about Damien's data with read-only SQL.
// POST /ask { question, history? }  (signed-in user only)
// Secret: the Anthropic key, saved as "Anthropic API" (ANTHROPIC_API_KEY also accepted)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return k.default || Object.values(k)[0] as string; } catch { return ""; }
}
const sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const KEY = () => Deno.env.get("ANTHROPIC_API_KEY") || Deno.env.get("Anthropic API") || Deno.env.get("ANTHROPIC_API") || Deno.env.get("Anthropic_API") || "";
const MODEL = "claude-sonnet-5-5";

let schemaCache = "";
async function schema() {
  if (schemaCache) return schemaCache;
  const { data } = await sb.rpc("ai_readonly_query", { q: "select table_name, string_agg(column_name||' '||data_type, ', ' order by ordinal_position) cols from information_schema.columns where table_schema='public' and table_name not like 'stg_%' and table_name not in ('quo_events','ai_chats') group by table_name order by table_name" });
  schemaCache = (data || []).map((t: any) => `${t.table_name}(${t.cols})`).join("\n");
  return schemaCache;
}

const SYSTEM = (s: string) => `You are the assistant inside DLG HQ, the CRM for Dominion Land Group, Damien Dupee's land wholesaling business (buys vacant land from owners in NC, SC, GA, TN, FL by direct mail and texting, then assigns contracts to builders).
Answer Damien's questions about his business data. Use the run_sql tool (PostgreSQL, read-only, max 200 rows) as many times as needed, then answer.

How the data fits together:
- leads = contacts/owners (status, tags[], do_not_mail, inbox seller|buyer, source pebble|ghl|web|quo|hq, offer_code).
- properties = parcels (apn, county, county_state, acres, lat/lng); property_owners links properties to leads.
- campaigns = mailings (name, drop_date, records, cost, mail_status); campaign_records = one mailed record (campaign_id, lead_id, property_id, offer_code, offer_price, responded).
- deals = Seller Deals and Buyer Deals boards (board seller|buyer, stage_id -> board_stages.name, status open|won|lost, value, campaign_id, lead_id, property_id). Closed deals are status='won'.
- transactions = purchases and sales (kind purchase|sale, tx_date, price, costs) for ROI. pebble_history = monthly/daily Pebble dashboard totals before the move.
- threads + messages = inbox conversations (channel sms|call|voicemail|email|web, direction in|out, duration_s, created_at).
- tasks, templates, testimonials, deal_files also exist.
Response rate for a campaign = deals linked to it / records mailed.

Rules: never invent numbers; if the data can't answer, say what's missing. Keep answers short and plain, lead with the answer, use a small markdown table for lists. Dates in Eastern time, mm/dd/yyyy. Money like $12,500.

Tables and columns:
${s}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(tok);
  if (!u?.user) return json({ error: "Sign in again" }, 401);
  if (!KEY()) return json({ error: "Anthropic key not found in Supabase secrets" }, 400);
  const { question, history } = await req.json().catch(() => ({}));
  if (!String(question || "").trim()) return json({ error: "Ask a question" }, 400);

  const msgs: any[] = [...(Array.isArray(history) ? history.slice(-8) : []).map((h: any) => ({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content || "") })), { role: "user", content: String(question) }];
  const tools = [{ name: "run_sql", description: "Run one read-only PostgreSQL SELECT (or WITH ... SELECT) against the DLG HQ database. Returns up to 200 rows as JSON.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }];
  const sys = SYSTEM(await schema());
  const queries: string[] = [];
  for (let step = 0; step < 8; step++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "x-api-key": KEY(), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: sys, tools, messages: msgs }) });
    const out = await res.json();
    if (!res.ok) return json({ error: out?.error?.message || `Claude error ${res.status}` }, 400);
    msgs.push({ role: "assistant", content: out.content });
    const uses = (out.content || []).filter((c: any) => c.type === "tool_use");
    if (!uses.length || out.stop_reason !== "tool_use") {
      const answer = (out.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      await sb.from("ai_chats").insert({ user_email: u.user.email, question, answer });
      return json({ answer, queries });
    }
    const results = [];
    for (const t of uses) {
      queries.push(t.input?.query || "");
      const { data, error } = await sb.rpc("ai_readonly_query", { q: t.input?.query || "" });
      results.push({ type: "tool_result", tool_use_id: t.id, content: error ? "ERROR: " + error.message : JSON.stringify(data).slice(0, 60000), is_error: !!error });
    }
    msgs.push({ role: "user", content: results });
  }
  return json({ answer: "That took too many steps. Try asking a narrower question.", queries });
});
