export interface Env {
  XERO_CLIENT_ID: string;
  XERO_CLIENT_SECRET: string;
  XERO_REDIRECT_URI: string;
  XERO_KV: KVNamespace;
  SONDERPLAN_TOKEN: string;
}

interface XeroTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  tenant_id: string;
  created_at?: number;
}

const XERO_AUTH_URL  = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE  = "https://api.xero.com/api.xro/2.0";
const SP_API_BASE    = "https://api.sonderplan.com/v2";

function parseXeroDate(val: string | undefined | null): string | null {
  if (!val) return null;
  const match = val.match(/\/Date\((\d+)/);
  if (match) return new Date(parseInt(match[1])).toISOString().substring(0, 7);
  return val.substring(0, 7);
}

function parseXeroDateObj(val: string | undefined | null): Date | null {
  if (!val) return null;
  const match = val.match(/\/Date\((\d+)/);
  if (match) return new Date(parseInt(match[1]));
  return new Date(val);
}

function startOfThisWeek(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}

function toISO(d: Date): string {
  return d.toISOString().substring(0, 10);
}

function parseQuotedPrice(raw: string | null): { price: number | null; flag: string } {
  if (!raw) return { price: null, flag: "No Quote" };
  let cleaned = raw.trim();
  if (/^foc$/i.test(cleaned)) return { price: 0, flag: "FOC" };
  if (!/\d/.test(cleaned)) return { price: null, flag: "No Quote" };
  cleaned = cleaned.replace(/£\s*£/g, "£").replace(/£\s+/g, "£").replace(/,,/g, ",");
  const allMatches = cleaned.match(/£([\d,]+\.?\d*)/g);
  if (allMatches && allMatches.length > 0) {
    const amounts = allMatches.map(m => parseFloat(m.replace(/£/g, "").replace(/,/g, "")));
    const minAmount = Math.min(...amounts);
    const flag = amounts.length > 1 ? "Multi-Price"
      : /weekend|option|estimate|amended|previous|reduced|prepay/i.test(raw) ? "Extracted" : "Clean";
    return { price: minAmount, flag };
  }
  const bareMatch = cleaned.match(/^[\d,]+\.?\d*/);
  if (bareMatch) return { price: parseFloat(bareMatch[0].replace(/,/g, "")), flag: "Extracted" };
  return { price: null, flag: "Complex" };
}

// ─── Sonderplan fetch ─────────────────────────────────────────────────────────
// Key fixes:
// 1. Uses date filter to only fetch current year
// 2. Groups all resource rows by booking ID first, then picks status from
//    whichever row has it (only parent rows carry status)
// 3. Only includes Confirmed and Provisional statuses

async function fetchSonderplanPipeline(token: string, fromTime: number, toTime: number): Promise<any[]> {
  const PIPELINE_STATUSES = new Set(["Confirmed", "Provisional"]);
  const EXCLUDED_STATUSES = new Set(["Cancelled","Passed on","Unavailable","Waiting List","Set up/ Pack down/Travel"]);

  const headers = {
    Authorization:  `Bearer ${token}`,
    Accept:         "application/json",
    "Content-Type": "application/json",
  };

  let allRows: any[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${SP_API_BASE}/booking?page=${page}&limit=25&from_time=${fromTime}&to_time=${toTime}&resource_parent=true`;
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      console.error("Sonderplan fetch failed:", res.status, await res.text());
      break;
    }
    const json: any = await res.json();
    if (page === 1) totalPages = json.meta?.pagination?.total_pages || 1;
    if (!json.data || json.data.length === 0) break;
    allRows = allRows.concat(json.data);
    page++;
  } while (page <= totalPages);

  // Deduplicate on name + start date — this is the true unique key for an event.
  // Multiple rows can exist for the same event (one per vehicle/unit assigned).
  // We take the first row that has a usable status and price.
  const seen = new Set<string>();
  const pipeline: any[] = [];

  const MOBILOO_PARENT_ID = 23814; // Mobiloos parent class in Sonderplan

  for (const row of allRows) {
    if (row.deleted) continue;

    const status = row.status?.[0]?.name || "";
    if (!status || !PIPELINE_STATUSES.has(status)) continue;
    if (EXCLUDED_STATUSES.has(status)) continue;

    // Only include bookings that have at least one active Mobiloo unit
    // parent_id 23814 = Mobiloos. If all resources are deleted = cancelled event.
    const resources = row.resources || [];
    const activeResources = resources.filter((r: any) => !r.deleted);
    const hasMobiloo = activeResources.some((r: any) => r.parent_id === MOBILOO_PARENT_ID);
    if (!hasMobiloo) continue;

    // Dedup key: event name + start timestamp
    const dedupKey = `${row.name}__${row.start}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const getField = (name: string) => {
      const f = (row.custom_fields || []).find((cf: any) => cf.name === name);
      return f?.value || null;
    };

    const rawPrice = getField("Quoted Price");
    const parsed   = parseQuotedPrice(rawPrice);

    // Skip unparseable or zero/no-quote prices — not useful for forecasting
    if (parsed.flag === "Complex" || parsed.flag === "No Quote") continue;
    if (parsed.price === null || parsed.price === 0) continue;

    const eventStart = row.start ? new Date(row.start * 1000) : null;
    if (!eventStart) continue;

    // Only include events within the requested date window
    const eventTs = eventStart.getTime() / 1000;
    if (eventTs < fromTime || eventTs > toTime) continue;

    // Expected payment = 1 month before event
    const paymentDate = new Date(eventStart);
    paymentDate.setMonth(paymentDate.getMonth() - 1);

    // Skip if payment date is already in the past
    if (paymentDate.getTime() < Date.now()) continue;

    pipeline.push({
      id:          `${row.id}`,
      name:        row.name,
      status,
      eventStart:  toISO(eventStart),
      paymentDate: toISO(paymentDate),
      price:       parsed.price,
      priceFlag:   parsed.flag,
      rawPrice,
    });
  }

  return pipeline;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url  = new URL(request.url);
    const path = url.pathname.toLowerCase().replace(/\/+$/, "");
    if (path === "/auth/callback")         return handleCallback(url, env);
    if (path === "/auth")                  return redirectToXero(env);
    if (path === "/dashboard")             return serveDashboard();
    if (path === "/forecast")              return serveForecast();
    if (path === "/api/cashflow")          return handleCashflow(env);
    if (path === "/api/invoices")          return callXeroAPI(env, '/Invoices?where=Status%3D%3D%22AUTHORISED%22&order=DueDate+ASC');
    if (path === "/api/invoices-by-month") return handleInvoicesByMonth(env);
    if (path === "/api/cashburn")          return handleCashBurn(env);
    if (path === "/api/pnl")               return handleProfitAndLoss(env);
    if (path === "/api/forecast")          return handleForecast(env);
    if (path === "/api/pipeline")          return handlePipeline(env);
    if (path === "/api/sp-debug")          return handleSpDebug(env);
    return new Response("Xero Worker running. Visit /dashboard or /forecast");
  },
};

function redirectToXero(env: Env): Response {
  const params = new URLSearchParams({
    response_type: "code", response_mode: "query", client_id: env.XERO_CLIENT_ID,
    redirect_uri: env.XERO_REDIRECT_URI,
    scope: ["openid","profile","email","offline_access","accounting.invoices","accounting.payments",
      "accounting.banktransactions","accounting.manualjournals","accounting.settings"].join(" "),
  });
  return Response.redirect(`${XERO_AUTH_URL}?${params}`, 302);
}

async function handleCallback(url: URL, env: Env): Promise<Response> {
  const code = url.searchParams.get("code");
  if (!code) return new Response("Missing code", { status: 400 });
  const raw = await exchangeCodeForToken(code, env);
  const connRes = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${raw.access_token}` },
  });
  if (!connRes.ok) return new Response("Failed: " + await connRes.text(), { status: 500 });
  const connections: any[] = await connRes.json();
  if (!connections.length) return new Response("No Xero tenants found", { status: 500 });
  const tokens: XeroTokens = {
    access_token: raw.access_token, refresh_token: raw.refresh_token,
    expires_at: Date.now() + raw.expires_in * 1000,
    tenant_id: connections[0].tenantId, created_at: Date.now(),
  };
  await env.XERO_KV.put("xero_tokens", JSON.stringify(tokens));
  return Response.redirect(new URL("/dashboard", url).toString(), 302);
}

async function exchangeCodeForToken(code: string, env: Env): Promise<any> {
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code,
      redirect_uri: env.XERO_REDIRECT_URI, client_id: env.XERO_CLIENT_ID,
      client_secret: env.XERO_CLIENT_SECRET }),
  });
  return res.json();
}

async function getValidTokens(env: Env): Promise<XeroTokens> {
  const stored = await env.XERO_KV.get("xero_tokens", "json") as XeroTokens | null;
  if (!stored) throw new Error("Not authenticated with Xero");
  if (Date.now() < stored.expires_at) return stored;
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stored.refresh_token,
      client_id: env.XERO_CLIENT_ID, client_secret: env.XERO_CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + await res.text());
  const r = await res.json() as any;
  const tokens: XeroTokens = { access_token: r.access_token, refresh_token: r.refresh_token,
    expires_at: Date.now() + r.expires_in * 1000, tenant_id: stored.tenant_id };
  await env.XERO_KV.put("xero_tokens", JSON.stringify(tokens));
  return tokens;
}

async function callXeroAPI(env: Env, endpoint: string): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const res = await fetch(`${XERO_API_BASE}${endpoint}`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" },
  });
  return new Response(await res.text(), { status: res.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
}

async function handlePipeline(env: Env): Promise<Response> {
  if (!env.SONDERPLAN_TOKEN) return new Response("SONDERPLAN_TOKEN not configured", { status: 500 });
  const now      = new Date();
  const fromTime = Math.floor(now.getTime() / 1000);
  const toTime   = Math.floor(addDays(now, 34 * 7).getTime() / 1000);
  try {
    const pipeline = await fetchSonderplanPipeline(env.SONDERPLAN_TOKEN, fromTime, toTime);
    return Response.json({ pipeline, count: pipeline.length }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (e: any) { return new Response("Sonderplan error: " + e.message, { status: 500 }); }
}

async function handleSpDebug(env: Env): Promise<Response> {
  const tokenCheck = {
    hasToken:    !!env.SONDERPLAN_TOKEN,
    tokenLength: env.SONDERPLAN_TOKEN?.length || 0,
    tokenStart:  env.SONDERPLAN_TOKEN?.substring(0, 8) || "MISSING",
  };
  if (!env.SONDERPLAN_TOKEN) return Response.json({ error: "SONDERPLAN_TOKEN not set", tokenCheck });

  const now      = new Date();
  const fromTime = Math.floor(now.getTime() / 1000);
  const toTime   = Math.floor(addDays(now, 34 * 7).getTime() / 1000);
  const url = `${SP_API_BASE}/booking?page=1&limit=5&from_time=${fromTime}&to_time=${toTime}`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.SONDERPLAN_TOKEN}`, Accept: "application/json", "Content-Type": "application/json" },
  });

  const httpStatus = res.status;
  const rawText    = await res.text();
  let parsed: any  = null;
  try { parsed = JSON.parse(rawText); } catch(e) {}

  // Also run full pipeline fetch to show what we'd actually use
  let pipelinePreview: any[] = [];
  try {
    pipelinePreview = await fetchSonderplanPipeline(env.SONDERPLAN_TOKEN, fromTime, toTime);
  } catch(e) {}

  return Response.json({
    tokenCheck, httpStatus,
    rawTextPreview: rawText.substring(0, 800),
    meta: parsed?.meta || null,
    total_rows_page1: parsed?.data?.length || 0,
    first_booking: parsed?.data?.[0] ? {
      id:            parsed.data[0].id,
      name:          parsed.data[0].name,
      start_as_date: parsed.data[0].start ? new Date(parsed.data[0].start * 1000).toISOString() : null,
      status_raw:    parsed.data[0].status,
      custom_fields: parsed.data[0].custom_fields,
    } : null,
    all_statuses_page1: (parsed?.data || []).map((b: any) => ({
      id: b.id, name: b.name,
      status: b.status?.[0]?.name || "(no status on this row)",
      start_date: b.start ? new Date(b.start * 1000).toISOString().substring(0,10) : null,
    })),
    pipeline_after_filter: {
      count: pipelinePreview.length,
      items: pipelinePreview.slice(0, 5).map(p => ({
        name: p.name, status: p.status, eventStart: p.eventStart,
        paymentDate: p.paymentDate, price: p.price, priceFlag: p.priceFlag,
      })),
    },
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleForecast(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" };
  const weekStart = startOfThisWeek();
  const weekEnd   = addDays(weekStart, 34 * 7 - 1); // 34-week / ~8-month rolling forecast
  // Sonderplan: fetch events within the 7-month forecast window
  const spFromTime = Math.floor(weekStart.getTime() / 1000);
  const spToTime   = Math.floor(weekEnd.getTime() / 1000);

  const [invRes, billRes, txRes, spPipeline] = await Promise.all([
    fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22AUTHORISED%22%26%26Type%3D%3D%22ACCREC%22`, { headers: h }),
    fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22AUTHORISED%22%26%26Type%3D%3D%22ACCPAY%22`, { headers: h }),
    fetch(`${XERO_API_BASE}/BankTransactions`, { headers: h }),
    env.SONDERPLAN_TOKEN
      ? fetchSonderplanPipeline(env.SONDERPLAN_TOKEN, spFromTime, spToTime).catch(() => [])
      : Promise.resolve([]),
  ]);

  const [invData, billData, txData] = await Promise.all([invRes.json() as any, billRes.json() as any, txRes.json() as any]);

  interface LineItem { ref: string; contact: string; amount: number; due: string; type: string; source: "xero"|"sonderplan"; status?: string; priceFlag?: string; }
  interface WeekBucket { weekStart: string; weekEnd: string; label: string; inflows: LineItem[]; outflows: LineItem[];
    totalIn: number; totalOut: number; confirmedIn: number; pipelineIn: number; net: number; runningBalance: number; }

  const weeks: WeekBucket[] = [];
  for (let i = 0; i < 34; i++) {
    const ws = addDays(weekStart, i * 7), we = addDays(ws, 6);
    weeks.push({ weekStart: toISO(ws), weekEnd: toISO(we),
      label: `W${i+1} ${ws.toLocaleDateString("en-GB", { day:"numeric", month:"short", year: i===0 || ws.getMonth()===0 ? "2-digit" : undefined })}`,
      inflows: [], outflows: [], totalIn: 0, totalOut: 0, confirmedIn: 0, pipelineIn: 0, net: 0, runningBalance: 0 });
  }

  function getWeekIndex(d: Date): number {
    return Math.floor((d.getTime() - weekStart.getTime()) / (86400000 * 7));
  }

  for (const inv of invData.Invoices || []) {
    const due = parseXeroDateObj(inv.DueDate); if (!due) continue;
    const wi = getWeekIndex(due); if (wi < 0 || wi >= 34) continue;
    const amount = inv.AmountDue || 0;
    weeks[wi].inflows.push({ ref: inv.InvoiceNumber||"—", contact: inv.Contact?.Name||"—", amount, due: toISO(due), type:"Invoice", source:"xero" });
    weeks[wi].totalIn += amount; weeks[wi].confirmedIn += amount;
  }

  for (const item of spPipeline as any[]) {
    const payDate = new Date(item.paymentDate);
    const wi = getWeekIndex(payDate); if (wi < 0 || wi >= 34) continue;
    weeks[wi].inflows.push({ ref: item.id, contact: item.name, amount: item.price, due: item.paymentDate,
      type: item.status === "Confirmed" ? "Confirmed Event" : "Provisional Event",
      source: "sonderplan", status: item.status, priceFlag: item.priceFlag });
    weeks[wi].totalIn += item.price; weeks[wi].pipelineIn += item.price;
  }

  for (const bill of billData.Invoices || []) {
    const due = parseXeroDateObj(bill.DueDate); if (!due) continue;
    const wi = getWeekIndex(due); if (wi < 0 || wi >= 34) continue;
    const amount = bill.AmountDue || 0;
    weeks[wi].outflows.push({ ref: bill.InvoiceNumber||bill.Reference||"—", contact: bill.Contact?.Name||"—",
      amount, due: toISO(due), type:"Bill", source:"xero" });
    weeks[wi].totalOut += amount;
  }

  const txList = (txData.BankTransactions||[]).filter((tx: any) => tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT");
  const spendGroups: Record<string, { dates: Date[]; amount: number; name: string }> = {};
  const ninetyDaysAgo = addDays(new Date(), -90);
  for (const tx of txList) {
    const d = parseXeroDateObj(tx.Date); if (!d||d<ninetyDaysAgo) continue;
    const name = tx.Contact?.Name||tx.Reference||"Unknown";
    const amount = Math.round((tx.Total||0)/10)*10;
    const key = `${name}__${amount}`;
    if (!spendGroups[key]) spendGroups[key]={dates:[],amount:tx.Total||0,name};
    spendGroups[key].dates.push(d);
  }
  for (const group of Object.values(spendGroups)) {
    if (group.dates.length < 2) continue;
    group.dates.sort((a,b)=>a.getTime()-b.getTime());
    let totalGap=0;
    for (let i=1;i<group.dates.length;i++) totalGap+=(group.dates[i].getTime()-group.dates[i-1].getTime())/86400000;
    const avgGap=totalGap/(group.dates.length-1);
    const isMonthly=avgGap>=20&&avgGap<=40, isWeekly=avgGap>=5&&avgGap<=9;
    if (!isMonthly&&!isWeekly) continue;
    let nextDate=addDays(group.dates[group.dates.length-1],Math.round(avgGap));
    while (nextDate<=weekEnd) {
      const wi=getWeekIndex(nextDate);
      if (wi>=0&&wi<13) { weeks[wi].outflows.push({ref:"Recurring",contact:group.name,amount:group.amount,
        due:toISO(nextDate),type:isMonthly?"Est. Monthly":"Est. Weekly",source:"xero"});weeks[wi].totalOut+=group.amount; }
      nextDate=addDays(nextDate,Math.round(avgGap));
    }
  }

  let openingBalance=0;
  for (const tx of txData.BankTransactions||[]) {
    const d=parseXeroDateObj(tx.Date); if (!d||d>=weekStart) continue;
    const amount=tx.Total||0;
    if (tx.Type==="RECEIVE"||tx.Type==="RECEIVE-OVERPAYMENT") openingBalance+=amount;
    else if (tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT") openingBalance-=amount;
  }

  let running=openingBalance;
  for (const week of weeks) { week.net=week.totalIn-week.totalOut; running+=week.net; week.runningBalance=running; }

  const allPipeline=spPipeline as any[];
  const confirmedTotal  =allPipeline.filter(p=>p.status==="Confirmed").reduce((a,p)=>a+p.price,0);
  const provisionalTotal=allPipeline.filter(p=>p.status==="Provisional").reduce((a,p)=>a+p.price,0);
  const now = new Date();
  const beyondWindow    =allPipeline.filter(p=>{ const wi=getWeekIndex(new Date(p.paymentDate)); return (wi<0&&new Date(p.paymentDate)>=now)||wi>=34; })
    .sort((a,b)=>a.paymentDate.localeCompare(b.paymentDate));

  return Response.json({ openingBalance, generatedAt: new Date().toISOString(),
    forecastFrom: toISO(weekStart), forecastTo: toISO(weekEnd),
    sonderplanConnected: !!env.SONDERPLAN_TOKEN,
    pipeline: { confirmedTotal, provisionalTotal, itemCount: allPipeline.length,
      inWindowCount: allPipeline.length-beyondWindow.length, beyondWindow,
      allItems: allPipeline }, // full list for frontend toggle rebucketing
    weeks }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleCashflow(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const res = await fetch(`${XERO_API_BASE}/BankTransactions`, {
    headers: { Authorization:`Bearer ${tokens.access_token}`, "Xero-tenant-id":tokens.tenant_id, Accept:"application/json" } });
  if (!res.ok) return new Response("Failed: "+await res.text(), { status: 500 });
  const data: any = await res.json();
  const monthly: Record<string,{inflow:number;outflow:number;net:number}> = {};
  for (const tx of data.BankTransactions||[]) {
    const date=parseXeroDate(tx.Date); if (!date) continue;
    if (!monthly[date]) monthly[date]={inflow:0,outflow:0,net:0};
    const amount: number=tx.Total||0;
    if (tx.Type==="RECEIVE"||tx.Type==="RECEIVE-OVERPAYMENT") monthly[date].inflow+=amount;
    else if (tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT") monthly[date].outflow+=amount;
    monthly[date].net=monthly[date].inflow-monthly[date].outflow;
  }
  return Response.json(Object.fromEntries(Object.entries(monthly).sort(([a],[b])=>a.localeCompare(b))),
    { headers: { "Access-Control-Allow-Origin":"*" } });
}

async function handleInvoicesByMonth(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const res = await fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22AUTHORISED%22&order=DueDate+ASC`, {
    headers: { Authorization:`Bearer ${tokens.access_token}`, "Xero-tenant-id":tokens.tenant_id, Accept:"application/json" } });
  if (!res.ok) return new Response("Failed: "+await res.text(), { status: 500 });
  const data: any = await res.json();
  const byMonth: Record<string,{total:number;count:number;overdue:number;invoices:any[]}> = {};
  const now=new Date(); now.setHours(0,0,0,0);
  for (const inv of data.Invoices||[]) {
    const due=parseXeroDateObj(inv.DueDate); if (!due) continue;
    const month=due.toISOString().substring(0,7), amount=inv.AmountDue||0, isOver=due<now;
    if (!byMonth[month]) byMonth[month]={total:0,count:0,overdue:0,invoices:[]};
    byMonth[month].total+=amount; byMonth[month].count+=1;
    if (isOver) byMonth[month].overdue+=amount;
    byMonth[month].invoices.push({ref:inv.InvoiceNumber,contact:inv.Contact?.Name||"—",amount,due:toISO(due),overdue:isOver});
  }
  return Response.json(Object.fromEntries(Object.entries(byMonth).sort(([a],[b])=>a.localeCompare(b))),
    { headers: { "Access-Control-Allow-Origin":"*" } });
}

async function handleCashBurn(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const res = await fetch(`${XERO_API_BASE}/BankTransactions`, {
    headers: { Authorization:`Bearer ${tokens.access_token}`, "Xero-tenant-id":tokens.tenant_id, Accept:"application/json" } });
  if (!res.ok) return new Response("Failed: "+await res.text(), { status: 500 });
  const data: any = await res.json();
  const monthly: Record<string,{spend:number;receive:number;net:number}> = {};
  for (const tx of data.BankTransactions||[]) {
    const date=parseXeroDate(tx.Date); if (!date) continue;
    if (!monthly[date]) monthly[date]={spend:0,receive:0,net:0};
    const amount: number=tx.Total||0;
    if (tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT") monthly[date].spend+=amount;
    else if (tx.Type==="RECEIVE"||tx.Type==="RECEIVE-OVERPAYMENT") monthly[date].receive+=amount;
    monthly[date].net=monthly[date].receive-monthly[date].spend;
  }
  const sorted=Object.entries(monthly).sort(([a],[b])=>a.localeCompare(b));
  let running=0;
  const result: Record<string,any>={};
  for (const [month,vals] of sorted) { running+=vals.net; result[month]={...vals,runningBalance:running}; }
  return Response.json(result, { headers: { "Access-Control-Allow-Origin":"*" } });
}

async function handleProfitAndLoss(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const year=new Date().getFullYear();
  const h={Authorization:`Bearer ${tokens.access_token}`,"Xero-tenant-id":tokens.tenant_id,Accept:"application/json"};
  const [invRes,txRes]=await Promise.all([
    fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22PAID%22&fromDate=${year}-01-01&toDate=${year}-12-31`,{headers:h}),
    fetch(`${XERO_API_BASE}/BankTransactions?fromDate=${year}-01-01&toDate=${year}-12-31`,{headers:h}),
  ]);
  if (!invRes.ok) return new Response("Failed invoices: "+await invRes.text(),{status:500});
  if (!txRes.ok)  return new Response("Failed tx: "+await txRes.text(),{status:500});
  const invData: any=await invRes.json(), txData: any=await txRes.json();
  const months: string[]=[];
  for (let m=1;m<=12;m++) months.push(`${year}-${String(m).padStart(2,"0")}`);
  const pnl: Record<string,{income:number;expenses:number;profit:number}>={};
  for (const m of months) pnl[m]={income:0,expenses:0,profit:0};
  for (const inv of invData.Invoices||[]) {
    const date=parseXeroDate(inv.FullyPaidOnDate)||parseXeroDate(inv.Date);
    if (!date||!pnl[date]) continue; pnl[date].income+=inv.Total||0;
  }
  for (const tx of txData.BankTransactions||[]) {
    const date=parseXeroDate(tx.Date); if (!date||!pnl[date]) continue;
    if (tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT") pnl[date].expenses+=tx.Total||0;
  }
  for (const m of months) pnl[m].profit=pnl[m].income-pnl[m].expenses;
  return Response.json(pnl,{headers:{"Access-Control-Allow-Origin":"*"}});
}

function serveDashboard(): Response {
  return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function serveForecast(): Response {
  return new Response(FORECAST_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Financial Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a26;--border:#2a2a40;--accent:#7c6af7;--accent2:#4ecdc4;--accent3:#ff6b6b;--accent4:#ffd93d;--text:#e8e8f0;--muted:#6b6b8a;--green:#51cf66;--red:#ff6b6b}
body{background:var(--bg);color:var(--text);font-family:'DM Mono',monospace;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:40px 40px;opacity:0.25;pointer-events:none;z-index:0}
.container{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:40px 32px}
header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:48px;padding-bottom:24px;border-bottom:1px solid var(--border)}
.logo-area h1{font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;letter-spacing:-0.03em}
.logo-area h1 span{color:var(--accent)}
.logo-area p{font-size:0.7rem;color:var(--muted);margin-top:4px;letter-spacing:0.1em;text-transform:uppercase}
.header-meta{text-align:right;font-size:0.7rem;color:var(--muted)}
#last-updated{color:var(--accent2);display:block;margin-top:4px}
.nav-link{display:inline-block;margin-top:8px;font-size:0.68rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;border:1px solid var(--accent);padding:5px 12px;border-radius:4px;transition:all 0.2s}
.nav-link:hover{background:var(--accent);color:#fff}
.refresh-btn{background:none;border:1px solid var(--border);color:var(--muted);padding:6px 14px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;margin-top:8px;transition:all 0.2s;display:block}
.refresh-btn:hover{border-color:var(--accent);color:var(--accent)}
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;position:relative;overflow:hidden;opacity:0;transform:translateY(8px);animation:fadeUp 0.4s ease forwards}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.kpi-card:nth-child(1){animation-delay:0.05s}.kpi-card:nth-child(1)::before{background:var(--accent)}
.kpi-card:nth-child(2){animation-delay:0.10s}.kpi-card:nth-child(2)::before{background:var(--accent2)}
.kpi-card:nth-child(3){animation-delay:0.15s}.kpi-card:nth-child(3)::before{background:var(--accent3)}
.kpi-card:nth-child(4){animation-delay:0.20s}.kpi-card:nth-child(4)::before{background:var(--accent4)}
.kpi-label{font-size:0.62rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.kpi-value{font-family:'Syne',sans-serif;font-size:1.85rem;font-weight:700;letter-spacing:-0.02em;line-height:1}
.kpi-sub{font-size:0.68rem;color:var(--muted);margin-top:8px}
.positive{color:var(--green)}.negative{color:var(--red)}.neutral{color:var(--text)}
.section-label{font-size:0.62rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.grid-3-1{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px}
.grid-full{margin-bottom:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.card-title{font-family:'Syne',sans-serif;font-size:0.82rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase}
.card-badge{font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);background:var(--surface2);padding:3px 8px;border-radius:3px;border:1px solid var(--border)}
.chart-wrap{position:relative;height:220px}
.chart-wrap-tall{position:relative;height:260px}
.invoice-scroll{max-height:420px;overflow-y:auto;padding-right:4px}
.invoice-scroll::-webkit-scrollbar{width:3px}
.invoice-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.month-group{margin-bottom:20px}
.month-header{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:8px;cursor:pointer;user-select:none}
.month-name{font-family:'Syne',sans-serif;font-size:0.8rem;font-weight:700;transition:color 0.2s}
.month-header:hover .month-name{color:var(--accent)}
.month-meta{display:flex;align-items:center;gap:12px}
.month-total{font-family:'Syne',sans-serif;font-size:0.85rem;font-weight:700}
.month-count{font-size:0.62rem;color:var(--muted)}
.overdue-flag{font-size:0.58rem;padding:2px 6px;border-radius:3px;background:rgba(255,107,107,0.15);color:var(--red);text-transform:uppercase}
.month-rows{display:none}.month-rows.open{display:block}
.inv-row{display:grid;grid-template-columns:1fr 1.5fr 1fr auto;gap:8px;padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.5);font-size:0.7rem;align-items:center}
.inv-row:last-child{border-bottom:none}
.inv-ref2{color:var(--accent);font-size:0.65rem}
.inv-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inv-amt{font-family:'Syne',sans-serif;font-weight:600;text-align:right}
.inv-due{font-size:0.62rem;color:var(--muted);text-align:right}
.inv-due.overdue{color:var(--red)}
.chevron{font-size:0.7rem;color:var(--muted);transition:transform 0.2s;display:inline-block}
.chevron.open{transform:rotate(90deg)}
.burn-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.burn-stat{background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:14px}
.burn-stat-label{font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}
.burn-stat-value{font-family:'Syne',sans-serif;font-size:1.1rem;font-weight:700}
.loading-text{font-size:0.68rem;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;animation:pulse 1.5s ease-in-out infinite}
.error-text{font-size:0.68rem;color:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes fadeUp{to{opacity:1;transform:translateY(0)}}
@media(max-width:900px){.kpi-row{grid-template-columns:repeat(2,1fr)}.grid-2,.grid-3-1{grid-template-columns:1fr}.burn-stats{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo-area"><h1>Finance<span>.</span></h1><p>Live overview — powered by Xero</p></div>
    <div class="header-meta">
      <span>LAST UPDATED</span><span id="last-updated">—</span>
      <a href="/forecast" class="nav-link">↗ 8-Month Forecast</a>
      <button class="refresh-btn" onclick="loadAll()">↻ Refresh</button>
    </div>
  </header>
  <div class="kpi-row">
    <div class="kpi-card"><div class="kpi-label">Current Month Net</div><div class="kpi-value neutral" id="kpi-net">—</div><div class="kpi-sub" id="kpi-net-sub">Loading…</div></div>
    <div class="kpi-card"><div class="kpi-label">Outstanding Invoices</div><div class="kpi-value neutral" id="kpi-inv-total">—</div><div class="kpi-sub" id="kpi-inv-count">Loading…</div></div>
    <div class="kpi-card"><div class="kpi-label">Overdue Amount</div><div class="kpi-value neutral" id="kpi-overdue">—</div><div class="kpi-sub" id="kpi-overdue-count">Loading…</div></div>
    <div class="kpi-card"><div class="kpi-label">Avg Monthly Burn</div><div class="kpi-value neutral" id="kpi-burn">—</div><div class="kpi-sub" id="kpi-burn-sub">Loading…</div></div>
  </div>
  <div class="section-label">Cash Flow</div>
  <div class="grid-3-1" style="margin-bottom:32px">
    <div class="card"><div class="card-header"><span class="card-title">Monthly In / Out</span><span class="card-badge">Last 12 months</span></div><div class="chart-wrap"><canvas id="cashflowChart"></canvas><div id="cashflow-loading" class="loading-text">Fetching transactions…</div></div></div>
    <div class="card"><div class="card-header"><span class="card-title">In vs Out</span><span class="card-badge" id="donut-label">This month</span></div><div class="chart-wrap"><canvas id="donutChart"></canvas><div id="donut-loading" class="loading-text">Fetching…</div></div></div>
  </div>
  <div class="section-label">Cash Burn</div>
  <div class="grid-full" style="margin-bottom:32px">
    <div class="card">
      <div class="card-header"><span class="card-title">Spend & Running Balance</span><span class="card-badge">All time</span></div>
      <div class="burn-stats">
        <div class="burn-stat"><div class="burn-stat-label">This month spend</div><div class="burn-stat-value negative" id="burn-this-month">—</div></div>
        <div class="burn-stat"><div class="burn-stat-label">Avg monthly spend</div><div class="burn-stat-value neutral" id="burn-avg">—</div></div>
        <div class="burn-stat"><div class="burn-stat-label">Running balance</div><div class="burn-stat-value neutral" id="burn-balance">—</div></div>
      </div>
      <div class="chart-wrap-tall"><canvas id="burnChart"></canvas><div id="burn-loading" class="loading-text">Fetching spend data…</div></div>
    </div>
  </div>
  <div class="section-label">Receivables & Profitability</div>
  <div class="grid-2" style="margin-bottom:32px">
    <div class="card">
      <div class="card-header"><span class="card-title">Unpaid Invoices by Due Month</span><span class="card-badge" id="inv-month-badge">—</span></div>
      <div class="chart-wrap" style="margin-bottom:20px"><canvas id="invMonthChart"></canvas><div id="inv-month-loading" class="loading-text">Fetching invoices…</div></div>
      <div class="invoice-scroll" id="inv-month-list"><div class="loading-text">Loading detail…</div></div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Profit & Loss</span><span class="card-badge">YTD monthly</span></div>
      <div class="chart-wrap-tall"><canvas id="pnlChart"></canvas><div id="pnl-loading" class="loading-text">Fetching data…</div></div>
      <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px" id="pnl-summary"></div>
    </div>
  </div>
</div>
<script>
const fmt=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0}).format(n);
const fmtDec=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',minimumFractionDigits:2}).format(n);
const fmtMo=s=>{try{const[y,m]=s.split('-');return new Date(y,m-1,1).toLocaleDateString('en-GB',{month:'short',year:'2-digit'});}catch(e){return s;}};
Chart.defaults.color='#6b6b8a';Chart.defaults.borderColor='#2a2a40';Chart.defaults.font.family="'DM Mono',monospace";Chart.defaults.font.size=11;
let cashflowChart,donutChart,burnChart,invMonthChart,pnlChart;
async function loadCashflow(){try{const res=await fetch('/api/cashflow');if(!res.ok)throw new Error(await res.text());const data=await res.json();document.getElementById('cashflow-loading')?.remove();document.getElementById('donut-loading')?.remove();const labels=Object.keys(data).slice(-12);const inflow=labels.map(m=>data[m].inflow),outflow=labels.map(m=>data[m].outflow),net=labels.map(m=>data[m].net);const latest=data[labels[labels.length-1]];if(latest){const el=document.getElementById('kpi-net');el.textContent=fmt(latest.net);el.className='kpi-value '+(latest.net>=0?'positive':'negative');document.getElementById('kpi-net-sub').textContent='In '+fmt(latest.inflow)+' / Out '+fmt(latest.outflow);document.getElementById('donut-label').textContent=fmtMo(labels[labels.length-1]);}if(cashflowChart)cashflowChart.destroy();cashflowChart=new Chart(document.getElementById('cashflowChart').getContext('2d'),{type:'bar',data:{labels:labels.map(fmtMo),datasets:[{label:'Inflow',data:inflow,backgroundColor:'rgba(78,205,196,0.7)',borderRadius:3,borderSkipped:false},{label:'Outflow',data:outflow,backgroundColor:'rgba(255,107,107,0.7)',borderRadius:3,borderSkipped:false},{label:'Net',data:net,type:'line',borderColor:'#7c6af7',backgroundColor:'rgba(124,106,247,0.08)',borderWidth:2,pointRadius:3,fill:true,tension:0.3,yAxisID:'y'}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:14}}},scales:{x:{grid:{color:'#2a2a40'}},y:{grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)}}}}});if(donutChart)donutChart.destroy();donutChart=new Chart(document.getElementById('donutChart').getContext('2d'),{type:'doughnut',data:{labels:['Inflow','Outflow'],datasets:[{data:[latest?.inflow||0,latest?.outflow||0],backgroundColor:['rgba(78,205,196,0.85)','rgba(255,107,107,0.85)'],borderColor:'#12121a',borderWidth:3,hoverOffset:8}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{position:'bottom',labels:{boxWidth:10,padding:14}},tooltip:{callbacks:{label:ctx=>' '+fmt(ctx.raw)}}}}});}catch(e){const el=document.getElementById('cashflow-loading');if(el){el.textContent='Error: '+e.message;el.className='error-text';}}}
async function loadCashBurn(){try{const res=await fetch('/api/cashburn');if(!res.ok)throw new Error(await res.text());const data=await res.json();document.getElementById('burn-loading')?.remove();const months=Object.keys(data),spend=months.map(m=>data[m].spend),balance=months.map(m=>data[m].runningBalance),latest=data[months[months.length-1]];const last6=spend.slice(-6),avg=last6.reduce((a,b)=>a+b,0)/(last6.length||1);document.getElementById('burn-this-month').textContent=fmt(latest?.spend||0);document.getElementById('burn-avg').textContent=fmt(avg);const bal=latest?.runningBalance||0,balEl=document.getElementById('burn-balance');balEl.textContent=fmt(bal);balEl.className='burn-stat-value '+(bal>=0?'positive':'negative');document.getElementById('kpi-burn').textContent=fmt(avg);document.getElementById('kpi-burn').className='kpi-value negative';document.getElementById('kpi-burn-sub').textContent='6-month average';if(burnChart)burnChart.destroy();burnChart=new Chart(document.getElementById('burnChart').getContext('2d'),{type:'bar',data:{labels:months.map(fmtMo),datasets:[{label:'Monthly Spend',data:spend,backgroundColor:'rgba(255,107,107,0.6)',borderRadius:3,borderSkipped:false,yAxisID:'y'},{label:'Running Balance',data:balance,type:'line',borderColor:'#ffd93d',backgroundColor:'rgba(255,217,61,0.06)',borderWidth:2,pointRadius:2,fill:true,tension:0.3,yAxisID:'y1'}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:14}}},scales:{x:{grid:{color:'#2a2a40'}},y:{grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)},title:{display:true,text:'Spend',color:'#6b6b8a',font:{size:10}}},y1:{position:'right',grid:{display:false},ticks:{callback:v=>fmt(v)},title:{display:true,text:'Balance',color:'#6b6b8a',font:{size:10}}}}}});}catch(e){const el=document.getElementById('burn-loading');if(el){el.textContent='Error: '+e.message;el.className='error-text';}}}
async function loadInvoicesByMonth(){try{const res=await fetch('/api/invoices-by-month');if(!res.ok)throw new Error(await res.text());const data=await res.json();document.getElementById('inv-month-loading')?.remove();const months=Object.keys(data),totals=months.map(m=>data[m].total),overdueTot=months.map(m=>data[m].overdue);const totalAll=totals.reduce((a,b)=>a+b,0),totalOv=overdueTot.reduce((a,b)=>a+b,0);const countAll=months.reduce((a,m)=>a+data[m].count,0),countOv=months.reduce((a,m)=>a+data[m].invoices.filter(i=>i.overdue).length,0);document.getElementById('kpi-inv-total').textContent=fmt(totalAll);document.getElementById('kpi-inv-total').className='kpi-value neutral';document.getElementById('kpi-inv-count').textContent=countAll+' invoices outstanding';const ovEl=document.getElementById('kpi-overdue');ovEl.textContent=fmt(totalOv);ovEl.className='kpi-value '+(totalOv>0?'negative':'positive');document.getElementById('kpi-overdue-count').textContent=countOv+' invoice'+(countOv!==1?'s':'')+' overdue';document.getElementById('inv-month-badge').textContent=months.length+' months';if(invMonthChart)invMonthChart.destroy();invMonthChart=new Chart(document.getElementById('invMonthChart').getContext('2d'),{type:'bar',data:{labels:months.map(fmtMo),datasets:[{label:'Overdue',data:overdueTot,backgroundColor:'rgba(255,107,107,0.75)',borderRadius:3,borderSkipped:false},{label:'On track',data:totals.map((t,i)=>t-overdueTot[i]),backgroundColor:'rgba(78,205,196,0.6)',borderRadius:3,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:14}},tooltip:{callbacks:{footer:items=>'Total: '+fmt(items.reduce((a,i)=>a+i.raw,0))}}},scales:{x:{stacked:true,grid:{color:'#2a2a40'}},y:{stacked:true,grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)}}}}});const listHtml=months.map((month,idx)=>{const d=data[month],hasOv=d.overdue>0;const rows=d.invoices.map(inv=>'<div class="inv-row"><span class="inv-ref2">'+inv.ref+'</span><span class="inv-name">'+inv.contact+'</span><span class="inv-amt">'+fmtDec(inv.amount)+'</span><span class="inv-due'+(inv.overdue?' overdue':'')+'">'+inv.due+'</span></div>').join('');const open=idx===0?' open':'';return'<div class="month-group"><div class="month-header" onclick="toggleMonth(this)"><div style="display:flex;align-items:center;gap:10px"><span class="chevron'+(idx===0?' open':'')+'">&#9654;</span><span class="month-name">'+fmtMo(month)+'</span></div><div class="month-meta">'+(hasOv?'<span class="overdue-flag">'+fmt(d.overdue)+' overdue</span>':'')+'<span class="month-count">'+d.count+' inv</span><span class="month-total">'+fmt(d.total)+'</span></div></div><div class="month-rows'+open+'">'+rows+'</div></div>';}).join('');document.getElementById('inv-month-list').innerHTML=listHtml||'<div style="color:var(--muted);font-size:0.7rem">No outstanding invoices</div>';}catch(e){const el=document.getElementById('inv-month-loading');if(el){el.textContent='Error: '+e.message;el.className='error-text';}document.getElementById('inv-month-list').innerHTML='<div class="error-text">'+e.message+'</div>';}}
function toggleMonth(h){const r=h.nextElementSibling,c=h.querySelector('.chevron'),o=r.classList.toggle('open');c.classList.toggle('open',o);}
async function loadPnL(){try{const res=await fetch('/api/pnl');if(!res.ok)throw new Error(await res.text());const data=await res.json();document.getElementById('pnl-loading')?.remove();const months=Object.keys(data),income=months.map(m=>data[m].income),expenses=months.map(m=>data[m].expenses),profit=months.map(m=>data[m].profit);const ytdI=income.reduce((a,b)=>a+b,0),ytdE=expenses.reduce((a,b)=>a+b,0),ytdP=ytdI-ytdE;document.getElementById('pnl-summary').innerHTML='<div class="burn-stat"><div class="burn-stat-label">YTD Revenue</div><div class="burn-stat-value positive">'+fmt(ytdI)+'</div></div><div class="burn-stat"><div class="burn-stat-label">YTD Costs</div><div class="burn-stat-value negative">'+fmt(ytdE)+'</div></div><div class="burn-stat"><div class="burn-stat-label">YTD Profit</div><div class="burn-stat-value '+(ytdP>=0?'positive':'negative')+'">'+fmt(ytdP)+'</div></div>';if(pnlChart)pnlChart.destroy();pnlChart=new Chart(document.getElementById('pnlChart').getContext('2d'),{type:'line',data:{labels:months.map(fmtMo),datasets:[{label:'Income',data:income,borderColor:'rgba(78,205,196,0.9)',backgroundColor:'rgba(78,205,196,0.07)',borderWidth:2,pointRadius:3,fill:true,tension:0.3},{label:'Expenses',data:expenses,borderColor:'rgba(255,107,107,0.9)',backgroundColor:'rgba(255,107,107,0.07)',borderWidth:2,pointRadius:3,fill:true,tension:0.3},{label:'Net Profit',data:profit,borderColor:'#7c6af7',backgroundColor:'transparent',borderWidth:2,pointRadius:3,borderDash:[4,4],tension:0.3}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:14}}},scales:{x:{grid:{color:'#2a2a40'}},y:{grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)}}}}});}catch(e){const el=document.getElementById('pnl-loading');if(el){el.textContent='Error: '+e.message;el.className='error-text';}}}
async function loadAll(){document.getElementById('last-updated').textContent='Loading…';await Promise.all([loadCashflow(),loadCashBurn(),loadInvoicesByMonth(),loadPnL()]);document.getElementById('last-updated').textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});}
loadAll();
</script>
</body></html>
`;
const FORECAST_HTML  = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>8-Month Cash Flow Forecast</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a26;--border:#2a2a40;--accent:#7c6af7;--accent2:#4ecdc4;--accent3:#ff6b6b;--accent4:#ffd93d;--text:#e8e8f0;--muted:#6b6b8a;--green:#51cf66;--red:#ff6b6b}
body{background:var(--bg);color:var(--text);font-family:'DM Mono',monospace;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:40px 40px;opacity:0.25;pointer-events:none;z-index:0}
.container{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:40px 32px}
header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid var(--border)}
.logo-area h1{font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;letter-spacing:-0.03em}
.logo-area h1 span{color:var(--accent)}
.logo-area p{font-size:0.7rem;color:var(--muted);margin-top:4px;letter-spacing:0.1em;text-transform:uppercase}
.nav-link{display:inline-block;font-size:0.68rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;border:1px solid var(--accent);padding:5px 12px;border-radius:4px;transition:all 0.2s}
.nav-link:hover{background:var(--accent);color:#fff}
.pipeline-banner{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px;padding:16px;background:rgba(124,106,247,0.08);border:1px solid rgba(124,106,247,0.3);border-radius:8px}
.pipeline-stat{text-align:center}
.pipeline-stat-label{font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.pipeline-stat-value{font-family:'Syne',sans-serif;font-size:1.1rem;font-weight:700}
.sp-badge{font-size:0.58rem;padding:2px 7px;border-radius:3px;background:rgba(124,106,247,0.2);color:var(--accent);letter-spacing:0.08em;text-transform:uppercase;margin-left:6px}
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;position:relative;overflow:hidden;opacity:0;transform:translateY(8px);animation:fadeUp 0.4s ease forwards}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.kpi-card:nth-child(1){animation-delay:0.05s}.kpi-card:nth-child(1)::before{background:var(--accent)}
.kpi-card:nth-child(2){animation-delay:0.10s}.kpi-card:nth-child(2)::before{background:var(--accent2)}
.kpi-card:nth-child(3){animation-delay:0.15s}.kpi-card:nth-child(3)::before{background:var(--accent3)}
.kpi-card:nth-child(4){animation-delay:0.20s}.kpi-card:nth-child(4)::before{background:var(--accent4)}
.kpi-label{font-size:0.62rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.kpi-value{font-family:'Syne',sans-serif;font-size:1.7rem;font-weight:700;letter-spacing:-0.02em;line-height:1}
.kpi-sub{font-size:0.65rem;color:var(--muted);margin-top:6px}
.positive{color:var(--green)}.negative{color:var(--red)}.neutral{color:var(--text)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:16px}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.card-title{font-family:'Syne',sans-serif;font-size:0.82rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase}
.card-badge{font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);background:var(--surface2);padding:3px 8px;border-radius:3px;border:1px solid var(--border)}
.chart-wrap{position:relative;height:280px}
.section-label{font-size:0.62rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.week-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px;margin-bottom:24px}
.week-col{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 6px;cursor:pointer;transition:border-color 0.2s}
.week-col:hover,.week-col.active{border-color:var(--accent)}
.week-col.danger{border-color:rgba(255,107,107,0.5)}
.week-col.danger .week-balance{color:var(--red)}
.week-label{font-size:0.55rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;white-space:nowrap}
.week-in{font-size:0.62rem;color:var(--green);margin-bottom:2px}
.week-pipeline{font-size:0.58rem;color:var(--accent);margin-bottom:2px}
.week-out{font-size:0.62rem;color:var(--red);margin-bottom:5px}
.week-net{font-family:'Syne',sans-serif;font-size:0.78rem;font-weight:700;margin-bottom:3px}
.week-balance{font-size:0.58rem;color:var(--muted);padding-top:4px;border-top:1px solid var(--border)}
.net-positive{color:var(--green)}.net-negative{color:var(--red)}.net-zero{color:var(--muted)}
.detail-panel{background:var(--surface);border:1px solid var(--accent);border-radius:8px;padding:24px;margin-bottom:24px;display:none}
.detail-panel.visible{display:block}
.detail-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.detail-title{font-family:'Syne',sans-serif;font-size:1rem;font-weight:700}
.detail-close{background:none;border:1px solid var(--border);color:var(--muted);padding:4px 10px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;font-size:0.65rem}
.detail-cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.detail-section-title{font-size:0.62rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.detail-row{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.4);font-size:0.7rem;align-items:center}
.detail-row:last-child{border-bottom:none}
.dr-ref{color:var(--accent);font-size:0.62rem;white-space:nowrap}
.dr-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-amt{font-family:'Syne',sans-serif;font-weight:600;text-align:right;white-space:nowrap}
.dr-type{font-size:0.55rem;padding:2px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap}
.type-invoice{background:rgba(78,205,196,0.15);color:var(--accent2)}
.type-bill{background:rgba(255,107,107,0.15);color:var(--red)}
.type-monthly{background:rgba(255,217,61,0.15);color:var(--accent4)}
.type-weekly{background:rgba(124,106,247,0.15);color:var(--accent)}
.type-confirmed{background:rgba(167,139,250,0.2);color:#a78bfa}
.type-provisional{background:rgba(99,102,241,0.2);color:#818cf8}
.empty-state{font-size:0.7rem;color:var(--muted);padding:12px 0}
.beyond-table{width:100%;border-collapse:collapse;font-size:0.7rem;margin-top:8px}
.beyond-table th{text-align:left;font-size:0.58rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);padding:0 0 8px;border-bottom:1px solid var(--border);font-weight:400}
.beyond-table td{padding:8px 0;border-bottom:1px solid rgba(42,42,64,0.4)}
.beyond-table tr:last-child td{border-bottom:none}
.beyond-scroll{max-height:300px;overflow-y:auto}
.beyond-scroll::-webkit-scrollbar{width:3px}
.beyond-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.toggle-bar{display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap}
.toggle-divider{width:1px;height:20px;background:var(--border);margin:0 4px}
.toggle-label{font-size:0.65rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);margin-right:4px}
.toggle-btn{background:var(--surface);border:1px solid var(--border);color:var(--muted);padding:7px 16px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;font-size:0.68rem;letter-spacing:0.08em;transition:all 0.2s}
.toggle-btn:hover{border-color:var(--accent);color:var(--accent)}
.toggle-btn.active{background:var(--accent);border-color:var(--accent);color:#fff}
.loading-overlay{display:flex;align-items:center;justify-content:center;height:300px}
.loading-text{font-size:0.68rem;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;animation:pulse 1.5s ease-in-out infinite}
.error-text{font-size:0.68rem;color:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes fadeUp{to{opacity:1;transform:translateY(0)}}
@media(max-width:1100px){.week-grid{grid-template-columns:repeat(7,1fr)}}
@media(max-width:700px){.kpi-row{grid-template-columns:repeat(2,1fr)}.week-grid{grid-template-columns:repeat(4,1fr)}.detail-cols{grid-template-columns:1fr}.pipeline-banner{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo-area"><h1>Forecast<span>.</span></h1><p>8-month cash flow — Xero + Sonderplan</p></div>
    <a href="/dashboard" class="nav-link">← Dashboard</a>
  </header>
  <div id="loading-state" class="loading-overlay"><div class="loading-text">Building forecast…</div></div>
  <div id="forecast-content" style="display:none">
    <div class="pipeline-banner">
      <div class="pipeline-stat"><div class="pipeline-stat-label">Confirmed Pipeline <span class="sp-badge">Sonderplan</span></div><div class="pipeline-stat-value positive" id="sp-confirmed">—</div></div>
      <div class="pipeline-stat"><div class="pipeline-stat-label">Provisional Pipeline <span class="sp-badge">Sonderplan</span></div><div class="pipeline-stat-value neutral" id="sp-provisional">—</div></div>
      <div class="pipeline-stat"><div class="pipeline-stat-label">Pipeline Events This Year</div><div class="pipeline-stat-value neutral" id="sp-count">—</div></div>
    </div>
    <!-- Pipeline date toggle -->
    <div class="toggle-bar">
      <span class="toggle-label">Pipeline by:</span>
      <button class="toggle-btn active" id="btn-payment" onclick="setMode('payment')">Payment Date</button>
      <button class="toggle-btn" id="btn-event" onclick="setMode('event')">Event Date</button>
      <span style="font-size:0.62rem;color:var(--muted);margin-left:8px" id="toggle-hint">Showing when cash is expected (1 month before event)</span>
    </div>

    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">Opening Balance</div><div class="kpi-value neutral" id="kpi-opening">—</div><div class="kpi-sub">This week</div></div>
      <div class="kpi-card"><div class="kpi-label">Confirmed Inflows</div><div class="kpi-value positive" id="kpi-confirmed">—</div><div class="kpi-sub" id="kpi-confirmed-sub">Xero invoices due</div></div>
      <div class="kpi-card"><div class="kpi-label">Pipeline in Window</div><div class="kpi-value neutral" id="kpi-pipeline">—</div><div class="kpi-sub" id="kpi-pipeline-sub">Sonderplan events</div></div>
      <div class="kpi-card"><div class="kpi-label">Closing Balance</div><div class="kpi-value neutral" id="kpi-closing">—</div><div class="kpi-sub">End of month 8</div></div>
    </div>
    <!-- Best / worst case toggle -->
    <div class="toggle-bar" style="margin-bottom:24px">
      <span class="toggle-label">Chart view:</span>
      <button class="toggle-btn active" id="btn-best" onclick="setCaseMode('best')">Best Case</button>
      <button class="toggle-btn" id="btn-worst" onclick="setCaseMode('worst')">Confirmed Only</button>
      <div class="toggle-divider"></div>
      <span style="font-size:0.62rem;color:var(--muted)" id="case-hint">Including confirmed + provisional pipeline</span>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">Weekly Cash Position</span><span class="card-badge" id="chart-badge">8-month rolling forecast</span></div>
      <div class="chart-wrap"><canvas id="forecastChart"></canvas></div>
    </div>
    <div class="section-label" style="margin-top:8px">Weekly Breakdown — click any week for detail</div>
    <div class="week-grid" id="week-grid"></div>
    <div class="detail-panel" id="detail-panel">
      <div class="detail-header"><span class="detail-title" id="detail-title">Week detail</span><button class="detail-close" onclick="closeDetail()">✕ Close</button></div>
      <div class="detail-cols">
        <div><div class="detail-section-title" id="detail-in-title">Inflows</div><div id="detail-inflows"></div></div>
        <div><div class="detail-section-title" id="detail-out-title">Outflows</div><div id="detail-outflows"></div></div>
      </div>
    </div>
    <div class="section-label">Pipeline Beyond Forecast Window</div>
    <div class="card">
      <div class="card-header"><span class="card-title">Upcoming Events</span><span class="card-badge" id="beyond-badge">—</span></div>
      <div class="beyond-scroll"><table class="beyond-table"><thead><tr><th>Event</th><th>Status</th><th>Event Date</th><th>Est. Payment</th><th style="text-align:right">Amount</th><th>Flag</th></tr></thead><tbody id="beyond-tbody"></tbody></table></div>
    </div>
  </div>
</div>
<script>
const fmt=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0}).format(n);
const fmtDec=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',minimumFractionDigits:2}).format(n);
Chart.defaults.color='#6b6b8a';Chart.defaults.borderColor='#2a2a40';Chart.defaults.font.family="'DM Mono',monospace";Chart.defaults.font.size=11;
let forecastData=null;
function typeClass(t){if(t==='Invoice')return'type-invoice';if(t==='Bill')return'type-bill';if(t==='Est. Monthly')return'type-monthly';if(t==='Est. Weekly')return'type-weekly';if(t==='Confirmed Event')return'type-confirmed';return'type-provisional';}
function renderDetail(wi){
  const week=forecastData.weeks[wi];
  document.querySelectorAll('.week-col').forEach((c,i)=>c.classList.toggle('active',i===wi));
  const panel=document.getElementById('detail-panel');panel.classList.add('visible');
  document.getElementById('detail-title').textContent=week.label+' ('+week.weekStart+' \\u2192 '+week.weekEnd+')';
  const xeroIn=week.inflows.filter(i=>i.source==='xero'),spIn=week.inflows.filter(i=>i.source==='sonderplan');
  document.getElementById('detail-in-title').textContent='Inflows \\u2014 '+fmt(week.totalIn)+(week.pipelineIn>0?' ('+fmt(week.confirmedIn)+' confirmed + '+fmt(week.pipelineIn)+' pipeline)':'');
  const makeRow=i=>'<div class="detail-row"><span class="dr-ref">'+i.ref+'</span><span class="dr-name">'+i.contact+(i.priceFlag&&i.priceFlag!=='Clean'?' <span style="color:var(--muted);font-size:0.58rem">['+i.priceFlag+']</span>':'')+'</span><span class="dr-amt">'+fmtDec(i.amount)+'</span><span class="dr-type '+typeClass(i.type)+'">'+i.type+'</span></div>';
  let inHtml='';
  if(xeroIn.length){inHtml+='<div style="font-size:0.6rem;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px">Confirmed (Xero)</div>';inHtml+=xeroIn.map(makeRow).join('');}
  if(spIn.length){inHtml+='<div style="font-size:0.6rem;color:var(--accent);letter-spacing:0.1em;text-transform:uppercase;margin:'+(xeroIn.length?'12px':'0')+'px 0 6px">Pipeline (Sonderplan)</div>';inHtml+=spIn.map(makeRow).join('');}
  if(!inHtml)inHtml='<div class="empty-state">No inflows this week</div>';
  document.getElementById('detail-inflows').innerHTML=inHtml;
  document.getElementById('detail-out-title').textContent='Outflows \\u2014 '+fmt(week.totalOut);
  document.getElementById('detail-outflows').innerHTML=week.outflows.length?week.outflows.map(makeRow).join(''):'<div class="empty-state">No outflows this week</div>';
  panel.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function closeDetail(){document.getElementById('detail-panel').classList.remove('visible');document.querySelectorAll('.week-col').forEach(c=>c.classList.remove('active'));}
let currentMode = 'payment'; // 'payment' or 'event'
let currentCase  = 'best';    // 'best' (all pipeline) or 'worst' (confirmed only)

function setMode(mode) {
  currentMode = mode;
  document.getElementById('btn-payment').classList.toggle('active', mode==='payment');
  document.getElementById('btn-event').classList.toggle('active', mode==='event');
  document.getElementById('toggle-hint').textContent = mode==='payment'
    ? 'Showing when cash is expected (1 month before event)'
    : 'Showing when the event actually happens';
  if (forecastData) rebuildWithMode(forecastData, mode);
}

function setCaseMode(mode) {
  currentCase = mode;
  document.getElementById('btn-best').classList.toggle('active', mode==='best');
  document.getElementById('btn-worst').classList.toggle('active', mode==='worst');
  document.getElementById('case-hint').textContent = mode==='best'
    ? 'Including confirmed + provisional pipeline'
    : 'Confirmed pipeline only — provisional excluded';
  document.getElementById('chart-badge').textContent = mode==='best'
    ? '8-month rolling forecast — best case'
    : '8-month rolling forecast — confirmed only';
  if (forecastData) rebuildWithMode(forecastData, currentMode);
}

function getWeekIndex(dateStr, forecastFrom) {
  const d = new Date(dateStr);
  const start = new Date(forecastFrom);
  return Math.floor((d.getTime() - start.getTime()) / (86400000 * 7));
}

function rebuildWithMode(data, mode) {
  const weeks = JSON.parse(JSON.stringify(data.weeks)); // deep copy
  // Clear pipeline from all weeks
  for (const w of weeks) {
    w.inflows    = w.inflows.filter(i => i.source !== 'sonderplan');
    w.totalIn    = w.inflows.reduce((a,i) => a+i.amount, 0) + w.confirmedIn;
    w.pipelineIn = 0;
  }
  // Re-bucket pipeline items using selected date and case mode
  const allItems = (data.pipeline.allItems || []).filter(item => {
    if (currentCase === 'worst') return item.status === 'Confirmed';
    return true; // best case: include all
  });
  for (const item of allItems) {
    const dateStr = mode === 'event' ? item.eventStart : item.paymentDate;
    const wi = getWeekIndex(dateStr, data.forecastFrom);
    if (wi < 0 || wi >= 34) continue;
    weeks[wi].inflows.push({
      ref: item.id, contact: item.name, amount: item.price,
      due: dateStr, type: item.status === 'Confirmed' ? 'Confirmed Event' : 'Provisional Event',
      source: 'sonderplan', status: item.status, priceFlag: item.priceFlag,
    });
    weeks[wi].totalIn    += item.price;
    weeks[wi].pipelineIn += item.price;
  }
  // Recalculate net and running balance
  let running = data.openingBalance;
  for (const w of weeks) {
    w.net = w.totalIn - w.totalOut;
    running += w.net;
    w.runningBalance = running;
  }
  // Ensure content is visible before rendering chart
  document.getElementById('loading-state').style.display='none';
  document.getElementById('forecast-content').style.display='block';
  renderForecast(data, weeks);
}

async function loadForecast(){
  try{
    const res=await fetch('/api/forecast');if(!res.ok)throw new Error(await res.text());
    forecastData=await res.json();
    // Show content and render via rebuildWithMode so toggles work correctly
    rebuildWithMode(forecastData, currentMode);
  }catch(e){document.getElementById('loading-state').innerHTML='<div class="error-text">Error: '+e.message+'</div>';}
}

function renderForecast(data, weeks) {
  const forecastData = data; // local alias
    const totalConfirmedIn=weeks.reduce((a,w)=>a+w.confirmedIn,0);
    const totalPipelineIn=weeks.reduce((a,w)=>a+w.pipelineIn,0);
    const closing=weeks[weeks.length-1].runningBalance;
    document.getElementById('sp-confirmed').textContent=fmt(forecastData.pipeline.confirmedTotal);
    document.getElementById('sp-provisional').textContent=fmt(forecastData.pipeline.provisionalTotal);
    document.getElementById('sp-count').textContent=forecastData.pipeline.itemCount+' events ('+forecastData.pipeline.inWindowCount+' in window)';
    const opEl=document.getElementById('kpi-opening');opEl.textContent=fmt(forecastData.openingBalance);opEl.className='kpi-value '+(forecastData.openingBalance>=0?'positive':'negative');
    document.getElementById('kpi-confirmed').textContent=fmt(totalConfirmedIn);
    document.getElementById('kpi-confirmed-sub').textContent=weeks.reduce((a,w)=>a+w.inflows.filter(i=>i.source==='xero').length,0)+' invoice items';
    document.getElementById('kpi-pipeline').textContent=fmt(totalPipelineIn);
    document.getElementById('kpi-pipeline').style.color = currentCase==='worst' ? 'var(--accent2)' : '';
    document.getElementById('kpi-pipeline-sub').textContent=weeks.reduce((a,w)=>a+w.inflows.filter(i=>i.source==='sonderplan').length,0)+' pipeline events in window';
    const clEl=document.getElementById('kpi-closing');clEl.textContent=fmt(closing);clEl.className='kpi-value '+(closing>=0?'positive':'negative');
    if(window._forecastChart) window._forecastChart.destroy();
    window._forecastChart = new Chart(document.getElementById('forecastChart').getContext('2d'),{type:'bar',data:{labels:weeks.map(w=>w.label),datasets:[{label:'Confirmed In (Xero)',data:weeks.map(w=>w.confirmedIn),backgroundColor:'rgba(78,205,196,0.75)',borderRadius:0,borderSkipped:false,stack:'in'},{label:'Pipeline In (Sonderplan)',data:weeks.map(w=>w.pipelineIn),backgroundColor:'rgba(124,106,247,0.6)',borderRadius:3,borderSkipped:false,stack:'in'},{label:'Outflows',data:weeks.map(w=>w.totalOut),backgroundColor:'rgba(255,107,107,0.65)',borderRadius:3,borderSkipped:false,stack:'out'},{label:'Balance',data:weeks.map(w=>w.runningBalance),type:'line',borderColor:'#ffd93d',backgroundColor:'rgba(255,217,61,0.05)',borderWidth:2,pointRadius:4,pointBackgroundColor:weeks.map(w=>w.runningBalance>=0?'#ffd93d':'#ff6b6b'),fill:true,tension:0.3,yAxisID:'y1',stack:undefined}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:12}},tooltip:{callbacks:{afterBody:items=>{const wi=items[0].dataIndex;return['Net: '+fmt(weeks[wi].net),'  Confirmed: '+fmt(weeks[wi].confirmedIn),'  Pipeline: '+fmt(weeks[wi].pipelineIn)];}}}},scales:{x:{grid:{color:'#2a2a40'}},y:{grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)},title:{display:true,text:'In / Out',color:'#6b6b8a',font:{size:10}},stacked:true},y1:{position:'right',grid:{display:false},ticks:{callback:v=>fmt(v)},title:{display:true,text:'Balance',color:'#6b6b8a',font:{size:10}}}}}});
    document.getElementById('week-grid').innerHTML=weeks.map((w,i)=>{const danger=w.runningBalance<0;const netClass=w.net>0?'net-positive':w.net<0?'net-negative':'net-zero';return'<div class="week-col'+(danger?' danger':'')+'" onclick="renderDetail('+i+')"><div class="week-label">'+w.label+'</div><div class="week-in">\\u2191 '+fmt(w.confirmedIn)+'</div>'+(w.pipelineIn>0?'<div class="week-pipeline">\\u25C6 '+fmt(w.pipelineIn)+'</div>':'')+'<div class="week-out">\\u2193 '+fmt(w.totalOut)+'</div><div class="week-net '+netClass+'">'+(w.net>=0?'+':'')+fmt(w.net)+'</div><div class="week-balance">Bal '+fmt(w.runningBalance)+'</div></div>';}).join('');
    const firstActive=weeks.findIndex(w=>w.inflows.length>0||w.outflows.length>0);
    if(firstActive>=0)renderDetail(firstActive);
    const beyond=forecastData.pipeline.beyondWindow||[];
    document.getElementById('beyond-badge').textContent=beyond.length+' events';
    const flagColour=f=>f==='Clean'?'var(--green)':f==='FOC'?'var(--muted)':f==='No Quote'?'var(--red)':'var(--accent4)';
    document.getElementById('beyond-tbody').innerHTML=beyond.length
      ?beyond.map(p=>'<tr><td>'+p.name+'</td><td><span style="font-size:0.6rem;padding:2px 6px;border-radius:3px;background:rgba(124,106,247,0.15);color:var(--accent)">'+p.status+'</span></td><td>'+p.eventStart+'</td><td>'+p.paymentDate+'</td><td style="text-align:right;font-family:Syne,sans-serif;font-weight:600">'+fmtDec(p.price)+'</td><td style="color:'+flagColour(p.priceFlag)+';font-size:0.62rem">'+p.priceFlag+'</td></tr>').join('')
      :'<tr><td colspan="6" style="color:var(--muted);padding:12px 0">No pipeline events beyond the forecast window</td></tr>';
} // end renderForecast

loadForecast();
</script>
</body></html>
`;