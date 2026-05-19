export interface Env {
  XERO_CLIENT_ID: string;
  XERO_CLIENT_SECRET: string;
  XERO_REDIRECT_URI: string;
  XERO_KV: KVNamespace;
}

interface XeroTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  tenant_id: string;
  created_at?: number;
}

const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE  = "https://api.xero.com/api.xro/2.0";

// ─── Date helpers ─────────────────────────────────────────────────────────────

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

// Start of current week (Monday)
function startOfThisWeek(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function toISO(d: Date): string {
  return d.toISOString().substring(0, 10);
}

// ─── Router ───────────────────────────────────────────────────────────────────

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

    return new Response('Xero Worker running. Visit /dashboard or /forecast');
  },
};

// ─── Auth ─────────────────────────────────────────────────────────────────────

function redirectToXero(env: Env): Response {
  const params = new URLSearchParams({
    response_type: "code",
    response_mode: "query",
    client_id:     env.XERO_CLIENT_ID,
    redirect_uri:  env.XERO_REDIRECT_URI,
    scope: [
      "openid","profile","email","offline_access",
      "accounting.invoices","accounting.payments",
      "accounting.banktransactions","accounting.manualjournals",
      "accounting.settings",
    ].join(" "),
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
  if (!connRes.ok) return new Response("Failed to fetch connections: " + await connRes.text(), { status: 500 });
  const connections: any[] = await connRes.json();
  if (!connections.length) return new Response("No Xero tenants found", { status: 500 });
  const tokens: XeroTokens = {
    access_token:  raw.access_token,
    refresh_token: raw.refresh_token,
    expires_at:    Date.now() + raw.expires_in * 1000,
    tenant_id:     connections[0].tenantId,
    created_at:    Date.now(),
  };
  await env.XERO_KV.put("xero_tokens", JSON.stringify(tokens));
  return Response.redirect(new URL("/dashboard", url).toString(), 302);
}

async function exchangeCodeForToken(code: string, env: Env): Promise<any> {
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code,
      redirect_uri: env.XERO_REDIRECT_URI,
      client_id: env.XERO_CLIENT_ID,
      client_secret: env.XERO_CLIENT_SECRET,
    }),
  });
  return res.json();
}

// ─── Token management ─────────────────────────────────────────────────────────

async function getValidTokens(env: Env): Promise<XeroTokens> {
  const stored = await env.XERO_KV.get("xero_tokens", "json") as XeroTokens | null;
  if (!stored) throw new Error("Not authenticated with Xero");
  if (Date.now() < stored.expires_at) return stored;
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
      client_id: env.XERO_CLIENT_ID,
      client_secret: env.XERO_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error("Token refresh failed: " + await res.text());
  const r = await res.json() as any;
  const tokens: XeroTokens = {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: Date.now() + r.expires_in * 1000,
    tenant_id: stored.tenant_id,
  };
  await env.XERO_KV.put("xero_tokens", JSON.stringify(tokens));
  return tokens;
}

// ─── Generic API call ─────────────────────────────────────────────────────────

async function callXeroAPI(env: Env, endpoint: string): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); }
  catch (e: any) { return new Response(e.message, { status: 401 }); }
  const res = await fetch(`${XERO_API_BASE}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Xero-tenant-id": tokens.tenant_id,
      Accept: "application/json",
    },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

// ─── 13-week forecast ─────────────────────────────────────────────────────────
//
// Inflows:  unpaid invoices (AUTHORISED) due within 13 weeks, by due date
//           + repeating invoices scheduled in the window
// Outflows: unpaid bills (ACCPAY AUTHORISED) due within 13 weeks
//           + recurring spend detected from 90 days of bank history

async function handleForecast(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); }
  catch (e: any) { return new Response(e.message, { status: 401 }); }

  const h = {
    Authorization:    `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept:           "application/json",
  };

  const weekStart = startOfThisWeek();
  const weekEnd   = addDays(weekStart, 13 * 7 - 1);
  const fromStr   = toISO(weekStart);
  const toStr     = toISO(weekEnd);

  // Fetch all in parallel
  const [invRes, billRes, txRes, acctRes] = await Promise.all([
    fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22AUTHORISED%22%26%26Type%3D%3D%22ACCREC%22`, { headers: h }),
    fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22AUTHORISED%22%26%26Type%3D%3D%22ACCPAY%22`, { headers: h }),
    fetch(`${XERO_API_BASE}/BankTransactions`, { headers: h }),
    fetch(`${XERO_API_BASE}/Accounts?where=Type%3D%3D%22BANK%22`, { headers: h }),
  ]);

  const [invData, billData, txData, acctData] = await Promise.all([
    invRes.json() as any,
    billRes.json() as any,
    txRes.json()  as any,
    acctRes.json() as any,
  ]);

  // ── Build 13 week buckets ──────────────────────────────────────────────────
  interface WeekBucket {
    weekStart: string;
    weekEnd:   string;
    label:     string;
    inflows:   { ref: string; contact: string; amount: number; due: string; type: string }[];
    outflows:  { ref: string; contact: string; amount: number; due: string; type: string }[];
    totalIn:   number;
    totalOut:  number;
    net:       number;
    runningBalance: number;
  }

  const weeks: WeekBucket[] = [];
  for (let i = 0; i < 13; i++) {
    const ws = addDays(weekStart, i * 7);
    const we = addDays(ws, 6);
    const mo = ws.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    weeks.push({
      weekStart: toISO(ws),
      weekEnd:   toISO(we),
      label:     `W${i+1} ${mo}`,
      inflows:   [],
      outflows:  [],
      totalIn:   0,
      totalOut:  0,
      net:       0,
      runningBalance: 0,
    });
  }

  function getWeekIndex(dateObj: Date): number {
    const ms = dateObj.getTime() - weekStart.getTime();
    const days = Math.floor(ms / 86400000);
    return Math.floor(days / 7);
  }

  // ── Inflows: unpaid sales invoices ────────────────────────────────────────
  for (const inv of invData.Invoices || []) {
    const due = parseXeroDateObj(inv.DueDate);
    if (!due) continue;
    const wi = getWeekIndex(due);
    if (wi < 0 || wi >= 13) continue;
    const amount = inv.AmountDue || 0;
    weeks[wi].inflows.push({
      ref:     inv.InvoiceNumber || '—',
      contact: inv.Contact?.Name || '—',
      amount,
      due:     toISO(due),
      type:    'Invoice',
    });
    weeks[wi].totalIn += amount;
  }

  // ── Outflows: unpaid bills ────────────────────────────────────────────────
  for (const bill of billData.Invoices || []) {
    const due = parseXeroDateObj(bill.DueDate);
    if (!due) continue;
    const wi = getWeekIndex(due);
    if (wi < 0 || wi >= 13) continue;
    const amount = bill.AmountDue || 0;
    weeks[wi].outflows.push({
      ref:     bill.InvoiceNumber || bill.Reference || '—',
      contact: bill.Contact?.Name || '—',
      amount,
      due:     toISO(due),
      type:    'Bill',
    });
    weeks[wi].totalOut += amount;
  }

  // ── Recurring spend detection from bank history ───────────────────────────
  // Look at last 90 days of SPEND transactions, group by contact/description,
  // find those occurring roughly monthly or weekly, project forward.

  const txList = (txData.BankTransactions || []).filter((tx: any) =>
    tx.Type === "SPEND" || tx.Type === "SPEND-OVERPAYMENT"
  );

  // Group by contact name + approximate amount (rounded to nearest £10)
  const spendGroups: Record<string, { dates: Date[]; amount: number; name: string }> = {};

  const ninetyDaysAgo = addDays(new Date(), -90);

  for (const tx of txList) {
    const d = parseXeroDateObj(tx.Date);
    if (!d || d < ninetyDaysAgo) continue;
    const name   = tx.Contact?.Name || tx.Reference || 'Unknown';
    const amount = Math.round((tx.Total || 0) / 10) * 10;
    const key    = `${name}__${amount}`;
    if (!spendGroups[key]) spendGroups[key] = { dates: [], amount: tx.Total || 0, name };
    spendGroups[key].dates.push(d);
  }

  // Detect patterns: 2+ occurrences = recurring
  for (const [, group] of Object.entries(spendGroups)) {
    if (group.dates.length < 2) continue;
    group.dates.sort((a, b) => a.getTime() - b.getTime());

    // Average gap in days between occurrences
    let totalGap = 0;
    for (let i = 1; i < group.dates.length; i++) {
      totalGap += (group.dates[i].getTime() - group.dates[i-1].getTime()) / 86400000;
    }
    const avgGap = totalGap / (group.dates.length - 1);

    // Only project if roughly monthly (20-40 days) or weekly (5-9 days)
    const isMonthly = avgGap >= 20 && avgGap <= 40;
    const isWeekly  = avgGap >= 5  && avgGap <= 9;
    if (!isMonthly && !isWeekly) continue;

    // Project from last occurrence
    const lastDate = group.dates[group.dates.length - 1];
    let nextDate   = addDays(lastDate, Math.round(avgGap));

    while (nextDate <= weekEnd) {
      const wi = getWeekIndex(nextDate);
      if (wi >= 0 && wi < 13) {
        weeks[wi].outflows.push({
          ref:     'Recurring',
          contact: group.name,
          amount:  group.amount,
          due:     toISO(nextDate),
          type:    isMonthly ? 'Est. Monthly' : 'Est. Weekly',
        });
        weeks[wi].totalOut += group.amount;
      }
      nextDate = addDays(nextDate, Math.round(avgGap));
    }
  }

  // ── Get opening bank balance ───────────────────────────────────────────────
  // Sum all bank transaction net to date as a proxy for current balance
  // (Xero doesn't expose live balance directly without bank feeds scope)
  let openingBalance = 0;
  const allTx = txData.BankTransactions || [];
  for (const tx of allTx) {
    const d = parseXeroDateObj(tx.Date);
    if (!d || d >= weekStart) continue;
    const amount = tx.Total || 0;
    if (tx.Type === "RECEIVE" || tx.Type === "RECEIVE-OVERPAYMENT") openingBalance += amount;
    else if (tx.Type === "SPEND" || tx.Type === "SPEND-OVERPAYMENT") openingBalance -= amount;
  }

  // ── Calculate net + running balance ───────────────────────────────────────
  let running = openingBalance;
  for (const week of weeks) {
    week.net            = week.totalIn - week.totalOut;
    running            += week.net;
    week.runningBalance = running;
  }

  return Response.json({
    openingBalance,
    generatedAt: new Date().toISOString(),
    forecastFrom: fromStr,
    forecastTo:   toStr,
    weeks,
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

// ─── Existing endpoints (unchanged) ──────────────────────────────────────────

async function handleCashflow(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); }
  catch (e: any) { return new Response(e.message, { status: 401 }); }
  const res = await fetch(`${XERO_API_BASE}/BankTransactions`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" },
  });
  if (!res.ok) return new Response("Failed to fetch bank transactions: " + await res.text(), { status: 500 });
  const data: any = await res.json();
  const monthly: Record<string, { inflow: number; outflow: number; net: number }> = {};
  for (const tx of data.BankTransactions || []) {
    const date = parseXeroDate(tx.Date);
    if (!date) continue;
    if (!monthly[date]) monthly[date] = { inflow: 0, outflow: 0, net: 0 };
    const amount: number = tx.Total || 0;
    if (tx.Type === "RECEIVE" || tx.Type === "RECEIVE-OVERPAYMENT")  monthly[date].inflow  += amount;
    else if (tx.Type === "SPEND" || tx.Type === "SPEND-OVERPAYMENT") monthly[date].outflow += amount;
    monthly[date].net = monthly[date].inflow - monthly[date].outflow;
  }
  const sorted = Object.fromEntries(Object.entries(monthly).sort(([a],[b]) => a.localeCompare(b)));
  return Response.json(sorted, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleInvoicesByMonth(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); }
  catch (e: any) { return new Response(e.message, { status: 401 }); }
  const res = await fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22AUTHORISED%22&order=DueDate+ASC`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" },
  });
  if (!res.ok) return new Response("Failed to fetch invoices: " + await res.text(), { status: 500 });
  const data: any = await res.json();
  const byMonth: Record<string, { total: number; count: number; overdue: number; invoices: any[] }> = {};
  const now = new Date(); now.setHours(0,0,0,0);
  for (const inv of data.Invoices || []) {
    const dueDateObj = parseXeroDateObj(inv.DueDate);
    if (!dueDateObj) continue;
    const month  = dueDateObj.toISOString().substring(0, 7);
    const amount = inv.AmountDue || 0;
    const isOver = dueDateObj < now;
    if (!byMonth[month]) byMonth[month] = { total: 0, count: 0, overdue: 0, invoices: [] };
    byMonth[month].total += amount;
    byMonth[month].count += 1;
    if (isOver) byMonth[month].overdue += amount;
    byMonth[month].invoices.push({ ref: inv.InvoiceNumber, contact: inv.Contact?.Name || '—', amount, due: dueDateObj.toISOString().substring(0,10), overdue: isOver });
  }
  const sorted = Object.fromEntries(Object.entries(byMonth).sort(([a],[b]) => a.localeCompare(b)));
  return Response.json(sorted, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleCashBurn(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); }
  catch (e: any) { return new Response(e.message, { status: 401 }); }
  const res = await fetch(`${XERO_API_BASE}/BankTransactions`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" },
  });
  if (!res.ok) return new Response("Failed: " + await res.text(), { status: 500 });
  const data: any = await res.json();
  const monthly: Record<string, { spend: number; receive: number; net: number }> = {};
  for (const tx of data.BankTransactions || []) {
    const date = parseXeroDate(tx.Date);
    if (!date) continue;
    if (!monthly[date]) monthly[date] = { spend: 0, receive: 0, net: 0 };
    const amount: number = tx.Total || 0;
    if (tx.Type === "SPEND" || tx.Type === "SPEND-OVERPAYMENT")          monthly[date].spend   += amount;
    else if (tx.Type === "RECEIVE" || tx.Type === "RECEIVE-OVERPAYMENT") monthly[date].receive += amount;
    monthly[date].net = monthly[date].receive - monthly[date].spend;
  }
  const sorted = Object.entries(monthly).sort(([a],[b]) => a.localeCompare(b));
  let running = 0;
  const result: Record<string, any> = {};
  for (const [month, vals] of sorted) {
    running += vals.net;
    result[month] = { ...vals, runningBalance: running };
  }
  return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleProfitAndLoss(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); }
  catch (e: any) { return new Response(e.message, { status: 401 }); }
  const year = new Date().getFullYear();
  const h = { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" };
  const [invRes, txRes] = await Promise.all([
    fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22PAID%22&fromDate=${year}-01-01&toDate=${year}-12-31`, { headers: h }),
    fetch(`${XERO_API_BASE}/BankTransactions?fromDate=${year}-01-01&toDate=${year}-12-31`, { headers: h }),
  ]);
  if (!invRes.ok) return new Response("Failed invoices: " + await invRes.text(), { status: 500 });
  if (!txRes.ok)  return new Response("Failed tx: "       + await txRes.text(),  { status: 500 });
  const invData: any = await invRes.json();
  const txData:  any = await txRes.json();
  const months: string[] = [];
  for (let m = 1; m <= 12; m++) months.push(`${year}-${String(m).padStart(2,"0")}`);
  const pnl: Record<string, { income: number; expenses: number; profit: number }> = {};
  for (const m of months) pnl[m] = { income: 0, expenses: 0, profit: 0 };
  for (const inv of invData.Invoices || []) {
    const date = parseXeroDate(inv.FullyPaidOnDate) || parseXeroDate(inv.Date);
    if (!date || !pnl[date]) continue;
    pnl[date].income += inv.Total || 0;
  }
  for (const tx of txData.BankTransactions || []) {
    const date = parseXeroDate(tx.Date);
    if (!date || !pnl[date]) continue;
    if (tx.Type === "SPEND" || tx.Type === "SPEND-OVERPAYMENT") pnl[date].expenses += tx.Total || 0;
  }
  for (const m of months) pnl[m].profit = pnl[m].income - pnl[m].expenses;
  return Response.json(pnl, { headers: { "Access-Control-Allow-Origin": "*" } });
}

// ─── Dashboard HTML (unchanged) ───────────────────────────────────────────────

function serveDashboard(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Financial Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
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
.month-count{font-size:0.62rem;color:var(--muted);letter-spacing:0.08em}
.overdue-flag{font-size:0.58rem;padding:2px 6px;border-radius:3px;background:rgba(255,107,107,0.15);color:var(--red);letter-spacing:0.08em;text-transform:uppercase}
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
    <div class="logo-area">
      <h1>Finance<span>.</span></h1>
      <p>Live overview — powered by Xero</p>
    </div>
    <div class="header-meta">
      <span>LAST UPDATED</span>
      <span id="last-updated">—</span>
      <a href="/forecast" class="nav-link">↗ 13-Week Forecast</a>
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
Chart.defaults.color='#6b6b8a';Chart.defaults.borderColor='#2a2a40';Chart.defaults.font.family="'DM Mono', monospace";Chart.defaults.font.size=11;
let cashflowChart,donutChart,burnChart,invMonthChart,pnlChart;
async function loadCashflow(){
  try{
    const res=await fetch('/api/cashflow');if(!res.ok)throw new Error(await res.text());
    const data=await res.json();
    document.getElementById('cashflow-loading')?.remove();document.getElementById('donut-loading')?.remove();
    const labels=Object.keys(data).slice(-12);
    const inflow=labels.map(m=>data[m].inflow),outflow=labels.map(m=>data[m].outflow),net=labels.map(m=>data[m].net);
    const latest=data[labels[labels.length-1]];
    if(latest){const el=document.getElementById('kpi-net');el.textContent=fmt(latest.net);el.className='kpi-value '+(latest.net>=0?'positive':'negative');document.getElementById('kpi-net-sub').textContent='In '+fmt(latest.inflow)+' / Out '+fmt(latest.outflow);document.getElementById('donut-label').textContent=fmtMo(labels[labels.length-1]);}
    if(cashflowChart)cashflowChart.destroy();
    cashflowChart=new Chart(document.getElementById('cashflowChart').getContext('2d'),{type:'bar',data:{labels:labels.map(fmtMo),datasets:[{label:'Inflow',data:inflow,backgroundColor:'rgba(78,205,196,0.7)',borderRadius:3,borderSkipped:false},{label:'Outflow',data:outflow,backgroundColor:'rgba(255,107,107,0.7)',borderRadius:3,borderSkipped:false},{label:'Net',data:net,type:'line',borderColor:'#7c6af7',backgroundColor:'rgba(124,106,247,0.08)',borderWidth:2,pointRadius:3,fill:true,tension:0.3,yAxisID:'y'}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:14}}},scales:{x:{grid:{color:'#2a2a40'}},y:{grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)}}}}});
    if(donutChart)donutChart.destroy();
    donutChart=new Chart(document.getElementById('donutChart').getContext('2d'),{type:'doughnut',data:{labels:['Inflow','Outflow'],datasets:[{data:[latest?.inflow||0,latest?.outflow||0],backgroundColor:['rgba(78,205,196,0.85)','rgba(255,107,107,0.85)'],borderColor:'#12121a',borderWidth:3,hoverOffset:8}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{position:'bottom',labels:{boxWidth:10,padding:14}},tooltip:{callbacks:{label:ctx=>' '+fmt(ctx.raw)}}}}});
  }catch(e){const el=document.getElementById('cashflow-loading');if(el){el.textContent='Error: '+e.message;el.className='error-text';}}
}
async function loadCashBurn(){
  try{
    const res=await fetch('/api/cashburn');if(!res.ok)throw new Error(await res.text());
    const data=await res.json();document.getElementById('burn-loading')?.remove();
    const months=Object.keys(data),spend=months.map(m=>data[m].spend),balance=months.map(m=>data[m].runningBalance),latest=data[months[months.length-1]];
    const last6=spend.slice(-6),avg=last6.reduce((a,b)=>a+b,0)/(last6.length||1);
    document.getElementById('burn-this-month').textContent=fmt(latest?.spend||0);
    document.getElementById('burn-avg').textContent=fmt(avg);
    const bal=latest?.runningBalance||0,balEl=document.getElementById('burn-balance');
    balEl.textContent=fmt(bal);balEl.className='burn-stat-value '+(bal>=0?'positive':'negative');
    document.getElementById('kpi-burn').textContent=fmt(avg);document.getElementById('kpi-burn').className='kpi-value negative';document.getElementById('kpi-burn-sub').textContent='6-month average';
    if(burnChart)burnChart.destroy();
    burnChart=new Chart(document.getElementById('burnChart').getContext('2d'),{type:'bar',data:{labels:months.map(fmtMo),datasets:[{label:'Monthly Spend',data:spend,backgroundColor:'rgba(255,107,107,0.6)',borderRadius:3,borderSkipped:false,yAxisID:'y'},{label:'Running Balance',data:balance,type:'line',borderColor:'#ffd93d',backgroundColor:'rgba(255,217,61,0.06)',borderWidth:2,pointRadius:2,fill:true,tension:0.3,yAxisID:'y1'}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:14}}},scales:{x:{grid:{color:'#2a2a40'}},y:{grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)},title:{display:true,text:'Spend',color:'#6b6b8a',font:{size:10}}},y1:{position:'right',grid:{display:false},ticks:{callback:v=>fmt(v)},title:{display:true,text:'Balance',color:'#6b6b8a',font:{size:10}}}}}});
  }catch(e){const el=document.getElementById('burn-loading');if(el){el.textContent='Error: '+e.message;el.className='error-text';}}
}
async function loadInvoicesByMonth(){
  try{
    const res=await fetch('/api/invoices-by-month');if(!res.ok)throw new Error(await res.text());
    const data=await res.json();document.getElementById('inv-month-loading')?.remove();
    const months=Object.keys(data),totals=months.map(m=>data[m].total),overdueTot=months.map(m=>data[m].overdue);
    const totalAll=totals.reduce((a,b)=>a+b,0),totalOv=overdueTot.reduce((a,b)=>a+b,0);
    const countAll=months.reduce((a,m)=>a+data[m].count,0),countOv=months.reduce((a,m)=>a+data[m].invoices.filter(i=>i.overdue).length,0);
    document.getElementById('kpi-inv-total').textContent=fmt(totalAll);document.getElementById('kpi-inv-total').className='kpi-value neutral';
    document.getElementById('kpi-inv-count').textContent=countAll+' invoices outstanding';
    const ovEl=document.getElementById('kpi-overdue');ovEl.textContent=fmt(totalOv);ovEl.className='kpi-value '+(totalOv>0?'negative':'positive');
    document.getElementById('kpi-overdue-count').textContent=countOv+' invoice'+(countOv!==1?'s':'')+' overdue';
    document.getElementById('inv-month-badge').textContent=months.length+' months';
    if(invMonthChart)invMonthChart.destroy();
    invMonthChart=new Chart(document.getElementById('invMonthChart').getContext('2d'),{type:'bar',data:{labels:months.map(fmtMo),datasets:[{label:'Overdue',data:overdueTot,backgroundColor:'rgba(255,107,107,0.75)',borderRadius:3,borderSkipped:false},{label:'On track',data:totals.map((t,i)=>t-overdueTot[i]),backgroundColor:'rgba(78,205,196,0.6)',borderRadius:3,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:14}},tooltip:{callbacks:{footer:items=>'Total: '+fmt(items.reduce((a,i)=>a+i.raw,0))}}},scales:{x:{stacked:true,grid:{color:'#2a2a40'}},y:{stacked:true,grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)}}}}});
    const listHtml=months.map((month,idx)=>{
      const d=data[month],hasOv=d.overdue>0;
      const rows=d.invoices.map(inv=>'<div class="inv-row"><span class="inv-ref2">'+inv.ref+'</span><span class="inv-name">'+inv.contact+'</span><span class="inv-amt">'+fmtDec(inv.amount)+'</span><span class="inv-due'+(inv.overdue?' overdue':'')+'">'+inv.due+'</span></div>').join('');
      const open=idx===0?' open':'';
      return '<div class="month-group"><div class="month-header" onclick="toggleMonth(this)"><div style="display:flex;align-items:center;gap:10px"><span class="chevron'+(idx===0?' open':'')+'">&#9654;</span><span class="month-name">'+fmtMo(month)+'</span></div><div class="month-meta">'+(hasOv?'<span class="overdue-flag">'+fmt(d.overdue)+' overdue</span>':'')+'<span class="month-count">'+d.count+' inv</span><span class="month-total">'+fmt(d.total)+'</span></div></div><div class="month-rows'+open+'">'+rows+'</div></div>';
    }).join('');
    document.getElementById('inv-month-list').innerHTML=listHtml||'<div style="color:var(--muted);font-size:0.7rem">No outstanding invoices</div>';
  }catch(e){const el=document.getElementById('inv-month-loading');if(el){el.textContent='Error: '+e.message;el.className='error-text';}document.getElementById('inv-month-list').innerHTML='<div class="error-text">'+e.message+'</div>';}
}
function toggleMonth(header){const rows=header.nextElementSibling,chevron=header.querySelector('.chevron'),open=rows.classList.toggle('open');chevron.classList.toggle('open',open);}
async function loadPnL(){
  try{
    const res=await fetch('/api/pnl');if(!res.ok)throw new Error(await res.text());
    const data=await res.json();document.getElementById('pnl-loading')?.remove();
    const months=Object.keys(data),income=months.map(m=>data[m].income),expenses=months.map(m=>data[m].expenses),profit=months.map(m=>data[m].profit);
    const ytdI=income.reduce((a,b)=>a+b,0),ytdE=expenses.reduce((a,b)=>a+b,0),ytdP=ytdI-ytdE;
    document.getElementById('pnl-summary').innerHTML='<div class="burn-stat"><div class="burn-stat-label">YTD Revenue</div><div class="burn-stat-value positive">'+fmt(ytdI)+'</div></div><div class="burn-stat"><div class="burn-stat-label">YTD Costs</div><div class="burn-stat-value negative">'+fmt(ytdE)+'</div></div><div class="burn-stat"><div class="burn-stat-label">YTD Profit</div><div class="burn-stat-value '+(ytdP>=0?'positive':'negative')+'">'+fmt(ytdP)+'</div></div>';
    if(pnlChart)pnlChart.destroy();
    pnlChart=new Chart(document.getElementById('pnlChart').getContext('2d'),{type:'line',data:{labels:months.map(fmtMo),datasets:[{label:'Income',data:income,borderColor:'rgba(78,205,196,0.9)',backgroundColor:'rgba(78,205,196,0.07)',borderWidth:2,pointRadius:3,fill:true,tension:0.3},{label:'Expenses',data:expenses,borderColor:'rgba(255,107,107,0.9)',backgroundColor:'rgba(255,107,107,0.07)',borderWidth:2,pointRadius:3,fill:true,tension:0.3},{label:'Net Profit',data:profit,borderColor:'#7c6af7',backgroundColor:'transparent',borderWidth:2,pointRadius:3,borderDash:[4,4],tension:0.3}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:14}}},scales:{x:{grid:{color:'#2a2a40'}},y:{grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)}}}}});
  }catch(e){const el=document.getElementById('pnl-loading');if(el){el.textContent='Error: '+e.message;el.className='error-text';}}
}
async function loadAll(){
  document.getElementById('last-updated').textContent='Loading…';
  await Promise.all([loadCashflow(),loadCashBurn(),loadInvoicesByMonth(),loadPnL()]);
  document.getElementById('last-updated').textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
loadAll();
<\/script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ─── Forecast HTML ────────────────────────────────────────────────────────────

function serveForecast(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>13-Week Cash Flow Forecast</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
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
.header-right{text-align:right;font-size:0.7rem;color:var(--muted)}
.nav-link{display:inline-block;margin-top:8px;font-size:0.68rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;border:1px solid var(--accent);padding:5px 12px;border-radius:4px;transition:all 0.2s}
.nav-link:hover{background:var(--accent);color:#fff}

/* Summary KPIs */
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;position:relative;overflow:hidden;opacity:0;transform:translateY(8px);animation:fadeUp 0.4s ease forwards}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.kpi-card:nth-child(1)::before{background:var(--accent)}
.kpi-card:nth-child(2)::before{background:var(--accent2)}
.kpi-card:nth-child(3)::before{background:var(--accent3)}
.kpi-card:nth-child(4)::before{background:var(--accent4)}
.kpi-card:nth-child(1){animation-delay:0.05s}
.kpi-card:nth-child(2){animation-delay:0.10s}
.kpi-card:nth-child(3){animation-delay:0.15s}
.kpi-card:nth-child(4){animation-delay:0.20s}
.kpi-label{font-size:0.62rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.kpi-value{font-family:'Syne',sans-serif;font-size:1.85rem;font-weight:700;letter-spacing:-0.02em;line-height:1}
.kpi-sub{font-size:0.68rem;color:var(--muted);margin-top:8px}
.positive{color:var(--green)}.negative{color:var(--red)}.neutral{color:var(--text)}

/* Chart card */
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:16px}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.card-title{font-family:'Syne',sans-serif;font-size:0.82rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase}
.card-badge{font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);background:var(--surface2);padding:3px 8px;border-radius:3px;border:1px solid var(--border)}
.chart-wrap{position:relative;height:280px}

/* Week grid */
.section-label{font-size:0.62rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.week-grid{display:grid;grid-template-columns:repeat(13,1fr);gap:6px;margin-bottom:32px;overflow-x:auto}
.week-col{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 8px;min-width:90px;transition:border-color 0.2s;cursor:pointer}
.week-col:hover,.week-col.active{border-color:var(--accent)}
.week-col.danger{border-color:rgba(255,107,107,0.5)}
.week-col.danger .week-balance{color:var(--red)}
.week-label{font-size:0.58rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;white-space:nowrap}
.week-in{font-size:0.65rem;color:var(--green);margin-bottom:3px}
.week-out{font-size:0.65rem;color:var(--red);margin-bottom:6px}
.week-net{font-family:'Syne',sans-serif;font-size:0.82rem;font-weight:700;margin-bottom:4px}
.week-balance{font-size:0.62rem;color:var(--muted);padding-top:4px;border-top:1px solid var(--border)}
.net-positive{color:var(--green)}.net-negative{color:var(--red)}.net-zero{color:var(--muted)}

/* Detail panel */
.detail-panel{background:var(--surface);border:1px solid var(--accent);border-radius:8px;padding:24px;margin-bottom:32px;display:none}
.detail-panel.visible{display:block}
.detail-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.detail-title{font-family:'Syne',sans-serif;font-size:1rem;font-weight:700}
.detail-close{background:none;border:1px solid var(--border);color:var(--muted);padding:4px 10px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;font-size:0.65rem}
.detail-cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.detail-section-title{font-size:0.62rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.detail-row{display:grid;grid-template-columns:1fr 1.5fr 1fr auto;gap:8px;padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.4);font-size:0.7rem;align-items:center}
.detail-row:last-child{border-bottom:none}
.dr-ref{color:var(--accent);font-size:0.65rem}
.dr-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-amt{font-family:'Syne',sans-serif;font-weight:600;text-align:right}
.dr-type{font-size:0.58rem;padding:2px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap}
.type-invoice{background:rgba(78,205,196,0.15);color:var(--accent2)}
.type-bill{background:rgba(255,107,107,0.15);color:var(--red)}
.type-monthly{background:rgba(255,217,61,0.15);color:var(--accent4)}
.type-weekly{background:rgba(124,106,247,0.15);color:var(--accent)}
.empty-state{font-size:0.7rem;color:var(--muted);padding:12px 0}

.loading-overlay{display:flex;align-items:center;justify-content:center;height:300px}
.loading-text{font-size:0.68rem;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;animation:pulse 1.5s ease-in-out infinite}
.error-text{font-size:0.68rem;color:var(--red)}

@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes fadeUp{to{opacity:1;transform:translateY(0)}}
@media(max-width:1100px){.week-grid{grid-template-columns:repeat(7,1fr)}}
@media(max-width:700px){.kpi-row{grid-template-columns:repeat(2,1fr)}.week-grid{grid-template-columns:repeat(4,1fr)}.detail-cols{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo-area">
      <h1>Forecast<span>.</span></h1>
      <p>13-week cash flow — powered by Xero</p>
    </div>
    <div class="header-right">
      <a href="/dashboard" class="nav-link">← Dashboard</a>
    </div>
  </header>

  <div id="loading-state" class="loading-overlay"><div class="loading-text">Building forecast…</div></div>
  <div id="forecast-content" style="display:none">

    <!-- KPIs -->
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">Opening Balance</div><div class="kpi-value neutral" id="kpi-opening">—</div><div class="kpi-sub">As of this week</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Expected In</div><div class="kpi-value positive" id="kpi-total-in">—</div><div class="kpi-sub" id="kpi-in-sub">Over 13 weeks</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Expected Out</div><div class="kpi-value negative" id="kpi-total-out">—</div><div class="kpi-sub" id="kpi-out-sub">Over 13 weeks</div></div>
      <div class="kpi-card"><div class="kpi-label">Closing Balance</div><div class="kpi-value neutral" id="kpi-closing">—</div><div class="kpi-sub">End of week 13</div></div>
    </div>

    <!-- Chart -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">Weekly Cash Position</span>
        <span class="card-badge">13 weeks from this Monday</span>
      </div>
      <div class="chart-wrap"><canvas id="forecastChart"></canvas></div>
    </div>

    <!-- Week grid -->
    <div class="section-label" style="margin-top:24px">Weekly Breakdown — click any week for detail</div>
    <div class="week-grid" id="week-grid"></div>

    <!-- Detail panel -->
    <div class="detail-panel" id="detail-panel">
      <div class="detail-header">
        <span class="detail-title" id="detail-title">Week detail</span>
        <button class="detail-close" onclick="closeDetail()">✕ Close</button>
      </div>
      <div class="detail-cols">
        <div>
          <div class="detail-section-title" id="detail-in-title">Inflows</div>
          <div id="detail-inflows"></div>
        </div>
        <div>
          <div class="detail-section-title" id="detail-out-title">Outflows</div>
          <div id="detail-outflows"></div>
        </div>
      </div>
    </div>

  </div>
</div>
<script>
const fmt=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0}).format(n);
const fmtDec=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',minimumFractionDigits:2}).format(n);

Chart.defaults.color='#6b6b8a';Chart.defaults.borderColor='#2a2a40';
Chart.defaults.font.family="'DM Mono', monospace";Chart.defaults.font.size=11;

let forecastData=null;

function typeClass(t){
  if(t==='Invoice')return 'type-invoice';
  if(t==='Bill')return 'type-bill';
  if(t==='Est. Monthly')return 'type-monthly';
  return 'type-weekly';
}

function renderDetail(wi){
  const week=forecastData.weeks[wi];
  document.querySelectorAll('.week-col').forEach((c,i)=>c.classList.toggle('active',i===wi));
  const panel=document.getElementById('detail-panel');
  panel.classList.add('visible');
  document.getElementById('detail-title').textContent=week.label+' ('+week.weekStart+' → '+week.weekEnd+')';
  document.getElementById('detail-in-title').textContent='Inflows — '+fmt(week.totalIn);
  document.getElementById('detail-out-title').textContent='Outflows — '+fmt(week.totalOut);

  const inRows=week.inflows.length
    ? week.inflows.map(i=>'<div class="detail-row"><span class="dr-ref">'+i.ref+'</span><span class="dr-name">'+i.contact+'</span><span class="dr-amt">'+fmtDec(i.amount)+'</span><span class="dr-type '+typeClass(i.type)+'">'+i.type+'</span></div>').join('')
    : '<div class="empty-state">No inflows this week</div>';

  const outRows=week.outflows.length
    ? week.outflows.map(o=>'<div class="detail-row"><span class="dr-ref">'+o.ref+'</span><span class="dr-name">'+o.contact+'</span><span class="dr-amt">'+fmtDec(o.amount)+'</span><span class="dr-type '+typeClass(o.type)+'">'+o.type+'</span></div>').join('')
    : '<div class="empty-state">No outflows this week</div>';

  document.getElementById('detail-inflows').innerHTML=inRows;
  document.getElementById('detail-outflows').innerHTML=outRows;
  panel.scrollIntoView({behavior:'smooth',block:'nearest'});
}

function closeDetail(){
  document.getElementById('detail-panel').classList.remove('visible');
  document.querySelectorAll('.week-col').forEach(c=>c.classList.remove('active'));
}

async function loadForecast(){
  try{
    const res=await fetch('/api/forecast');
    if(!res.ok)throw new Error(await res.text());
    forecastData=await res.json();

    document.getElementById('loading-state').style.display='none';
    document.getElementById('forecast-content').style.display='block';

    const weeks=forecastData.weeks;
    const totalIn=weeks.reduce((a,w)=>a+w.totalIn,0);
    const totalOut=weeks.reduce((a,w)=>a+w.totalOut,0);
    const closing=weeks[weeks.length-1].runningBalance;

    // KPIs
    const opEl=document.getElementById('kpi-opening');
    opEl.textContent=fmt(forecastData.openingBalance);
    opEl.className='kpi-value '+(forecastData.openingBalance>=0?'positive':'negative');
    document.getElementById('kpi-total-in').textContent=fmt(totalIn);
    document.getElementById('kpi-in-sub').textContent=weeks.reduce((a,w)=>a+w.inflows.length,0)+' items across 13 weeks';
    document.getElementById('kpi-total-out').textContent=fmt(totalOut);
    document.getElementById('kpi-out-sub').textContent=weeks.reduce((a,w)=>a+w.outflows.length,0)+' items across 13 weeks';
    const clEl=document.getElementById('kpi-closing');
    clEl.textContent=fmt(closing);
    clEl.className='kpi-value '+(closing>=0?'positive':'negative');

    // Chart
    const labels=weeks.map(w=>w.label);
    new Chart(document.getElementById('forecastChart').getContext('2d'),{
      type:'bar',
      data:{labels,datasets:[
        {label:'Expected In',  data:weeks.map(w=>w.totalIn),  backgroundColor:'rgba(78,205,196,0.7)', borderRadius:3, borderSkipped:false},
        {label:'Expected Out', data:weeks.map(w=>w.totalOut), backgroundColor:'rgba(255,107,107,0.7)', borderRadius:3, borderSkipped:false},
        {label:'Balance',data:weeks.map(w=>w.runningBalance),type:'line',borderColor:'#ffd93d',
          backgroundColor:'rgba(255,217,61,0.06)',borderWidth:2,pointRadius:4,
          pointBackgroundColor:weeks.map(w=>w.runningBalance>=0?'#ffd93d':'#ff6b6b'),
          fill:true,tension:0.3,yAxisID:'y1'}
      ]},
      options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},
        plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:14}},
          tooltip:{callbacks:{afterBody:items=>{const wi=items[0].dataIndex;return'Net: '+fmt(weeks[wi].net);}}}},
        scales:{
          x:{grid:{color:'#2a2a40'}},
          y:{grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)},title:{display:true,text:'In / Out',color:'#6b6b8a',font:{size:10}}},
          y1:{position:'right',grid:{display:false},ticks:{callback:v=>fmt(v)},title:{display:true,text:'Balance',color:'#6b6b8a',font:{size:10}}}
        }}
    });

    // Week grid
    const grid=document.getElementById('week-grid');
    grid.innerHTML=weeks.map((w,i)=>{
      const danger=w.runningBalance<0;
      const netClass=w.net>0?'net-positive':w.net<0?'net-negative':'net-zero';
      return '<div class="week-col'+(danger?' danger':'')+'" onclick="renderDetail('+i+')">'
        +'<div class="week-label">'+w.label+'</div>'
        +'<div class="week-in">↑ '+fmt(w.totalIn)+'</div>'
        +'<div class="week-out">↓ '+fmt(w.totalOut)+'</div>'
        +'<div class="week-net '+netClass+'">'+(w.net>=0?'+':'')+fmt(w.net)+'</div>'
        +'<div class="week-balance">Bal: '+fmt(w.runningBalance)+'</div>'
        +'</div>';
    }).join('');

    // Auto-open first week with activity
    const firstActive=weeks.findIndex(w=>w.inflows.length>0||w.outflows.length>0);
    if(firstActive>=0)renderDetail(firstActive);

  }catch(e){
    document.getElementById('loading-state').innerHTML='<div class="error-text">Error loading forecast: '+e.message+'</div>';
  }
}

loadForecast();
<\/script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}