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

interface CostSettings {
  basePostcode: string;
  hourlyRate: number;
  mileageRatePerMile: number;
  hotelThresholdMiles: number;
  hotelNightlyCost: number;
  subsistenceDailyRate: number;
  drivingSpeedMph: number;
  setupHours: Record<string, number>;
  contingencyHours: number;
  payeMode: boolean;
  payeOnCostMultiplier: number;
  driverPaymentDaysAfterEvent: number;  // days after event end before driver pay leaves the bank
}

interface EventCosts {
  wages: number;
  mileage: number;
  hotel: number;
  subsistence: number;
  total: number;
  staffCount: number;
  operationalHours: number;
  drivingHours: number;
  setupHours: number;
  totalPaidHours: number;
  miles: number;
  nights: number;
  payeMode: boolean;
  breakdown: string;
}

interface PipelineItem {
  id: string;
  bookingId: string;
  name: string;
  status: string;
  isPast: boolean;
  isPaid: boolean;
  eventStart: string;
  eventEnd: string;
  eventDays: number;
  paymentDate: string;
  price: number | null;
  priceFlag: string;
  rawPrice: string | null;
  unitCount: number;
  resourceTypes: string[];
  address: string | null;
  operationalHours: number | null;
  opHoursPerDay: number | null;
  opHoursSource: string;
  costs: EventCosts;
}

const DEFAULT_COST_SETTINGS: CostSettings = {
  basePostcode:                 "GL10 3RF",
  hourlyRate:                   12.50,
  mileageRatePerMile:           0.45,
  hotelThresholdMiles:          50,
  hotelNightlyCost:             80,
  subsistenceDailyRate:         5,
  drivingSpeedMph:              40,
  setupHours:                   { "Day Van": 1, "Trailer": 4, "POD": 4 },
  contingencyHours:             1,
  payeMode:                     false,
  payeOnCostMultiplier:         1.258,
  driverPaymentDaysAfterEvent:  14,  // drivers paid 14 days after event end by default
};

const XERO_AUTH_URL  = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE  = "https://api.xero.com/api.xro/2.0";
const SP_API_BASE    = "https://api.sonderplan.com/v2";
const MOBILOO_PARENT_ID = 23814;

// ─── In-memory geocode cache ──────────────────────────────────────────────────
const geocodeCache = new Map<string, { lat: number; lng: number } | null>();

async function geocodePostcode(postcode: string): Promise<{ lat: number; lng: number } | null> {
  const key = postcode.trim().toUpperCase().replace(/\s+/g, "");
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;
  try {
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(key)}`);
    if (res.ok) {
      const data: any = await res.json();
      if (data.status === 200 && data.result) {
        const result = { lat: data.result.latitude, lng: data.result.longitude };
        geocodeCache.set(key, result);
        return result;
      }
    }
    const outcodeRes = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(key)}`);
    if (outcodeRes.ok) {
      const outcodeData: any = await outcodeRes.json();
      if (outcodeData.status === 200 && outcodeData.result) {
        const result = { lat: outcodeData.result.latitude, lng: outcodeData.result.longitude };
        geocodeCache.set(key, result);
        return result;
      }
    }
    geocodeCache.set(key, null);
    return null;
  } catch {
    geocodeCache.set(key, null);
    return null;
  }
}

async function bulkGeocodePostcodes(postcodes: string[]): Promise<void> {
  const unique = [...new Set(postcodes.map(p => p.trim().toUpperCase().replace(/\s+/g, "")))];
  const toFetch = unique.filter(p => p && !geocodeCache.has(p));
  if (toFetch.length === 0) return;

  for (let i = 0; i < toFetch.length; i += 100) {
    const batch = toFetch.slice(i, i + 100);
    try {
      const res = await fetch("https://api.postcodes.io/postcodes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postcodes: batch }),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      for (const item of (data.result || [])) {
        const key = (item.query || "").toUpperCase().replace(/\s+/g, "");
        if (item.result) {
          geocodeCache.set(key, { lat: item.result.latitude, lng: item.result.longitude });
        } else {
          geocodeCache.set(key, null);
        }
      }
    } catch { /* continue */ }
  }
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function kmToMiles(km: number): number { return km * 0.621371; }

function extractPostcode(address: string): string | null {
  if (!address) return null;
  const cleaned = address
    .replace(/\/\/\/[\w]+\.[\w]+\.[\w]+/g, "")
    .replace(/https?:\/\/(www\.)?(what3words\.com|w3w\.co)\/[\w.]+/gi, "")
    .replace(/what3words:?\s*[\w./]*/gi, "")
    .replace(/w3w:?\s*[\w./]*/gi, "")
    .trim();
  const fullMatch = cleaned.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2})\b/i);
  if (fullMatch) return fullMatch[1].replace(/\s+/g, " ").trim();
  const outwardMatch = cleaned.match(/\b([A-Z]{1,2}\d{1,2}[A-Z]?)\b/i);
  if (outwardMatch) return outwardMatch[1].trim();
  return null;
}

function calcDrivingHours(miles: number, speedMph: number): number {
  if (miles <= 0) return 0;
  const speed = speedMph && speedMph > 0 ? speedMph : 40;
  return (miles * 2) / speed;
}

function parseOperationalHours(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase();
  const rangeMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)/);
  if (rangeMatch) return parseFloat(rangeMatch[2]);
  const timeMatch = cleaned.match(/^(\d+):(\d{2})/);
  if (timeMatch) return parseInt(timeMatch[1]) + parseInt(timeMatch[2]) / 60;
  const numMatch = cleaned.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch) return parseFloat(numMatch[1]);
  return null;
}

function countUnitsFromEquipment(raw: string | null, fallbackUnitCount: number): number {
  if (!raw) return fallbackUnitCount;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed);
  const parts = trimmed.split(/[,;]+/).filter(s => s.trim().length > 0);
  return parts.length > 0 ? parts.length : fallbackUnitCount;
}

function resolveSetupHours(resourceNames: string[], setupMap: Record<string, number>, contingency: number): number {
  let total = 0;
  for (const name of resourceNames) {
    const upper = name.trim().toUpperCase();
    let matched = false;
    for (const [key, hrs] of Object.entries(setupMap)) {
      if (upper.startsWith(key.toUpperCase())) {
        total += hrs;
        matched = true;
        break;
      }
    }
    if (!matched) total += 1;
  }
  return total + contingency;
}

async function estimateEventCosts(
  address: string | null,
  unitCount: number,
  resourceNames: string[],
  operationalHours: number | null,
  eventDays: number,
  settings: CostSettings
): Promise<EventCosts> {
  const staffCount = unitCount;
  let miles = 0;
  if (address) {
    const pc = extractPostcode(address);
    if (pc) {
      const [baseCoord, eventCoord] = await Promise.all([
        geocodePostcode(settings.basePostcode),
        geocodePostcode(pc),
      ]);
      if (baseCoord && eventCoord) {
        miles = kmToMiles(haversineKm(baseCoord, eventCoord));
      }
    }
  }

  const drivingHoursPerUnit = calcDrivingHours(miles, settings.drivingSpeedMph);
  const totalDrivingHours   = drivingHoursPerUnit * unitCount;
  const setupHrs = resolveSetupHours(resourceNames, settings.setupHours, settings.contingencyHours);
  const opHours     = operationalHours ?? (eventDays >= 3 ? 10 : 8) * eventDays;
  const totalPaidHours = opHours + totalDrivingHours + setupHrs;
  const wageMultiplier = settings.payeMode ? settings.payeOnCostMultiplier : 1;
  const wages = staffCount * totalPaidHours * settings.hourlyRate * wageMultiplier;
  const mileage = miles * 2 * unitCount * settings.mileageRatePerMile;
  const needsHotel = eventDays > 1 || miles > settings.hotelThresholdMiles;
  const nights     = needsHotel ? Math.max(eventDays - 1, 1) : 0;
  const hotel      = nights * staffCount * settings.hotelNightlyCost;
  const subsistenceDays = eventDays + (miles > settings.hotelThresholdMiles ? 1 : 0);
  const subsistence     = subsistenceDays * staffCount * settings.subsistenceDailyRate;
  const total = wages + mileage + hotel + subsistence;

  const payeNote = settings.payeMode ? ` ×${settings.payeOnCostMultiplier} PAYE` : "";
  const breakdown = [
    `${staffCount} staff × ${totalPaidHours.toFixed(1)}h${payeNote} = ${fmtGBP(wages)} wages`,
    `  (${opHours.toFixed(1)}h ops + ${totalDrivingHours.toFixed(1)}h driving + ${setupHrs.toFixed(1)}h setup/contingency)`,
    miles > 0
      ? `${Math.round(miles)}mi × 2 × ${unitCount} units = ${fmtGBP(mileage)} mileage`
      : "no mileage (no postcode)",
    nights > 0 ? `${nights} night(s) = ${fmtGBP(hotel)} hotel` : "no hotel",
    `${subsistenceDays}d subsistence = ${fmtGBP(subsistence)}`,
  ].join(" • ");

  return {
    wages, mileage, hotel, subsistence, total,
    staffCount,
    operationalHours: opHours,
    drivingHours:     totalDrivingHours,
    setupHours:       setupHrs,
    totalPaidHours,
    miles:            Math.round(miles),
    nights,
    payeMode:         settings.payeMode,
    breakdown,
  };
}

function fmtGBP(n: number): string {
  return "£" + n.toFixed(0);
}

// ─── KV settings helpers ──────────────────────────────────────────────────────
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function getCached<T>(env: Env, key: string): Promise<T | null> {
  try {
    const raw = await env.XERO_KV.get(key, "json") as { data: T; cachedAt: number } | null;
    if (!raw) return null;
    if (Date.now() - raw.cachedAt > CACHE_TTL_MS) return null; // stale
    return raw.data;
  } catch {
    return null;
  }
}

async function setCached<T>(env: Env, key: string, data: T): Promise<void> {
  try {
    await env.XERO_KV.put(key, JSON.stringify({ data, cachedAt: Date.now() }), {
      expirationTtl: 3600, // KV TTL 1 hour — longer than our 30min soft TTL
    });
  } catch {
    // cache write failure is non-fatal
  }
}

function wantsRefresh(request: Request): boolean {
  return new URL(request.url).searchParams.get("refresh") === "true";
}

// ─── Shared Xero fetch helpers ────────────────────────────────────────────
// Pagination, chart-of-accounts, and the payment-dedup logic used to be
// copy-pasted into each endpoint that needed them — that's exactly how the
// dedup logic got silently dropped when bank-transactions-detail was split
// out. Defining them once here means every endpoint uses the same logic.

async function fetchXeroAllPages(
  h: Record<string, string>, endpoint: string, key: string, errors: string[]
): Promise<any[]> {
  let all: any[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${XERO_API_BASE}${endpoint}&page=${page}`, { headers: h });
    if (!res.ok) {
      const errText = await res.text();
      errors.push(`${endpoint} page ${page}: HTTP ${res.status} — ${errText.substring(0, 100)}`);
      break;
    }
    const data: any = await res.json();
    const records = data[key] || [];
    all = all.concat(records);
    if (records.length < 100) break;
    page++;
    if (page > 30) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return all;
}

interface ChartAccount { code: string; name: string; type: string; }

// Full chart of accounts (code, name, AND type — REVENUE/EXPENSE/DIRECTCOSTS/
// OVERHEADS vs LIABILITY/ASSET/EQUITY etc). Cached since it barely changes.
async function fetchChartOfAccounts(env: Env, h: Record<string, string>): Promise<ChartAccount[]> {
  const CACHE_KEY = "cache_chart_of_accounts_full";
  const cached = await getCached<ChartAccount[]>(env, CACHE_KEY);
  if (cached) return cached;
  const res = await fetch(`${XERO_API_BASE}/Accounts`, { headers: h });
  const data: any = res.ok ? await res.json() : { Accounts: [] };
  const accounts: ChartAccount[] = (data.Accounts || [])
    .filter((a: any) => !!a.Code)
    .map((a: any) => ({ code: a.Code, name: a.Name, type: a.Type || "" }));
  await setCached(env, CACHE_KEY, accounts);
  return accounts;
}

interface DirectBankTx {
  date: string; month: string; contact: string;
  type: string; reference: string; amount: number; // signed: spend +, receive -
  totalTax: number; source: string;
  accountCode: string; lineDescription: string;
}

// Direct "Spend Money"/"Receive Money" bank transactions for the year, with
// account codes (summaryOnly=false) and deduped against Payments already
// made against invoices/bills (a bank transaction can otherwise duplicate a
// Payment record — see the cashflow-data 500/1101 postmortem).
async function fetchDirectBankTransactions(
  env: Env, h: Record<string, string>, year: number, errors: string[]
): Promise<DirectBankTx[]> {
  const yearStart = new Date(year, 0, 1);
  const yearEnd   = new Date(year, 11, 31, 23, 59, 59);

  const allTx = await fetchXeroAllPages(h, `/BankTransactions?order=Date+DESC&summaryOnly=false`, "BankTransactions", errors);
  const txThisYear = allTx.filter((tx: any) => {
    const d = parseXeroDateObj(tx.Date);
    return d && d >= yearStart && d <= yearEnd;
  });

  const allPayments = await fetchXeroAllPages(h, `/Payments?order=Date+DESC`, "Payments", errors);
  const paymentsThisYear = allPayments.filter((p: any) => {
    const d = parseXeroDateObj(p.Date);
    return d && d >= yearStart && d <= yearEnd && p.Status !== "VOIDED";
  });
  const billPaymentKeys    = new Set<string>();
  const invoiceReceiptKeys = new Set<string>();
  for (const p of paymentsThisYear) {
    const d = parseXeroDateObj(p.Date);
    if (!d) continue;
    const key = `${toISO(d)}|${(p.Amount||0).toFixed(2)}`;
    if (p.Invoice?.Type === "ACCPAY")   billPaymentKeys.add(key);
    if (p.Invoice?.Type === "ACCREC" || p.Invoice?.Type === "ACCRECCREDIT") invoiceReceiptKeys.add(key);
  }

  return txThisYear
    .filter((tx: any) => {
      if (tx.Status === "DELETED") return false;
      if (tx.Type !== "SPEND" && tx.Type !== "SPEND-OVERPAYMENT" &&
          tx.Type !== "RECEIVE" && tx.Type !== "RECEIVE-OVERPAYMENT") return false;
      const d = parseXeroDateObj(tx.Date);
      if (!d) return false;
      const isSpend = tx.Type === "SPEND" || tx.Type === "SPEND-OVERPAYMENT";
      const key = `${toISO(d)}|${(tx.Total||0).toFixed(2)}`;
      if (isSpend && billPaymentKeys.has(key))    return false;
      if (!isSpend && invoiceReceiptKeys.has(key)) return false;
      return true;
    })
    .map((tx: any) => {
      const d = parseXeroDateObj(tx.Date)!;
      const isSpend = tx.Type === "SPEND" || tx.Type === "SPEND-OVERPAYMENT";
      const firstLine = (tx.LineItems || [])[0];
      return {
        date: toISO(d), month: toLocalMonth(d),
        contact: tx.Contact?.Name || "(no contact)",
        type: tx.Type, reference: tx.Reference || "",
        amount: isSpend ? (tx.Total || 0) : -(tx.Total || 0),
        totalTax: tx.TotalTax || 0,
        source: isSpend ? "DirectSpend" : "DirectReceive",
        accountCode: firstLine?.AccountCode || "",
        lineDescription: firstLine?.Description || "",
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function getCostSettings(env: Env): Promise<CostSettings> {
  try {
    const stored = await env.XERO_KV.get("cost_settings", "json") as Partial<CostSettings> | null;
    if (!stored) return { ...DEFAULT_COST_SETTINGS };
    return { ...DEFAULT_COST_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_COST_SETTINGS };
  }
}

async function handleSettingsGet(env: Env): Promise<Response> {
  const settings = await getCostSettings(env);
  return Response.json(settings, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleSettingsPost(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as Partial<CostSettings>;
    const current = await getCostSettings(env);
    const updated: CostSettings = { ...current, ...body };
    await env.XERO_KV.put("cost_settings", JSON.stringify(updated));
    geocodeCache.clear();
    return Response.json({ ok: true, settings: updated }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (e: any) {
    return new Response("Bad request: " + e.message, { status: 400 });
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
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

// Full ISO date (YYYY-MM-DD) from either /Date(ms)/ or ISO string
function parseXeroDateFull(val: string | undefined | null): string {
  if (!val) return "";
  const ms = val.match(/\/Date\((\d+)/);
  if (ms) {
    const d = new Date(parseInt(ms[1]));
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const dy = String(d.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${dy}`;
  }
  return val.substring(0, 10);
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

// Get month as YYYY-MM using LOCAL time (not UTC) to avoid BST timezone shift
function toLocalMonth(d: Date): string {
  const yr = d.getFullYear();
  const mo = d.getMonth() + 1;
  return `${yr}-${mo < 10 ? '0' + mo : mo}`;
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

// ─── Sonderplan pipeline fetch ────────────────────────────────────────────────
async function fetchSonderplanPipeline(
  token: string,
  fromTime: number,
  toTime: number,
  costSettings: CostSettings,
  requirePrice: boolean = true
): Promise<PipelineItem[]> {
  const PIPELINE_STATUSES = new Set(["Confirmed", "Provisional", "PAID", "Info Complete & Invoiced"]);
  const EXCLUDED_STATUSES = new Set(["Cancelled", "Passed on", "Unavailable", "Waiting List", "Set up/ Pack down/Travel"]);

  const headers = {
    Authorization:  `Bearer ${token}`,
    Accept:         "application/json",
    "Content-Type": "application/json",
  };

  const effectiveFrom = fromTime;
  let allRows: any[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${SP_API_BASE}/booking?page=${page}&limit=25&from_time=${effectiveFrom}&to_time=${toTime}&resource_parent=true`;
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) { console.error("SP fetch failed:", res.status); break; }
    const json: any = await res.json();
    if (page === 1) totalPages = json.meta?.pagination?.total_pages || 1;
    if (!json.data || json.data.length === 0) break;
    allRows = allRows.concat(json.data);
    page++;
  } while (page <= totalPages);

  const seen = new Set<string>();
  const pipeline: PipelineItem[] = [];

  const getField = (customFields: any[], ...names: string[]): string | null => {
    for (const name of names) {
      const f = customFields.find((cf: any) => cf.name?.toLowerCase() === name.toLowerCase());
      if (f?.value) return f.value;
    }
    return null;
  };

  const allPostcodes: string[] = [costSettings.basePostcode];
  for (const row of allRows) {
    if (row.deleted) continue;
    const cf = row.custom_fields || [];
    const addr = cf.find((f: any) =>
      ["address","venue address","event address","location"].includes((f.name || "").toLowerCase())
    )?.value || null;
    if (addr) { const pc = extractPostcode(addr); if (pc) allPostcodes.push(pc); }
  }
  await bulkGeocodePostcodes(allPostcodes);

  for (const row of allRows) {
    if (row.deleted) continue;

    const statusRaw = row.status?.[0]?.name || "";
    const status = statusRaw.trim();
    const statusLower = status.toLowerCase();
    const isPipelineStatus =
      PIPELINE_STATUSES.has(status) ||
      statusLower === "paid" ||
      statusLower === "invoiced" ||
      statusLower.includes("info complete") ||
      statusLower.includes("confirmed");
    if (!status || !isPipelineStatus) continue;
    if (EXCLUDED_STATUSES.has(status)) continue;

    const resources    = row.resources || [];
    const activeRes    = resources.filter((r: any) => !r.deleted);
    const mobilooRes   = activeRes.filter((r: any) => r.parent_id === MOBILOO_PARENT_ID);
    if (mobilooRes.length === 0) continue;

    const dedupKey = `${row.name}__${row.start}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const cf = row.custom_fields || [];
    const rawPrice = getField(cf, "Quoted Price");
    const parsed   = parseQuotedPrice(rawPrice);
    if (requirePrice) {
      if (parsed.flag === "Complex" || parsed.flag === "No Quote") continue;
      if (parsed.price === null || parsed.price === 0) continue;
    }

    const eventStart = row.start ? new Date(row.start * 1000) : null;
    if (!eventStart) continue;

    const eventEnd  = row.end ? new Date(row.end * 1000) : eventStart;
    const rawDays   = Math.round((eventEnd.getTime() - eventStart.getTime()) / 86400000);
    const eventDays = Math.max(rawDays, 1);

    const addressRaw    = getField(cf, "Address", "Venue Address", "Event Address", "Location");
    const opHoursRaw    = getField(cf, "Operational Hours", "Op Hours", "Hours", "Event Hours");

    const opHoursPerDay         = parseOperationalHours(opHoursRaw);
    const operationalHoursTotal = opHoursPerDay !== null ? opHoursPerDay * eventDays : null;
    const opHoursSource         = opHoursPerDay !== null ? "Sonderplan" : "Fallback";

    const resourceTypeNames: string[] = mobilooRes.map((r: any) => (r.name || "").trim()).filter(Boolean);

    const paymentDate = new Date(eventStart);
    paymentDate.setMonth(paymentDate.getMonth() - 1);

    const isPast = eventStart < new Date();
    const isPaid = statusLower === "paid" || statusLower === "invoiced";

    if (resourceTypeNames.length <= 1) {
      const costs = await estimateEventCosts(addressRaw, 1, resourceTypeNames, operationalHoursTotal, eventDays, costSettings);
      pipeline.push({
        id:               `${row.id}`,
        bookingId:        `${row.id}`,
        name:             row.name,
        status, isPast, isPaid,
        eventStart:       toISO(eventStart),
        eventEnd:         toISO(eventEnd),
        eventDays,
        paymentDate:      toISO(paymentDate),
        price:            parsed.price,
        priceFlag:        parsed.flag,
        rawPrice,
        unitCount:        Math.max(resourceTypeNames.length, 1),
        resourceTypes:    resourceTypeNames,
        address:          addressRaw,
        operationalHours: operationalHoursTotal,
        opHoursPerDay,
        opHoursSource,
        costs,
      });
    } else {
      const sharedOpHours = operationalHoursTotal !== null
        ? operationalHoursTotal / resourceTypeNames.length
        : null;
      const multiFlag = (parsed.flag ? parsed.flag + " | " : "") + "Shared op hours";

      for (let i = 0; i < resourceTypeNames.length; i++) {
        const resourceName = resourceTypeNames[i];
        const unitPrice    = i === 0 ? parsed.price : null;
        const costs = await estimateEventCosts(addressRaw, 1, [resourceName], sharedOpHours, eventDays, costSettings);
        pipeline.push({
          id:               `${row.id}-${i}`,
          bookingId:        `${row.id}`,
          name:             row.name,
          status, isPast, isPaid,
          eventStart:       toISO(eventStart),
          eventEnd:         toISO(eventEnd),
          eventDays,
          paymentDate:      toISO(paymentDate),
          price:            unitPrice,
          priceFlag:        multiFlag,
          rawPrice,
          unitCount:        1,
          resourceTypes:    [resourceName],
          address:          addressRaw,
          operationalHours: sharedOpHours,
          opHoursPerDay,
          opHoursSource,
          costs,
        });
      }
    }
  }

  return pipeline;
}

// ─── Router ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url  = new URL(request.url);
    const path = url.pathname.toLowerCase().replace(/\/+$/, "");
    const method = request.method.toUpperCase();

    if (path === "/auth/callback")         return handleCallback(url, env);
    if (path === "/auth")                  return redirectToXero(env);
    if (path === "/dashboard")             return serveDashboard();
    if (path === "/forecast")              return serveForecast();
    if (path === "/settings")              return serveSettings();
    if (path === "/api/cashflow")          return handleCashflow(env);
    if (path === "/api/invoices")          return callXeroAPI(env, '/Invoices?where=Status%3D%3D%22AUTHORISED%22&order=DueDate+ASC');
    if (path === "/api/bills")             return callXeroAPI(env, '/Invoices?where=Status%3D%3D%22AUTHORISED%22%26%26Type%3D%3D%22ACCPAY%22&order=DueDate+ASC');
    if (path === "/api/invoices-by-month") return handleInvoicesByMonth(env);
    if (path === "/api/cashburn")          return handleCashBurn(env);
    if (path === "/api/bankbalance")       return handleBankBalance(env);
    if (path === "/api/bankdebug")         return handleBankDebug(env);
    if (path === "/api/pnl")               return handleProfitAndLoss(env);
    if (path === "/api/forecast")          return handleForecast(env);
    if (path === "/api/events/all")        return handleAllEvents(env);
    if (path === "/api/pipeline")          return handlePipeline(env);
    if (path === "/api/sp-debug")          return handleSpDebug(env);
    if (path === "/api/xero/invoices")     return handleXeroInvoices(request, env);
    if (path === "/api/xero/outgoings")    return handleXeroOutgoings(request, env);
    if (path === "/api/xero/balancesheet") return handleXeroBalanceSheet(request, env);
    if (path === "/api/xero/banktx-check") return handleBankTxCheck(env);
    if (path === "/api/xero/bankstatement") return handleXeroBankStatement(request, env);
    if (path === "/api/xero/payments")      return handleXeroPayments(request, env);
    if (path === "/api/xero/cashflow-data") return handleXeroCashflowData(request, env);
    if (path === "/api/xero/bank-transactions-detail") return handleXeroBankTransactionsDetail(request, env);
    if (path === "/api/xero/pnl-by-code") return handleXeroPnlByCode(request, env);
    if (path === "/api/xero/outgoings-debug") return handleXeroOutgoingsDebug(env);
    if (path === "/api/settings") {
      if (method === "GET")  return handleSettingsGet(env);
      if (method === "POST") return handleSettingsPost(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    return new Response("Xero Worker running. Visit /dashboard or /forecast");
  },
};

// ─── Xero auth ────────────────────────────────────────────────────────────────
function redirectToXero(env: Env): Response {
  const params = new URLSearchParams({
    response_type: "code", response_mode: "query", client_id: env.XERO_CLIENT_ID,
    redirect_uri: env.XERO_REDIRECT_URI,
    scope: ["openid","profile","email","offline_access",
      "accounting.invoices","accounting.payments",
      "accounting.banktransactions","accounting.manualjournals",
      "accounting.settings",
      "accounting.reports.balancesheet.read",
      "accounting.reports.banksummary.read"].join(" "),
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

// ─── API handlers ─────────────────────────────────────────────────────────────
async function handlePipeline(env: Env): Promise<Response> {
  if (!env.SONDERPLAN_TOKEN) return new Response("SONDERPLAN_TOKEN not configured", { status: 500 });
  const now      = new Date();
  const fromTime = Math.floor(now.getTime() / 1000);
  const toTime   = Math.floor(addDays(now, 34 * 7).getTime() / 1000);
  const settings = await getCostSettings(env);
  try {
    const pipeline = await fetchSonderplanPipeline(env.SONDERPLAN_TOKEN, fromTime, toTime, settings);
    return Response.json({ pipeline, count: pipeline.length }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (e: any) { return new Response("Sonderplan error: " + e.message, { status: 500 }); }
}

async function handleAllEvents(env: Env): Promise<Response> {
  if (!env.SONDERPLAN_TOKEN) return new Response("SONDERPLAN_TOKEN not configured", { status: 500 });
  const settings  = await getCostSettings(env);
  const yearStart = Math.floor(new Date(new Date().getFullYear(), 0, 1).getTime() / 1000);
  const yearEnd   = Math.floor(new Date(new Date().getFullYear(), 11, 31, 23, 59, 59).getTime() / 1000);
  try {
    const events = await fetchSonderplanPipeline(env.SONDERPLAN_TOKEN, yearStart, yearEnd, settings, false);
    return Response.json({
      year: new Date().getFullYear(),
      count: events.length,
      generatedAt: new Date().toISOString(),
      events,
    }, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (e: any) {
    return new Response("Error: " + e.message, { status: 500 });
  }
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
  const url      = `${SP_API_BASE}/booking?page=1&limit=5&from_time=${fromTime}&to_time=${toTime}`;

  const res      = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${env.SONDERPLAN_TOKEN}`, Accept: "application/json", "Content-Type": "application/json" },
  });

  const httpStatus = res.status;
  const rawText    = await res.text();
  let parsed: any  = null;
  try { parsed = JSON.parse(rawText); } catch {}

  const customFieldsSeen = new Map<string, number>();
  for (const row of (parsed?.data || [])) {
    for (const cf of (row.custom_fields || [])) {
      if (cf.name && cf.id) customFieldsSeen.set(cf.name, cf.id);
    }
  }

  const settings = await getCostSettings(env);
  let pipelinePreview: PipelineItem[] = [];
  try { pipelinePreview = await fetchSonderplanPipeline(env.SONDERPLAN_TOKEN, fromTime, toTime, settings); } catch {}

  return Response.json({
    tokenCheck, httpStatus, settings,
    rawTextPreview: rawText.substring(0, 800),
    meta: parsed?.meta || null,
    total_rows_page1: parsed?.data?.length || 0,
    custom_fields_seen: Object.fromEntries(customFieldsSeen),
    first_booking: parsed?.data?.[0] ? {
      id:            parsed.data[0].id,
      name:          parsed.data[0].name,
      start_as_date: parsed.data[0].start ? new Date(parsed.data[0].start * 1000).toISOString() : null,
      status_raw:    parsed.data[0].status,
      custom_fields: parsed.data[0].custom_fields,
    } : null,
    pipeline_after_filter: {
      count: pipelinePreview.length,
      items: pipelinePreview.slice(0, 5).map(p => ({
        name: p.name, status: p.status, eventStart: p.eventStart, eventEnd: p.eventEnd,
        eventDays: p.eventDays, unitCount: p.unitCount, address: p.address,
        operationalHours: p.operationalHours, costs: p.costs,
        price: p.price, priceFlag: p.priceFlag,
      })),
    },
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleForecast(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" };

  const weekStart  = startOfThisWeek();
  const weekEnd    = addDays(weekStart, 34 * 7 - 1);
  const spFromTime = Math.floor(weekStart.getTime() / 1000);
  const spToTime   = Math.floor(weekEnd.getTime() / 1000);
  const settings   = await getCostSettings(env);

  const [invRes, billRes, txRes, spPipeline] = await Promise.all([
    fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22AUTHORISED%22%26%26Type%3D%3D%22ACCREC%22`, { headers: h }),
    fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22AUTHORISED%22%26%26Type%3D%3D%22ACCPAY%22`, { headers: h }),
    fetch(`${XERO_API_BASE}/BankTransactions`, { headers: h }),
    env.SONDERPLAN_TOKEN
      ? fetchSonderplanPipeline(env.SONDERPLAN_TOKEN, spFromTime, spToTime, settings).catch(() => [])
      : Promise.resolve([]),
  ]);

  const [invData, billData, txData] = await Promise.all([
    invRes.json() as any, billRes.json() as any, txRes.json() as any,
  ]);

  interface LineItem {
    ref: string; contact: string; amount: number; due: string; type: string;
    source: "xero" | "sonderplan" | "staff-estimate";
    status?: string; priceFlag?: string;
    unitCount?: number; eventDays?: number; miles?: number; nights?: number; breakdown?: string;
  }
  interface WeekBucket {
    weekStart: string; weekEnd: string; label: string;
    inflows: LineItem[]; outflows: LineItem[];
    totalIn: number; totalOut: number;
    confirmedIn: number; pipelineIn: number;
    estimatedCosts: number;
    net: number; runningBalance: number;
  }

  const weeks: WeekBucket[] = [];
  for (let i = 0; i < 34; i++) {
    const ws = addDays(weekStart, i * 7), we = addDays(ws, 6);
    weeks.push({
      weekStart: toISO(ws), weekEnd: toISO(we),
      label: `W${i+1} ${ws.toLocaleDateString("en-GB", { day:"numeric", month:"short", year: i===0 || ws.getMonth()===0 ? "2-digit" : undefined })}`,
      inflows: [], outflows: [],
      totalIn: 0, totalOut: 0, confirmedIn: 0, pipelineIn: 0, estimatedCosts: 0,
      net: 0, runningBalance: 0,
    });
  }

  function getWeekIndex(d: Date): number {
    return Math.floor((d.getTime() - weekStart.getTime()) / (86400000 * 7));
  }

  for (const inv of invData.Invoices || []) {
    const due = parseXeroDateObj(inv.DueDate); if (!due) continue;
    const wi  = getWeekIndex(due); if (wi < 0 || wi >= 34) continue;
    const amount = inv.AmountDue || 0;
    weeks[wi].inflows.push({ ref: inv.InvoiceNumber||"—", contact: inv.Contact?.Name||"—", amount, due: toISO(due), type:"Invoice", source:"xero" });
    weeks[wi].totalIn += amount; weeks[wi].confirmedIn += amount;
  }

  for (const item of spPipeline as PipelineItem[]) {
    const payDate = new Date(item.paymentDate);
    const wiPay   = getWeekIndex(payDate);
    if (wiPay >= 0 && wiPay < 34) {
      weeks[wiPay].inflows.push({
        ref: item.id, contact: item.name, amount: item.price, due: item.paymentDate,
        type: item.status === "Confirmed" ? "Confirmed Event" : "Provisional Event",
        source: "sonderplan", status: item.status, priceFlag: item.priceFlag,
      });
      weeks[wiPay].totalIn    += item.price;
      weeks[wiPay].pipelineIn += item.price;
    }

    if (item.costs.total > 0) {
      const wiEvent = getWeekIndex(new Date(item.eventStart));
      if (wiEvent >= 0 && wiEvent < 34) {
        weeks[wiEvent].outflows.push({
          ref: item.id, contact: item.name, amount: item.costs.total, due: item.eventStart,
          type: "Est. Event Cost", source: "staff-estimate",
          unitCount: item.unitCount, eventDays: item.eventDays,
          miles: item.costs.miles, nights: item.costs.nights,
          breakdown: item.costs.breakdown,
        });
        weeks[wiEvent].totalOut        += item.costs.total;
        weeks[wiEvent].estimatedCosts  += item.costs.total;
      }
    }
  }

  for (const bill of billData.Invoices || []) {
    const due = parseXeroDateObj(bill.DueDate); if (!due) continue;
    const wi  = getWeekIndex(due); if (wi < 0 || wi >= 34) continue;
    const amount = bill.AmountDue || 0;
    weeks[wi].outflows.push({ ref: bill.InvoiceNumber||bill.Reference||"—", contact: bill.Contact?.Name||"—",
      amount, due: toISO(due), type:"Bill", source:"xero" });
    weeks[wi].totalOut += amount;
  }

  const txList        = (txData.BankTransactions||[]).filter((tx: any) => tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT");
  const spendGroups: Record<string, { dates: Date[]; amount: number; name: string }> = {};
  const ninetyDaysAgo = addDays(new Date(), -90);
  for (const tx of txList) {
    const d = parseXeroDateObj(tx.Date); if (!d || d < ninetyDaysAgo) continue;
    const name   = tx.Contact?.Name||tx.Reference||"Unknown";
    const amount = Math.round((tx.Total||0)/10)*10;
    const key    = `${name}__${amount}`;
    if (!spendGroups[key]) spendGroups[key] = { dates: [], amount: tx.Total||0, name };
    spendGroups[key].dates.push(d);
  }
  for (const group of Object.values(spendGroups)) {
    if (group.dates.length < 2) continue;
    group.dates.sort((a,b) => a.getTime()-b.getTime());
    let totalGap = 0;
    for (let i=1; i<group.dates.length; i++) totalGap += (group.dates[i].getTime()-group.dates[i-1].getTime())/86400000;
    const avgGap    = totalGap / (group.dates.length - 1);
    const isMonthly = avgGap >= 20 && avgGap <= 40;
    const isWeekly  = avgGap >= 5  && avgGap <= 9;
    if (!isMonthly && !isWeekly) continue;
    let nextDate = addDays(group.dates[group.dates.length-1], Math.round(avgGap));
    while (nextDate <= weekEnd) {
      const wi = getWeekIndex(nextDate);
      if (wi >= 0 && wi < 13) {
        weeks[wi].outflows.push({ ref:"Recurring", contact:group.name, amount:group.amount,
          due:toISO(nextDate), type:isMonthly?"Est. Monthly":"Est. Weekly", source:"xero" });
        weeks[wi].totalOut += group.amount;
      }
      nextDate = addDays(nextDate, Math.round(avgGap));
    }
  }

  let openingBalance = 0;
  for (const tx of txData.BankTransactions||[]) {
    const d = parseXeroDateObj(tx.Date); if (!d || d >= weekStart) continue;
    const amount = tx.Total||0;
    if (tx.Type==="RECEIVE"||tx.Type==="RECEIVE-OVERPAYMENT") openingBalance += amount;
    else if (tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT") openingBalance -= amount;
  }

  let running = openingBalance;
  for (const week of weeks) { week.net = week.totalIn - week.totalOut; running += week.net; week.runningBalance = running; }

  const allPipeline      = spPipeline as PipelineItem[];
  const today            = new Date(); today.setHours(0,0,0,0);
  const futureItems      = allPipeline.filter(p => new Date(p.eventStart) >= today);
  const pastItems        = allPipeline.filter(p => new Date(p.eventStart) <  today);
  const confirmedTotal   = futureItems.filter(p => p.status==="Confirmed").reduce((a,p) => a+p.price, 0);
  const provisionalTotal = futureItems.filter(p => p.status==="Provisional").reduce((a,p) => a+p.price, 0);
  const totalEstimatedCosts = futureItems.reduce((a,p) => a+p.costs.total, 0);
  const beyondWindow = futureItems
    .filter(p => { const wi = getWeekIndex(new Date(p.paymentDate)); return (wi<0 && new Date(p.paymentDate)>=today) || wi>=34; })
    .sort((a,b) => a.paymentDate.localeCompare(b.paymentDate));

  const uninvoicedWarnings = pastItems
    .sort((a,b) => b.eventStart.localeCompare(a.eventStart))
    .map(p => ({
      ...p,
      warningNote: "Event date passed — still Confirmed/Provisional in Sonderplan. Check whether invoice has been raised and paid in Xero.",
    }));

  return Response.json({
    openingBalance,
    generatedAt: new Date().toISOString(),
    forecastFrom: toISO(weekStart),
    forecastTo: toISO(weekEnd),
    sonderplanConnected: !!env.SONDERPLAN_TOKEN,
    costSettings: settings,
    pipeline: {
      confirmedTotal, provisionalTotal, totalEstimatedCosts,
      itemCount:     futureItems.length,
      inWindowCount: futureItems.length - beyondWindow.length,
      beyondWindow,
      allItems:      futureItems,
    },
    uninvoicedWarnings,
    uninvoicedCount:      uninvoicedWarnings.length,
    uninvoicedTotalValue: uninvoicedWarnings.reduce((a,p) => a+p.price, 0),
    weeks,
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleBankDebug(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" };

  const res = await fetch(`${XERO_API_BASE}/Accounts?where=Type%3D%3D%22BANK%22`, { headers: h });
  const raw = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch {}

  let singleRaw = null;
  const firstId = parsed?.Accounts?.[0]?.AccountID;
  if (firstId) {
    const sr = await fetch(`${XERO_API_BASE}/Accounts/${firstId}`, { headers: h });
    singleRaw = await sr.json();
  }

  return Response.json({
    status: res.status,
    accountCount: parsed?.Accounts?.length || 0,
    firstAccountAllFields: parsed?.Accounts?.[0] || null,
    singleAccountFetch: singleRaw?.Accounts?.[0] || null,
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

async function handleBankBalance(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" };

  const accRes = await fetch(`${XERO_API_BASE}/Accounts?where=Type%3D%3D%22BANK%22%26%26EnablePaymentsToAccount%3D%3Dtrue`, { headers: h });
  if (accRes.ok) {
    const accData: any = await accRes.json();
    const bankAccounts = (accData.Accounts || [])
      .filter((a: any) => typeof a.Balance === "number")
      .map((a: any) => ({ name: a.Name, balance: a.Balance as number }));
    const total = bankAccounts.reduce((sum: number, a: any) => sum + a.balance, 0);
    if (bankAccounts.length > 0) {
      return Response.json({ total, accounts: bankAccounts, source: "accounts-endpoint" },
        { headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }

  const allAccRes = await fetch(`${XERO_API_BASE}/Accounts?where=Type%3D%3D%22BANK%22`, { headers: h });
  if (allAccRes.ok) {
    const allAccData: any = await allAccRes.json();
    const ids: string[] = (allAccData.Accounts || []).map((a: any) => a.AccountID).filter(Boolean);
    const bankAccounts: { name: string; balance: number }[] = [];
    for (const id of ids) {
      const singleRes = await fetch(`${XERO_API_BASE}/Accounts/${id}`, { headers: h });
      if (!singleRes.ok) continue;
      const singleData: any = await singleRes.json();
      const acc = singleData.Accounts?.[0];
      if (acc && typeof acc.Balance === "number") {
        bankAccounts.push({ name: acc.Name, balance: acc.Balance });
      }
    }
    const total = bankAccounts.reduce((sum, a) => sum + a.balance, 0);
    if (bankAccounts.length > 0) {
      return Response.json({ total, accounts: bankAccounts, source: "accounts-individual" },
        { headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }

  const today = new Date().toISOString().substring(0, 10);
  const bsRes = await fetch(`${XERO_API_BASE}/Reports/BalanceSheet?date=${today}`, { headers: h });
  if (bsRes.ok) {
    const bsData: any = await bsRes.json();
    const bankAccounts: { name: string; balance: number }[] = [];
    let total = 0;
    const walkRows = (rows: any[]) => {
      for (const row of rows || []) {
        if (row.RowType === "Section" && row.Title?.toLowerCase().includes("bank")) {
          for (const r of row.Rows || []) {
            if (r.RowType === "Row" && r.Cells?.length >= 2) {
              const name = r.Cells[0]?.Value || "";
              const balance = parseFloat((r.Cells[r.Cells.length-1]?.Value || "0").replace(/[^0-9.-]/g, ""));
              if (name && !isNaN(balance) && name !== "Bank accounts") {
                bankAccounts.push({ name, balance }); total += balance;
              }
            }
          }
        }
        if (row.Rows) walkRows(row.Rows);
      }
    };
    walkRows(bsData.Reports?.[0]?.Rows || []);
    if (bankAccounts.length > 0) {
      return Response.json({ total, accounts: bankAccounts, source: "balance-sheet-report" },
        { headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }

  return Response.json({ total: null, accounts: [], source: "unavailable",
    note: "Could not retrieve bank balance — Xero account may need accounting.reports.read scope" },
    { headers: { "Access-Control-Allow-Origin": "*" } });
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
    const date = parseXeroDate(tx.Date); if (!date) continue;
    if (!monthly[date]) monthly[date] = {inflow:0,outflow:0,net:0};
    const amount: number = tx.Total||0;
    if (tx.Type==="RECEIVE"||tx.Type==="RECEIVE-OVERPAYMENT") monthly[date].inflow += amount;
    else if (tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT") monthly[date].outflow += amount;
    monthly[date].net = monthly[date].inflow - monthly[date].outflow;
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
  const now = new Date(); now.setHours(0,0,0,0);
  for (const inv of data.Invoices||[]) {
    const due = parseXeroDateObj(inv.DueDate); if (!due) continue;
    const month = due.toISOString().substring(0,7), amount = inv.AmountDue||0, isOver = due<now;
    if (!byMonth[month]) byMonth[month] = {total:0,count:0,overdue:0,invoices:[]};
    byMonth[month].total += amount; byMonth[month].count += 1;
    if (isOver) byMonth[month].overdue += amount;
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
    const date = parseXeroDate(tx.Date); if (!date) continue;
    if (!monthly[date]) monthly[date] = {spend:0,receive:0,net:0};
    const amount: number = tx.Total||0;
    if (tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT") monthly[date].spend += amount;
    else if (tx.Type==="RECEIVE"||tx.Type==="RECEIVE-OVERPAYMENT") monthly[date].receive += amount;
    monthly[date].net = monthly[date].receive - monthly[date].spend;
  }
  const sorted = Object.entries(monthly).sort(([a],[b])=>a.localeCompare(b));
  let running = 0;
  const result: Record<string,any> = {};
  for (const [month,vals] of sorted) { running += vals.net; result[month] = {...vals, runningBalance: running}; }
  return Response.json(result, { headers: { "Access-Control-Allow-Origin":"*" } });
}

async function handleProfitAndLoss(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const year = new Date().getFullYear();
  const h = { Authorization:`Bearer ${tokens.access_token}`, "Xero-tenant-id":tokens.tenant_id, Accept:"application/json" };
  const [invRes,txRes] = await Promise.all([
    fetch(`${XERO_API_BASE}/Invoices?where=Status%3D%3D%22PAID%22&fromDate=${year}-01-01&toDate=${year}-12-31`, {headers:h}),
    fetch(`${XERO_API_BASE}/BankTransactions?fromDate=${year}-01-01&toDate=${year}-12-31`, {headers:h}),
  ]);
  if (!invRes.ok) return new Response("Failed invoices: "+await invRes.text(), {status:500});
  if (!txRes.ok)  return new Response("Failed tx: "+await txRes.text(), {status:500});
  const invData: any = await invRes.json(), txData: any = await txRes.json();
  const months: string[] = [];
  for (let m=1; m<=12; m++) months.push(`${year}-${String(m).padStart(2,"0")}`);
  const pnl: Record<string,{income:number;expenses:number;profit:number}> = {};
  for (const m of months) pnl[m] = {income:0,expenses:0,profit:0};
  for (const inv of invData.Invoices||[]) {
    const date = parseXeroDate(inv.FullyPaidOnDate)||parseXeroDate(inv.Date);
    if (!date||!pnl[date]) continue; pnl[date].income += inv.Total||0;
  }
  for (const tx of txData.BankTransactions||[]) {
    const date = parseXeroDate(tx.Date); if (!date||!pnl[date]) continue;
    if (tx.Type==="SPEND"||tx.Type==="SPEND-OVERPAYMENT") pnl[date].expenses += tx.Total||0;
  }
  for (const m of months) pnl[m].profit = pnl[m].income - pnl[m].expenses;
  return Response.json(pnl, {headers:{"Access-Control-Allow-Origin":"*"}});
}

// ─── NEW: Xero invoices for current year (AUTHORISED + PAID, ACCREC) ──────────
async function handleXeroInvoices(request: Request, env: Env): Promise<Response> {
  const CACHE_KEY = `cache_invoices_${new Date().getFullYear()}`;
  if (!wantsRefresh(request)) {
    const cached = await getCached<any>(env, CACHE_KEY);
    if (cached) return Response.json(cached, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "HIT" } });
  }
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept: "application/json",
  };

  const year     = new Date().getFullYear();
  const fromDate = `${year}-01-01`;
  const toDate   = `${year}-12-31`;

  const where = encodeURIComponent(
    `Type=="ACCREC"&&(Status=="AUTHORISED"||Status=="PAID")&&DateString>="${fromDate}"&&DateString<="${toDate}"`
  );

  const res = await fetch(`${XERO_API_BASE}/Invoices?where=${where}&order=DateString+ASC`, { headers: h });
  if (!res.ok) {
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  const data: any = await res.json();
  const invoices = (data.Invoices || []).map((inv: any) => ({
    invoiceNumber: inv.InvoiceNumber || "",
    reference:     inv.Reference || "",
    contact:       inv.Contact?.Name || "",
    date:          parseXeroDateFull(inv.Date),
    dueDate:       parseXeroDateFull(inv.DueDate),
    paidDate:      inv.FullyPaidOnDate ? parseXeroDateFull(inv.FullyPaidOnDate) : "",
    status:        inv.Status || "",
    subTotal:      inv.SubTotal   || 0,   // net of VAT
    totalTax:      inv.TotalTax   || 0,
    total:         inv.Total      || 0,   // inc VAT
    amountDue:     inv.AmountDue  || 0,
    amountPaid:    inv.AmountPaid || 0,
  }));

  const result = { year, count: invoices.length, invoices };
  await setCached(env, CACHE_KEY, result);
  return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "MISS" } });
}

// ─── Outgoings by contact — BILLS ONLY (fast, rate-limit safe) ───────────────
// Bank transactions removed — too slow/rate-limited. The cashflow-data endpoint
// handles direct bank transactions for the cash flow sheet. This endpoint only
// needs bills for the contact categorisation tab.
async function handleXeroOutgoings(request: Request, env: Env): Promise<Response> {
  const CACHE_KEY = `cache_outgoings_${new Date().getFullYear()}`;
  if (!wantsRefresh(request)) {
    const cached = await getCached<any>(env, CACHE_KEY);
    if (cached) return Response.json(cached, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "HIT" } });
  }
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept: "application/json",
  };

  const year     = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1);
  const yearEnd   = new Date(year, 11, 31, 23, 59, 59);
  const fromDate  = `${year}-01-01`;

  // Fetch chart of accounts — one call, no pagination, gives account code → name mapping
  const accountsRes = await fetch(`${XERO_API_BASE}/Accounts`, { headers: h });
  const accountsData: any = accountsRes.ok ? await accountsRes.json() : { Accounts: [] };
  const accountMap: Record<string, string> = {};
  for (const acct of accountsData.Accounts || []) {
    if (acct.Code) accountMap[acct.Code] = `${acct.Code} — ${acct.Name}`;
  }

  // Fetch only ACCPAY bills — small dataset, fast
  let allBills: any[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${XERO_API_BASE}/Invoices?where=${encodeURIComponent('Type=="ACCPAY"')}&fromDate=${fromDate}&order=Date+DESC&summaryOnly=false&page=${page}`,
      { headers: h }
    );
    if (!res.ok) break;
    const data: any = await res.json();
    const records = data.Invoices || [];
    allBills = allBills.concat(records);
    if (records.length < 100) break;
    page++;
    if (page > 10) break; // safety cap
  }

  const billsThisYear = allBills.filter((b: any) => {
    const d = parseXeroDateObj(b.Date);
    return d && d >= yearStart && d <= yearEnd && b.Status !== "DELETED";
  });

  // Aggregate by contact
  interface ContactUsage {
    contact: string;
    billCount: number; billTotal: number;
    directSpendCount: number; directSpendTotal: number;
    directReceiveCount: number; directReceiveTotal: number;
    grandTotal: number;
  }
  const byContact: Record<string, ContactUsage> = {};

  for (const bill of billsThisYear) {
    const contact = bill.Contact?.Name || "(no contact)";
    if (!byContact[contact]) {
      byContact[contact] = {
        contact, billCount: 0, billTotal: 0,
        directSpendCount: 0, directSpendTotal: 0,
        directReceiveCount: 0, directReceiveTotal: 0,
        grandTotal: 0,
      };
    }
    byContact[contact].billCount++;
    byContact[contact].billTotal  += bill.Total || 0;
    byContact[contact].grandTotal += bill.Total || 0;
  }

  const contactList = Object.keys(byContact)
    .map(k => byContact[k])
    .sort((a, b) => b.grandTotal - a.grandTotal);

  // Monthly bill breakdown
  const byMonth: Record<string, { billTotal: number; billCount: number; directSpendTotal: number; directSpendCount: number; directReceiveTotal: number; directReceiveCount: number }> = {};
  for (const bill of billsThisYear) {
    const d = parseXeroDateObj(bill.Date); if (!d) continue;
    const month = d.toISOString().substring(0, 7);
    if (!byMonth[month]) byMonth[month] = { billTotal: 0, billCount: 0, directSpendTotal: 0, directSpendCount: 0, directReceiveTotal: 0, directReceiveCount: 0 };
    byMonth[month].billTotal += bill.Total || 0;
    byMonth[month].billCount++;
  }

  // Flat transaction list — bills only
  interface OutgoingTxn {
    date: string; month: string; contact: string;
    type: string; reference: string; invoiceNumber: string;
    amount: number; totalTax: number; status: string; source: string;
    accountCode: string; accountName: string; lineDescription: string;
  }
  const transactions: OutgoingTxn[] = [];
  for (const bill of billsThisYear) {
    const d = parseXeroDateObj(bill.Date); if (!d) continue;
    const lineItems: any[] = bill.LineItems || [];
    if (lineItems.length > 0) {
      for (const line of lineItems) {
        const code = line.AccountCode || "";
        transactions.push({
          date: toISO(d), month: toLocalMonth(d),
          contact: bill.Contact?.Name || "(no contact)",
          type: "Bill", reference: bill.Reference || "",
          invoiceNumber: bill.InvoiceNumber || "",
          amount: line.LineAmount || 0,
          totalTax: line.TaxAmount || 0,
          status: bill.Status || "",
          source: "Bill",
          accountCode: code,
          accountName: accountMap[code] || code,
          lineDescription: line.Description || "",
        });
      }
    } else {
      transactions.push({
        date: toISO(d), month: toLocalMonth(d),
        contact: bill.Contact?.Name || "(no contact)",
        type: "Bill", reference: bill.Reference || "",
        invoiceNumber: bill.InvoiceNumber || "",
        amount: bill.SubTotal || 0, totalTax: bill.TotalTax || 0, status: bill.Status || "",
        source: "Bill", accountCode: "", accountName: "", lineDescription: "",
      });
    }
  }
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  const result = {
    year,
    billCount: billsThisYear.length,
    directSpendCount: 0,
    directReceiveCount: 0,
    totalBillSpend: billsThisYear.reduce((a: number, b: any) => a + (b.Total || 0), 0),
    totalDirectSpend: 0,
    totalDirectReceive: 0,
    accountCount: Object.keys(accountMap).length,
    note: "Bills only — direct bank transactions now handled by /cashflow-data endpoint",
    contactCount: contactList.length,
    byContact: contactList,
    byMonth: Object.fromEntries(Object.entries(byMonth).sort()),
    transactionCount: transactions.length,
    transactions,
  };
  await setCached(env, CACHE_KEY, result);
  return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "MISS" } });
}

// ─── NEW: Balance Sheet at a specific date ────────────────────────────────────
// Used to get opening bank balance for cash flow (e.g. ?date=2025-12-31).
// Defaults to today if no date param supplied.
// Returns: total bank balance + breakdown by account name.
async function handleXeroBalanceSheet(request: Request, env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept: "application/json",
  };

  // Accept date param — default to today
  const url  = new URL(request.url);
  const date = url.searchParams.get("date") || new Date().toISOString().substring(0, 10);

  const res = await fetch(`${XERO_API_BASE}/Reports/BalanceSheet?date=${date}`, { headers: h });
  if (!res.ok) {
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  const data: any = await res.json();

  // Walk the Balance Sheet report rows to extract bank account balances.
  // Report structure: Rows[] → RowType=Section with Title containing "Bank" →
  // Rows[] → RowType=Row with Cells[0]=account name, Cells[last]=balance value.
  const accounts: { name: string; balance: number }[] = [];

  function walkRows(rows: any[]): void {
    for (const row of rows || []) {
      if (row.RowType === "Section" && row.Title?.toLowerCase().includes("bank")) {
        for (const r of row.Rows || []) {
          if (r.RowType === "Row" && r.Cells?.length >= 2) {
            const name    = r.Cells[0]?.Value || "";
            const rawVal  = r.Cells[r.Cells.length - 1]?.Value || "0";
            const balance = parseFloat(rawVal.replace(/[^0-9.-]/g, ""));
            if (name && !isNaN(balance) && name !== "Bank accounts") {
              accounts.push({ name, balance });
            }
          }
        }
      }
      if (row.Rows) walkRows(row.Rows);
    }
  }

  walkRows(data.Reports?.[0]?.Rows || []);

  const total = accounts.reduce((sum, a) => sum + a.balance, 0);

  if (accounts.length === 0) {
    return Response.json(
      {
        date,
        total: null,
        accounts: [],
        note: "No bank accounts found in Balance Sheet report — check accounting.reports.read scope is authorised",
      },
      { headers: { "Access-Control-Allow-Origin": "*" } }
    );
  }

  return Response.json(
    { date, total, accounts },
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}

// ─── NEW: Bank transaction diagnostic ────────────────────────────────────────
// Checks total transaction count, date range, and running balance to help
// diagnose why cash flow balance differs from Xero's live balance.
async function handleBankTxCheck(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept: "application/json",
  };

  // Fetch ALL bank transactions paginated — no date filter (server-side filter unreliable)
  let allTx: any[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${XERO_API_BASE}/BankTransactions?page=${page}`, { headers: h });
    if (!res.ok) break;
    const data: any = await res.json();
    const records = data.BankTransactions || [];
    allTx = allTx.concat(records);
    if (records.length < 100) break;
    page++;
    if (page > 50) break; // safety cap — 5000 records
  }

  // Summarise by year
  const byYear: Record<string, { spend: number; receive: number; count: number }> = {};
  let totalSpend = 0, totalReceive = 0;

  for (const tx of allTx) {
    const d = parseXeroDateObj(tx.Date);
    if (!d) continue;
    const year = d.getFullYear().toString();
    if (!byYear[year]) byYear[year] = { spend: 0, receive: 0, count: 0 };
    byYear[year].count++;
    if (tx.Type === "SPEND" || tx.Type === "SPEND-OVERPAYMENT") {
      byYear[year].spend += tx.Total || 0;
      totalSpend += tx.Total || 0;
    } else if (tx.Type === "RECEIVE" || tx.Type === "RECEIVE-OVERPAYMENT") {
      byYear[year].receive += tx.Total || 0;
      totalReceive += tx.Total || 0;
    }
  }

  // Running balance from all transactions (all time)
  const impliedBalance = totalReceive - totalSpend;

  // 2026 only
  const tx2026 = allTx.filter(tx => {
    const d = parseXeroDateObj(tx.Date);
    return d && d.getFullYear() === 2026;
  });
  const spend2026   = tx2026.filter(t => t.Type==="SPEND"||t.Type==="SPEND-OVERPAYMENT").reduce((a,t)=>a+(t.Total||0),0);
  const receive2026 = tx2026.filter(t => t.Type==="RECEIVE"||t.Type==="RECEIVE-OVERPAYMENT").reduce((a,t)=>a+(t.Total||0),0);

  return Response.json({
    totalTxFetched: allTx.length,
    pagesFetched: page - 1,
    hitSafetyCap: page > 50,
    impliedRunningBalance: impliedBalance,
    totalSpendAllTime: totalSpend,
    totalReceiveAllTime: totalReceive,
    byYear: Object.fromEntries(Object.entries(byYear).sort()),
    year2026: {
      count: tx2026.length,
      spend: spend2026,
      receive: receive2026,
      net: receive2026 - spend2026,
    },
    dateRangeActual: {
      earliest: allTx.length ? parseXeroDateObj(allTx[allTx.length-1].Date)?.toISOString().substring(0,10) : null,
      latest:   allTx.length ? parseXeroDateObj(allTx[0].Date)?.toISOString().substring(0,10) : null,
    },
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

// ─── NEW: Bank statement for a date range ─────────────────────────────────────
// Uses Xero's BankStatement report which shows every transaction that hit the
// bank account — invoice receipts, bill payments, direct spend/receive —
// giving a complete, reconciled cash movement view.
// Params: ?from=YYYY-MM-DD&to=YYYY-MM-DD (defaults to current year)
// Also accepts ?accountId=UUID to specify a particular bank account.
async function handleXeroBankStatement(request: Request, env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept: "application/json",
  };

  const url  = new URL(request.url);
  const year = new Date().getFullYear();
  const from = url.searchParams.get("from") || `${year}-01-01`;
  const to   = url.searchParams.get("to")   || new Date().toISOString().substring(0, 10);

  // Step 1: get bank accounts so we know which account(s) to pull
  const acctRes = await fetch(
    `${XERO_API_BASE}/Accounts?where=${encodeURIComponent('Type=="BANK"')}`,
    { headers: h }
  );
  if (!acctRes.ok) return new Response(await acctRes.text(), { status: acctRes.status, headers: { "Access-Control-Allow-Origin": "*" } });
  const acctData: any = await acctRes.json();
  const bankAccounts: any[] = acctData.Accounts || [];

  if (bankAccounts.length === 0) {
    return Response.json({ error: "No bank accounts found" }, { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  // Use specified account or first one found
  const accountId = url.searchParams.get("accountId") || bankAccounts[0].AccountID;
  const accountName = bankAccounts.find((a: any) => a.AccountID === accountId)?.Name || bankAccounts[0].Name;

  // Step 2: fetch the BankStatement report for the account and date range
  const stmtRes = await fetch(
    `${XERO_API_BASE}/Reports/BankStatement?bankAccountID=${accountId}&fromDate=${from}&toDate=${to}`,
    { headers: h }
  );

  if (!stmtRes.ok) {
    const errText = await stmtRes.text();
    // BankStatement report requires accounting.reports.read scope
    return new Response(errText, {
      status: stmtRes.status,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  const stmtData: any = await stmtRes.json();

  // Parse the report rows into a clean transaction list
  // BankStatement report structure:
  // Rows[] → RowType=Row with Cells: [Date, Description, Reconciled, Debit, Credit, Balance]
  interface StmtLine {
    date: string;
    description: string;
    reconciled: boolean;
    debit: number;     // money out
    credit: number;    // money in
    balance: number;
  }

  const lines: StmtLine[] = [];
  let openingBalance = 0;
  let closingBalance = 0;

  const walkRows = (rows: any[]) => {
    for (const row of rows || []) {
      if (row.RowType === "Row" && row.Cells?.length >= 5) {
        const cells = row.Cells;
        // Skip header rows (date cell won't parse as a date)
        const dateVal = cells[0]?.Value;
        if (!dateVal || dateVal === "Date") continue;

        const d = parseXeroDateObj(dateVal);
        if (!d) continue;

        const debit  = parseFloat((cells[3]?.Value || "0").replace(/[^0-9.-]/g, "")) || 0;
        const credit = parseFloat((cells[4]?.Value || "0").replace(/[^0-9.-]/g, "")) || 0;
        const bal    = parseFloat((cells[5]?.Value || "0").replace(/[^0-9.-]/g, "")) || 0;

        lines.push({
          date:        toISO(d),
          description: cells[1]?.Value || "",
          reconciled:  (cells[2]?.Value || "").toLowerCase() === "yes",
          debit,
          credit,
          balance:     bal,
        });
      }
      if (row.RowType === "SummaryRow" && row.Cells) {
        // Opening/closing balance rows
        const label = row.Cells[0]?.Value || "";
        const val   = parseFloat((row.Cells[5]?.Value || "0").replace(/[^0-9.-]/g, "")) || 0;
        if (label.toLowerCase().includes("opening")) openingBalance = val;
        if (label.toLowerCase().includes("closing")) closingBalance = val;
      }
      if (row.Rows) walkRows(row.Rows);
    }
  };

  walkRows(stmtData.Reports?.[0]?.Rows || []);

  // Monthly summary
  const byMonth: Record<string, { in: number; out: number; count: number }> = {};
  for (const line of lines) {
    const month = line.date.substring(0, 7);
    if (!byMonth[month]) byMonth[month] = { in: 0, out: 0, count: 0 };
    byMonth[month].in    += line.credit;
    byMonth[month].out   += line.debit;
    byMonth[month].count += 1;
  }

  const totalIn  = lines.reduce((a, l) => a + l.credit, 0);
  const totalOut = lines.reduce((a, l) => a + l.debit,  0);

  return Response.json({
    accountId,
    accountName,
    availableAccounts: bankAccounts.map((a: any) => ({ id: a.AccountID, name: a.Name })),
    from,
    to,
    openingBalance,
    closingBalance,
    totalIn,
    totalOut,
    netMovement: totalIn - totalOut,
    lineCount: lines.length,
    byMonth: Object.fromEntries(Object.entries(byMonth).sort()),
    lines,
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

// ─── NEW: Invoice and bill payments for the year ─────────────────────────────
// Xero /Payments endpoint returns all payments against invoices (both ACCREC
// receipts and ACCPAY bill payments). Combined with BankTransactions this gives
// a complete cash movement picture without needing report scopes.
async function handleXeroPayments(request: Request, env: Env): Promise<Response> {
  const CACHE_KEY = `cache_payments_${new Date().getFullYear()}`;
  if (!wantsRefresh(request)) {
    const cached = await getCached<any>(env, CACHE_KEY);
    if (cached) return Response.json(cached, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "HIT" } });
  }
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept: "application/json",
  };

  const year      = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1);
  const yearEnd   = new Date(year, 11, 31, 23, 59, 59);

  // Fetch all payments paginated — filter client-side (server-side date filter unreliable)
  let allPayments: any[] = [];
  let page = 1;
  while (true) {
    const res = await fetch(`${XERO_API_BASE}/Payments?page=${page}`, { headers: h });
    if (!res.ok) break;
    const data: any = await res.json();
    const records = data.Payments || [];
    allPayments = allPayments.concat(records);
    if (records.length < 100) break;
    page++;
    if (page > 30) break; // safety cap — 3000 payments
  }

  // Filter to current year and non-voided
  const paymentsThisYear = allPayments.filter((p: any) => {
    if (p.Status === "VOIDED") return false;
    const d = parseXeroDateObj(p.Date);
    return d && d >= yearStart && d <= yearEnd;
  });

  // Separate ACCREC (money in — invoice receipts) from ACCPAY (money out — bill payments)
  interface PaymentLine {
    date: string;
    month: string;
    type: string;       // ACCREC or ACCPAY
    contact: string;
    reference: string;
    amount: number;
    direction: string;  // "in" or "out"
  }

  const payments: PaymentLine[] = paymentsThisYear.map((p: any) => {
    const d        = parseXeroDateObj(p.Date)!;
    const isAccrec = p.Invoice?.Type === "ACCREC";
    return {
      date:      toISO(d),
      month:     d.toISOString().substring(0, 7),
      type:      p.Invoice?.Type || p.PaymentType || "UNKNOWN",
      contact:   p.Invoice?.Contact?.Name || "",
      reference: p.Reference || p.Invoice?.InvoiceNumber || "",
      amount:    p.Amount || 0,
      direction: isAccrec ? "in" : "out",
    };
  });

  // Monthly summary
  const byMonth: Record<string, { in: number; out: number; count: number }> = {};
  for (const p of payments) {
    if (!byMonth[p.month]) byMonth[p.month] = { in: 0, out: 0, count: 0 };
    if (p.direction === "in")  byMonth[p.month].in  += p.amount;
    else                       byMonth[p.month].out += p.amount;
    byMonth[p.month].count++;
  }

  const totalIn  = payments.filter(p => p.direction === "in") .reduce((a, p) => a + p.amount, 0);
  const totalOut = payments.filter(p => p.direction === "out").reduce((a, p) => a + p.amount, 0);

  const result = {
    year,
    totalPaymentsFetched: allPayments.length,
    paymentsThisYear:     paymentsThisYear.length,
    totalIn,
    totalOut,
    byMonth: Object.fromEntries(Object.entries(byMonth).sort()),
    payments,
  };
  await setCached(env, `cache_payments_${year}`, result);
  return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "MISS" } });
}

// ─── NEW: Combined cash flow data — payments + invoices + direct bank tx ──────
// Fetches everything the cash flow sheet needs in one call to avoid rate limits.
// Returns: payments (ACCREC receipts + ACCPAY payments), invoices (AUTHORISED),
// and direct bank transactions (not covered by payments).
async function handleXeroCashflowData(request: Request, env: Env): Promise<Response> {
  const CACHE_KEY = `cache_cashflow_${new Date().getFullYear()}`;
  if (!wantsRefresh(request)) {
    const cached = await getCached<any>(env, CACHE_KEY);
    if (cached) return Response.json(cached, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "HIT" } });
  }
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept: "application/json",
  };

  const year      = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1);
  const yearEnd   = new Date(year, 11, 31, 23, 59, 59);

  const errors: string[] = [];
  async function fetchAllPages(endpoint: string, key: string): Promise<any[]> {
    let all: any[] = [];
    let page = 1;
    while (true) {
      const res = await fetch(`${XERO_API_BASE}${endpoint}&page=${page}`, { headers: h });
      if (!res.ok) {
        const errText = await res.text();
        errors.push(`${endpoint} page ${page}: HTTP ${res.status} — ${errText.substring(0, 100)}`);
        break;
      }
      const data: any = await res.json();
      const records = data[key] || [];
      all = all.concat(records);
      if (records.length < 100) break;
      page++;
      if (page > 30) break;
      await new Promise(resolve => setTimeout(resolve, 500)); // 500ms between pages
    }
    return all;
  }

  const filterYear = (items: any[]) => items.filter((i: any) => {
    const d = parseXeroDateObj(i.Date);
    return d && d >= yearStart && d <= yearEnd;
  });

  // Fetch sequentially to avoid rate limiting — parallel was triggering 429s
  const allPayments = await fetchAllPages(`/Payments?order=Date+DESC`, "Payments");
  const allInvoices = await fetchAllPages(`/Invoices?where=${encodeURIComponent('Type=="ACCREC"&&(Status=="AUTHORISED"||Status=="PAID")')}&order=DateString+ASC`, "Invoices");
  const allBills    = await fetchAllPages(`/Invoices?where=${encodeURIComponent('Type=="ACCPAY"')}&order=Date+DESC`, "Invoices");
  // NOTE: deliberately summary-only (no summaryOnly=false) here — this endpoint only needs
  // monthly aggregate totals, not per-line account codes. Fetching full LineItems for every
  // bank transaction on every cashflow-data call was the cause of the v1.31 500/1101 error
  // (too much data, worker ran out of time/memory). Per-transaction account codes for the
  // Outgoings Detail sheet are now served separately by /api/xero/bank-transactions-detail,
  // which is only called on-demand when that sheet is refreshed.
  const allTx       = await fetchAllPages(`/BankTransactions?order=Date+DESC`, "BankTransactions");
  const acctMap: Record<string, string> = {}; // unused here now, kept for signature compatibility below

  // ── Payments: invoice receipts + bill payments ────────────
  const paymentsThisYear = filterYear(allPayments).filter((p: any) => p.Status !== "VOIDED");

  // Build invoice tax ratio lookup: InvoiceID → taxRate (TotalTax/Total)
  // Used to apportion VAT to individual payments against invoices
  const invoiceTaxRatio: Record<string, number> = {};
  for (const inv of [...allInvoices, ...allBills]) {
    if (inv.InvoiceID && inv.Total > 0) {
      invoiceTaxRatio[inv.InvoiceID] = (inv.TotalTax || 0) / inv.Total;
    }
  }

  interface PaymentLine {
    date: string; month: string; type: string;
    contact: string; reference: string; amount: number;
    vatAmount: number;  // VAT portion of this payment
    direction: string;
  }
  const payments: PaymentLine[] = paymentsThisYear.map((p: any) => {
    const d        = parseXeroDateObj(p.Date)!;
    const isAccrec = p.Invoice?.Type === "ACCREC";
    const taxRatio = p.Invoice?.InvoiceID ? (invoiceTaxRatio[p.Invoice.InvoiceID] || 0) : 0;
    const amount   = p.Amount || 0;
    return {
      date:      toISO(d),
      month:     toLocalMonth(d),
      type:      p.Invoice?.Type || p.PaymentType || "UNKNOWN",
      contact:   p.Invoice?.Contact?.Name || "",
      reference: p.Reference || p.Invoice?.InvoiceNumber || "",
      amount,
      vatAmount: amount * taxRatio,  // proportional VAT
      direction: isAccrec ? "in" : "out",
    };
  });

  // ── Invoices: AUTHORISED only (outstanding — expected future income) ──
  const invoicesThisYear = allInvoices.filter((inv: any) => {
    const d = parseXeroDateObj(inv.Date);
    return d && d >= yearStart && d <= yearEnd;
  });

  const invoices = invoicesThisYear.map((inv: any) => ({
    invoiceNumber: inv.InvoiceNumber || "",
    reference:     inv.Reference || "",
    contact:       inv.Contact?.Name || "",
    date:          parseXeroDateFull(inv.Date),
    dueDate:       parseXeroDateFull(inv.DueDate),
    paidDate:      inv.FullyPaidOnDate ? parseXeroDateFull(inv.FullyPaidOnDate) : "",
    status:        inv.Status || "",
    subTotal:      inv.SubTotal  || 0,
    totalTax:      inv.TotalTax  || 0,
    total:         inv.Total     || 0,
    amountDue:     inv.AmountDue || 0,
    amountPaid:    inv.AmountPaid || 0,
  }));

  // ── Direct bank transactions (not covered by payments) ────
  const billsThisYear = filterYear(allBills);
  const txThisYear    = filterYear(allTx);

  // Build payment key sets for deduplication
  const billPaymentKeys    = new Set<string>();
  const invoiceReceiptKeys = new Set<string>();
  for (const p of paymentsThisYear) {
    const d = parseXeroDateObj(p.Date);
    if (!d) continue;
    const key = `${toISO(d)}|${(p.Amount||0).toFixed(2)}`;
    if (p.Invoice?.Type === "ACCPAY")   billPaymentKeys.add(key);
    if (p.Invoice?.Type === "ACCREC" || p.Invoice?.Type === "ACCRECCREDIT") invoiceReceiptKeys.add(key);
  }

  interface DirectTx {
    date: string; month: string; contact: string;
    type: string; reference: string; amount: number;
    totalTax: number; source: string;
    accountCode: string; accountName: string; lineDescription: string;
  }
  const directTransactions: DirectTx[] = [];

  // Monthly direct spend/receive with VAT totals
  interface MonthTotals {
    directSpendTotal: number; directReceiveTotal: number;
    directSpendVat: number;   directReceiveVat: number;
  }
  const byMonth: Record<string, MonthTotals> = {};

  for (const tx of txThisYear) {
    if (tx.Status === "DELETED") continue;
    if (tx.Type !== "SPEND" && tx.Type !== "SPEND-OVERPAYMENT" &&
        tx.Type !== "RECEIVE" && tx.Type !== "RECEIVE-OVERPAYMENT") continue;
    const d = parseXeroDateObj(tx.Date);
    if (!d) continue;
    const key    = `${toISO(d)}|${(tx.Total||0).toFixed(2)}`;
    const isSpend = tx.Type === "SPEND" || tx.Type === "SPEND-OVERPAYMENT";
    const month  = toLocalMonth(d);
    const txVat  = tx.TotalTax || 0;

    if (isSpend && billPaymentKeys.has(key))    continue;
    if (!isSpend && invoiceReceiptKeys.has(key)) continue;

    if (!byMonth[month]) byMonth[month] = {
      directSpendTotal: 0, directReceiveTotal: 0,
      directSpendVat: 0,   directReceiveVat: 0,
    };
    if (isSpend) {
      byMonth[month].directSpendTotal += tx.Total || 0;
      byMonth[month].directSpendVat   += txVat;
    } else {
      byMonth[month].directReceiveTotal += tx.Total || 0;
      byMonth[month].directReceiveVat   += txVat;
    }

    const firstLine = (tx.LineItems || [])[0];
    const txCode = firstLine?.AccountCode || "";
    directTransactions.push({
      date:            toISO(d),
      month,
      contact:         tx.Contact?.Name || "(no contact)",
      type:            tx.Type,
      reference:       tx.Reference || "",
      amount:          tx.Total || 0,
      totalTax:        txVat,
      source:          isSpend ? "DirectSpend" : "DirectReceive",
      accountCode:     txCode,
      accountName:     acctMap[txCode] || txCode,
      lineDescription: firstLine?.Description || "",
    });
  }

  directTransactions.sort((a, b) => a.date.localeCompare(b.date));

  // Payments monthly summary including VAT
  const paymentsByMonth: Record<string, { in: number; out: number; vatIn: number; vatOut: number }> = {};
  for (const p of payments) {
    if (!paymentsByMonth[p.month]) paymentsByMonth[p.month] = { in: 0, out: 0, vatIn: 0, vatOut: 0 };
    if (p.direction === "in")  {
      paymentsByMonth[p.month].in    += p.amount;
      paymentsByMonth[p.month].vatIn += p.vatAmount;
    } else {
      paymentsByMonth[p.month].out    += p.amount;
      paymentsByMonth[p.month].vatOut += p.vatAmount;
    }
  }

  // Quarterly VAT calculation (cash accounting — Jan/Apr/Jul/Oct quarters)
  // Output VAT = VAT on invoice receipts (ACCREC payments) in the quarter
  // Input VAT  = VAT on bill payments (ACCPAY payments) + VAT on direct spend
  // Net VAT    = Output - Input (positive = pay HMRC, negative = reclaim)
  // Payment due = 37 days after quarter end
  const vatQuarters: Record<string, {
    months: string[]; paymentDue: string;
    outputVat: number; inputVatPayments: number; inputVatDirect: number;
    totalInputVat: number; netVat: number;
  }> = {};

  const allMonths = Object.keys({ ...paymentsByMonth, ...byMonth }).sort();
  for (const month of allMonths) {
    const yr  = parseInt(month.substring(0, 4));
    const mo  = parseInt(month.substring(5, 7)); // 1-indexed
    // Quarter: Jan=Q1(Jan-Mar), Apr=Q2(Apr-Jun), Jul=Q3(Jul-Sep), Oct=Q4(Oct-Dec)
    const qStart = mo <= 3 ? 1 : mo <= 6 ? 4 : mo <= 9 ? 7 : 10;
    const qKey   = `${yr}-Q${Math.ceil(mo / 3)}`;
    const qEndDate = new Date(yr, qStart + 2, 0); // last day of quarter
    const payDue = new Date(qEndDate); payDue.setDate(payDue.getDate() + 37);

    if (!vatQuarters[qKey]) vatQuarters[qKey] = {
      months: [], paymentDue: toISO(payDue),
      outputVat: 0, inputVatPayments: 0, inputVatDirect: 0,
      totalInputVat: 0, netVat: 0,
    };

    const pm = paymentsByMonth[month] || { in: 0, out: 0, vatIn: 0, vatOut: 0 };
    const dm = byMonth[month] || { directSpendTotal: 0, directReceiveTotal: 0, directSpendVat: 0, directReceiveVat: 0 };

    vatQuarters[qKey].months.push(month);
    vatQuarters[qKey].outputVat        += pm.vatIn;
    vatQuarters[qKey].inputVatPayments += pm.vatOut;
    vatQuarters[qKey].inputVatDirect   += dm.directSpendVat;
  }

  for (const qKey of Object.keys(vatQuarters)) {
    const q = vatQuarters[qKey];
    q.totalInputVat = q.inputVatPayments + q.inputVatDirect;
    q.netVat        = q.outputVat - q.totalInputVat;
  }

  const result = {
    year,
    payments,
    paymentsByMonth,
    invoices,
    directTransactions,
    directByMonth: byMonth,
    vatQuarters,
    counts: {
      payments:           payments.length,
      invoices:           invoices.length,
      directTransactions: directTransactions.length,
    },
    errors,
  };
  await setCached(env, CACHE_KEY, result);
  return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "MISS" } });
}

// ─── Bank transactions with account codes — on-demand, not part of the hot
// cashflow-data path. Called only when refreshing the Xero Outgoings Detail
// sheet (v1.31 merge). Uses summaryOnly=false to get LineItems/account codes,
// which is why this is split out: doing this on every cashflow-data load was
// the cause of the 500/error 1101 (too much data per request).
async function handleXeroBankTransactionsDetail(request: Request, env: Env): Promise<Response> {
  const CACHE_KEY = `cache_banktx_detail_${new Date().getFullYear()}`;
  if (!wantsRefresh(request)) {
    const cached = await getCached<any>(env, CACHE_KEY);
    if (cached) return Response.json(cached, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "HIT" } });
  }
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept: "application/json",
  };

  const year = new Date().getFullYear();
  const errors: string[] = [];

  const chart = await fetchChartOfAccounts(env, h);
  const acctMap: Record<string, string> = {};
  for (const a of chart) acctMap[a.code] = `${a.code} — ${a.name}`;

  const rawTx = await fetchDirectBankTransactions(env, h, year, errors);
  const directTransactions = rawTx.map(t => ({
    ...t,
    accountName: acctMap[t.accountCode] || t.accountCode,
  }));

  const result = { directTransactions, count: directTransactions.length, errors };
  await setCached(env, CACHE_KEY, result);
  return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "MISS" } });
}

// ─── P&L by account code — gross revenue/expense totals per code, every
// code in the chart of accounts included (not just ones with activity).
// No budget/variance — David confirmed there isn't one to compare against.
// VAT control accounts (820, 828) are LIABILITY type, not Expense, so they're
// deliberately excluded from the main code list and reported separately as
// a VAT paid/accrued split instead — otherwise they'd inflate the apparent
// operating cost base with what's actually just VAT passing through.
async function handleXeroPnlByCode(request: Request, env: Env): Promise<Response> {
  const CACHE_KEY = `cache_pnl_by_code_${new Date().getFullYear()}`;
  if (!wantsRefresh(request)) {
    const cached = await getCached<any>(env, CACHE_KEY);
    if (cached) return Response.json(cached, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "HIT" } });
  }
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = {
    Authorization: `Bearer ${tokens.access_token}`,
    "Xero-tenant-id": tokens.tenant_id,
    Accept: "application/json",
  };

  const year      = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1);
  const yearEnd   = new Date(year, 11, 31, 23, 59, 59);
  const errors: string[] = [];

  const chart = await fetchChartOfAccounts(env, h);
  const chartByCode: Record<string, ChartAccount> = {};
  for (const a of chart) chartByCode[a.code] = a;

  interface CodeTotal { code: string; name: string; type: string; gross: number; vat: number; count: number; }
  const byCode: Record<string, CodeTotal> = {};
  function addToCode(code: string, name: string, type: string, gross: number, vat: number) {
    const key = code || "(no code)";
    if (!byCode[key]) byCode[key] = { code: key, name: name || key, type, gross: 0, vat: 0, count: 0 };
    byCode[key].gross += gross;
    byCode[key].vat   += vat;
    byCode[key].count++;
  }

  // Sales income — all ACCREC invoices. Per David: all sales income is
  // coded to 200 Sales, so no line-item enrichment needed for invoices.
  const allInvoices = await fetchXeroAllPages(
    h, `/Invoices?where=${encodeURIComponent('Type=="ACCREC"&&(Status=="AUTHORISED"||Status=="PAID")')}&order=Date+DESC`,
    "Invoices", errors
  );
  const invoicesThisYear = allInvoices.filter((inv: any) => {
    const d = parseXeroDateObj(inv.Date);
    return d && d >= yearStart && d <= yearEnd;
  });
  const salesAccount = chartByCode["200"];
  for (const inv of invoicesThisYear) {
    addToCode("200", salesAccount?.name || "Sales", salesAccount?.type || "REVENUE", inv.Total || 0, inv.TotalTax || 0);
  }

  // Bills — ACCPAY, per line-item account code, gross of VAT
  const allBills = await fetchXeroAllPages(
    h, `/Invoices?where=${encodeURIComponent('Type=="ACCPAY"')}&order=Date+DESC&summaryOnly=false`,
    "Invoices", errors
  );
  const billsThisYear = allBills.filter((b: any) => {
    const d = parseXeroDateObj(b.Date);
    return d && d >= yearStart && d <= yearEnd && b.Status !== "DELETED";
  });
  for (const bill of billsThisYear) {
    const lineItems: any[] = bill.LineItems || [];
    if (lineItems.length > 0) {
      for (const line of lineItems) {
        const code = line.AccountCode || "";
        const acct = chartByCode[code];
        addToCode(code, acct?.name || code, acct?.type || "", (line.LineAmount || 0) + (line.TaxAmount || 0), line.TaxAmount || 0);
      }
    } else {
      addToCode("", "(no code)", "", bill.Total || 0, bill.TotalTax || 0);
    }
  }

  // Direct bank transactions (spend & receive), per account code — reuses
  // the shared helper so this gets the same dedup as everywhere else.
  const directTx = await fetchDirectBankTransactions(env, h, year, errors);
  for (const tx of directTx) {
    const acct = chartByCode[tx.accountCode];
    addToCode(tx.accountCode, acct?.name || tx.accountCode, acct?.type || "", Math.abs(tx.amount), tx.totalTax || 0);
  }

  // Every Revenue/Expense-type code in the chart appears even with zero
  // activity — that's the whole point of "all cost codes", not just used ones.
  for (const a of chart) {
    const t = (a.type || "").toUpperCase();
    if (t !== "REVENUE" && t !== "EXPENSE" && t !== "DIRECTCOSTS" && t !== "OVERHEADS") continue;
    if (!byCode[a.code]) byCode[a.code] = { code: a.code, name: a.name, type: a.type, gross: 0, vat: 0, count: 0 };
  }

  const codes = Object.values(byCode)
    .filter(c => {
      const t = (c.type || "").toUpperCase();
      return t === "REVENUE" || t === "EXPENSE" || t === "DIRECTCOSTS" || t === "OVERHEADS";
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  // ── VAT — paid (cash, codes 820+828) vs accrued for the rest of the year ──
  const vatPaidCash = directTx
    .filter(tx => tx.accountCode === "820" || tx.accountCode === "828")
    .reduce((sum, tx) => sum + tx.amount, 0); // signed: spend positive

  // Full-year accrual-basis estimate: Output VAT (on sales) minus Input VAT
  // (on bills + direct spend, excluding the 820/828 payments themselves).
  // This is an APPROXIMATION — it uses invoice/bill dates, not payment dates.
  // David's confirmed his actual VAT scheme (cash vs accrual accounting) with
  // his accountant isn't finalised yet, so treat this as indicative until that's
  // confirmed, not a precise HMRC-ready figure.
  const outputVat = invoicesThisYear.reduce((s: number, inv: any) => s + (inv.TotalTax || 0), 0);
  const inputVatBills = billsThisYear.reduce((s: number, b: any) => s + (b.TotalTax || 0), 0);
  const inputVatDirect = directTx
    .filter(tx => tx.accountCode !== "820" && tx.accountCode !== "828")
    .reduce((s, tx) => s + (tx.totalTax || 0), 0);
  const totalYearVatLiability = outputVat - inputVatBills - inputVatDirect;
  const vatAccruedNotPaid = totalYearVatLiability - vatPaidCash;

  const result = {
    year,
    codes,
    vat: {
      paidCash:           vatPaidCash,
      accruedNotPaid:      vatAccruedNotPaid,
      totalYearLiability:  totalYearVatLiability,
      note: "Accrued figure = Output VAT minus Input VAT on an accrual (invoice/bill date) basis — indicative pending confirmation of your actual VAT scheme (cash vs accrual) from your accountant.",
    },
    errors,
  };
  await setCached(env, CACHE_KEY, result);
  return Response.json(result, { headers: { "Access-Control-Allow-Origin": "*", "X-Cache": "MISS" } });
}

// ─── Debug: outgoings date filter test ───────────────────────────────────────
async function handleXeroOutgoingsDebug(env: Env): Promise<Response> {
  let tokens: XeroTokens;
  try { tokens = await getValidTokens(env); } catch (e: any) { return new Response(e.message, { status: 401 }); }
  const h = { Authorization: `Bearer ${tokens.access_token}`, "Xero-tenant-id": tokens.tenant_id, Accept: "application/json" };

  const year = new Date().getFullYear();

  // Test fromDate filter — just page 1
  const res = await fetch(`${XERO_API_BASE}/BankTransactions?fromDate=${year}-01-01&page=1`, { headers: h });
  const raw = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch {}

  const txList = parsed?.BankTransactions || [];
  const firstTx = txList[0] || null;

  return Response.json({
    status: res.status,
    count: txList.length,
    firstDate: firstTx?.DateString || firstTx?.Date || "none",
    firstContact: firstTx?.Contact?.Name || "none",
    firstAmount: firstTx?.Total || 0,
  }, { headers: { "Access-Control-Allow-Origin": "*" } });
}

// ─── Page serving ─────────────────────────────────────────────────────────────
function serveDashboard(): Response {
  return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function serveForecast(): Response {
  return new Response(FORECAST_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
function serveSettings(): Response {
  return new Response(SETTINGS_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ─── Dashboard HTML ────────────────────────────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Financial Dashboard</title>
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
.nav-links{display:flex;gap:8px;margin-top:8px;justify-content:flex-end}
.nav-link{display:inline-block;font-size:0.68rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;border:1px solid var(--accent);padding:5px 12px;border-radius:4px;transition:all 0.2s}
.nav-link:hover{background:var(--accent);color:#fff}
.refresh-btn{background:none;border:1px solid var(--border);color:var(--muted);padding:6px 14px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;font-size:0.68rem;letter-spacing:0.08em;text-transform:uppercase;margin-top:8px;transition:all 0.2s;display:block}
.refresh-btn:hover{border-color:var(--accent);color:var(--accent)}
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px}
.kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;position:relative;overflow:hidden;opacity:0;transform:translateY(8px);animation:fadeUp 0.4s ease forwards}
.kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.kpi-card:nth-child(1){animation-delay:0.05s}.kpi-card:nth-child(1)::before{background:var(--accent2)}
.kpi-card:nth-child(2){animation-delay:0.10s}.kpi-card:nth-child(2)::before{background:var(--accent)}
.kpi-card:nth-child(3){animation-delay:0.15s}.kpi-card:nth-child(3)::before{background:var(--accent3)}
.kpi-card:nth-child(4){animation-delay:0.20s}.kpi-card:nth-child(4)::before{background:var(--accent4)}
.kpi-label{font-size:0.62rem;letter-spacing:0.15em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.kpi-value{font-family:'Syne',sans-serif;font-size:1.85rem;font-weight:700;letter-spacing:-0.02em;line-height:1}
.kpi-sub{font-size:0.68rem;color:var(--muted);margin-top:8px}
.positive{color:var(--green)}.negative{color:var(--red)}.neutral{color:var(--text)}
.section-label{font-size:0.62rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:32px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.card-title{font-family:'Syne',sans-serif;font-size:0.82rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase}
.card-badge{font-size:0.62rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);background:var(--surface2);padding:3px 8px;border-radius:3px;border:1px solid var(--border)}
.doc-scroll{max-height:460px;overflow-y:auto;padding-right:4px}
.doc-scroll::-webkit-scrollbar{width:3px}
.doc-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.month-group{margin-bottom:20px}
.month-header{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:8px;cursor:pointer;user-select:none}
.month-name{font-family:'Syne',sans-serif;font-size:0.8rem;font-weight:700;transition:color 0.2s}
.month-header:hover .month-name{color:var(--accent)}
.month-meta{display:flex;align-items:center;gap:12px}
.month-total{font-family:'Syne',sans-serif;font-size:0.85rem;font-weight:700}
.month-count{font-size:0.62rem;color:var(--muted)}
.overdue-flag{font-size:0.58rem;padding:2px 6px;border-radius:3px;background:rgba(255,107,107,0.15);color:var(--red);text-transform:uppercase}
.month-rows{display:none}.month-rows.open{display:block}
.doc-row{display:grid;grid-template-columns:1fr 1.5fr 1fr auto;gap:8px;padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.5);font-size:0.7rem;align-items:center}
.doc-row:last-child{border-bottom:none}
.doc-ref{color:var(--accent);font-size:0.65rem}
.doc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.doc-amt{font-family:'Syne',sans-serif;font-weight:600;text-align:right}
.doc-due{font-size:0.62rem;color:var(--muted);text-align:right}
.doc-due.overdue{color:var(--red)}
.chevron{font-size:0.7rem;color:var(--muted);transition:transform 0.2s;display:inline-block}
.chevron.open{transform:rotate(90deg)}
.bal-detail{font-size:0.6rem;color:var(--muted);margin-top:6px;line-height:1.6}
.loading-text{font-size:0.68rem;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;animation:pulse 1.5s ease-in-out infinite}
.error-text{font-size:0.68rem;color:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes fadeUp{to{opacity:1;transform:translateY(0)}}
@media(max-width:900px){.kpi-row{grid-template-columns:repeat(2,1fr)}.grid-2{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo-area"><h1>Finance<span>.</span></h1><p>Live overview — powered by Xero</p></div>
    <div class="header-meta">
      <span>LAST UPDATED</span><span id="last-updated">—</span>
      <div class="nav-links"><a href="/forecast" class="nav-link">Forecast</a><a href="/settings" class="nav-link">Settings</a></div>
      <button class="refresh-btn" onclick="loadAll()">↻ Refresh</button>
    </div>
  </header>

  <div class="kpi-row">
    <div class="kpi-card">
      <div class="kpi-label">Bank Balance</div>
      <div class="kpi-value neutral" id="kpi-balance">—</div>
      <div class="kpi-sub" id="kpi-balance-sub">Loading…</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Outstanding Invoices</div>
      <div class="kpi-value neutral" id="kpi-inv-total">—</div>
      <div class="kpi-sub" id="kpi-inv-count">Loading…</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Overdue Invoices</div>
      <div class="kpi-value neutral" id="kpi-overdue">—</div>
      <div class="kpi-sub" id="kpi-overdue-count">Loading…</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Outstanding Bills</div>
      <div class="kpi-value neutral" id="kpi-bills-total">—</div>
      <div class="kpi-sub" id="kpi-bills-count">Loading…</div>
    </div>
  </div>

  <div class="section-label">Receivables — Unpaid Invoices</div>
  <div class="grid-2">
    <div class="card">
      <div class="card-header"><span class="card-title">By Due Month</span><span class="card-badge" id="inv-month-badge">—</span></div>
      <div class="doc-scroll" id="inv-month-list"><div class="loading-text">Loading invoices…</div></div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Outstanding Bills</span><span class="card-badge" id="bills-month-badge">—</span></div>
      <div class="doc-scroll" id="bills-month-list"><div class="loading-text">Loading bills…</div></div>
    </div>
  </div>

</div>
<script>
const fmt=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0}).format(n);
const fmtDec=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',minimumFractionDigits:2}).format(n);
const fmtMo=s=>{try{const[y,m]=s.split('-');return new Date(y,m-1,1).toLocaleDateString('en-GB',{month:'short',year:'2-digit'});}catch(e){return s;}};

function buildMonthList(byMonth, redFlag, containerEl, badgeEl){
  const months=Object.keys(byMonth).sort();
  if(badgeEl) badgeEl.textContent=months.length+' months';
  const now=new Date(); now.setHours(0,0,0,0);
  const html=months.map((month,idx)=>{
    const d=byMonth[month];
    const hasFlag=d[redFlag]>0;
    const rows=d.items.map(it=>'<div class="doc-row"><span class="doc-ref">'+it.ref+'</span><span class="doc-name">'+it.contact+'</span><span class="doc-amt">'+fmtDec(it.amount)+'</span><span class="doc-due'+(it.overdue?' overdue':'')+'">'+it.due+'</span></div>').join('');
    const open=idx===0?' open':'';
    return '<div class="month-group"><div class="month-header" onclick="toggleMonth(this)"><div style="display:flex;align-items:center;gap:10px"><span class="chevron'+(idx===0?' open':'')+'">&#9654;</span><span class="month-name">'+fmtMo(month)+'</span></div><div class="month-meta">'+(hasFlag?'<span class="overdue-flag">'+fmt(d[redFlag])+' overdue</span>':'')+'<span class="month-count">'+d.items.length+' items</span><span class="month-total">'+fmt(d.total)+'</span></div></div><div class="month-rows'+open+'">'+rows+'</div></div>';
  }).join('');
  containerEl.innerHTML=html||'<div style="color:var(--muted);font-size:0.7rem">Nothing outstanding</div>';
}

function toggleMonth(h){const r=h.nextElementSibling,c=h.querySelector('.chevron'),o=r.classList.toggle('open');c.classList.toggle('open',o);}

async function loadBankBalance(){
  try{
    const res=await fetch('/api/bankbalance');
    if(!res.ok)throw new Error(await res.text());
    const data=await res.json();
    const el=document.getElementById('kpi-balance');
    const sub=document.getElementById('kpi-balance-sub');
    if(data.total===null){
      el.textContent='Unavailable';
      el.className='kpi-value neutral';
      if(sub)sub.textContent=data.note||'Could not retrieve from Xero';
      return;
    }
    el.textContent=fmt(data.total);
    el.className='kpi-value '+(data.total>=0?'positive':'negative');
    if(data.accounts&&data.accounts.length){
      sub.innerHTML=data.accounts.map(a=>'<span>'+a.name+': '+fmt(a.balance||0)+'</span>').join('<br>');
    }
  }catch(e){
    document.getElementById('kpi-balance').textContent='Error';
    document.getElementById('kpi-balance-sub').textContent=e.message;
  }
}

async function loadInvoices(){
  try{
    const res=await fetch('/api/invoices-by-month');
    if(!res.ok)throw new Error(await res.text());
    const raw=await res.json();
    const now=new Date(); now.setHours(0,0,0,0);
    const byMonth={};
    for(const[month,d] of Object.entries(raw)){
      byMonth[month]={total:d.total,overdue:d.overdue,items:d.invoices.map(i=>({ref:i.ref,contact:i.contact,amount:i.amount,due:i.due,overdue:i.overdue}))};
    }
    const totalAll=Object.values(byMonth).reduce((a,d)=>a+d.total,0);
    const totalOv=Object.values(byMonth).reduce((a,d)=>a+d.overdue,0);
    const countAll=Object.values(byMonth).reduce((a,d)=>a+d.items.length,0);
    const countOv=Object.values(byMonth).reduce((a,d)=>a+d.items.filter(i=>i.overdue).length,0);
    const el=document.getElementById('kpi-inv-total'); el.textContent=fmt(totalAll); el.className='kpi-value neutral';
    document.getElementById('kpi-inv-count').textContent=countAll+' invoices outstanding';
    const ovEl=document.getElementById('kpi-overdue'); ovEl.textContent=fmt(totalOv); ovEl.className='kpi-value '+(totalOv>0?'negative':'positive');
    document.getElementById('kpi-overdue-count').textContent=countOv+' invoice'+(countOv!==1?'s':'')+' overdue';
    buildMonthList(byMonth,'overdue',document.getElementById('inv-month-list'),document.getElementById('inv-month-badge'));
  }catch(e){
    document.getElementById('inv-month-list').innerHTML='<div class="error-text">'+e.message+'</div>';
  }
}

async function loadBills(){
  try{
    const r2=await fetch('/api/bills');
    if(!r2.ok)throw new Error(await r2.text());
    const raw=await r2.json();
    const now=new Date(); now.setHours(0,0,0,0);
    const byMonth={};
    for(const bill of raw.Invoices||[]){
      const due=bill.DueDate; if(!due)continue;
      let d;
      const ms=due.match(/\/Date\((\d+)/);
      if(ms){d=new Date(parseInt(ms[1]));}else{d=new Date(due);}
      if(isNaN(d.getTime()))continue;
      const month=d.toISOString().substring(0,7);
      const amount=bill.AmountDue||0;
      const isOver=d<now;
      if(!byMonth[month])byMonth[month]={total:0,overdue:0,items:[]};
      byMonth[month].total+=amount;
      if(isOver)byMonth[month].overdue+=amount;
      byMonth[month].items.push({ref:bill.InvoiceNumber||bill.Reference||'—',contact:bill.Contact?.Name||'—',amount,due:d.toISOString().substring(0,10),overdue:isOver});
    }
    const totalAll=Object.values(byMonth).reduce((a,d)=>a+d.total,0);
    const countAll=Object.values(byMonth).reduce((a,d)=>a+d.items.length,0);
    const el=document.getElementById('kpi-bills-total'); el.textContent=fmt(totalAll); el.className='kpi-value '+(totalAll>0?'negative':'neutral');
    document.getElementById('kpi-bills-count').textContent=countAll+' bill'+(countAll!==1?'s':'')+' outstanding';
    buildMonthList(byMonth,'overdue',document.getElementById('bills-month-list'),document.getElementById('bills-month-badge'));
  }catch(e){
    document.getElementById('bills-month-list').innerHTML='<div class="error-text">'+e.message+'</div>';
  }
}

async function loadAll(){
  document.getElementById('last-updated').textContent='Loading…';
  await Promise.all([loadBankBalance(),loadInvoices(),loadBills()]);
  document.getElementById('last-updated').textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
loadAll();
</script>
</body></html>
`;


// ─── Forecast HTML ─────────────────────────────────────────────────────────────
const FORECAST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>8-Month Cash Flow Forecast</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a26;--border:#2a2a40;--accent:#7c6af7;--accent2:#4ecdc4;--accent3:#ff6b6b;--accent4:#ffd93d;--text:#e8e8f0;--muted:#6b6b8a;--green:#51cf66;--red:#ff6b6b;--orange:#ff9f43}
body{background:var(--bg);color:var(--text);font-family:'DM Mono',monospace;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:40px 40px;opacity:0.25;pointer-events:none;z-index:0}
.container{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:40px 32px}
header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid var(--border)}
.logo-area h1{font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;letter-spacing:-0.03em}
.logo-area h1 span{color:var(--accent)}
.logo-area p{font-size:0.7rem;color:var(--muted);margin-top:4px;letter-spacing:0.1em;text-transform:uppercase}
.nav-links{display:flex;gap:8px}
.nav-link{display:inline-block;font-size:0.68rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;border:1px solid var(--accent);padding:5px 12px;border-radius:4px;transition:all 0.2s}
.nav-link:hover{background:var(--accent);color:#fff}
.pipeline-banner{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;padding:16px;background:rgba(124,106,247,0.08);border:1px solid rgba(124,106,247,0.3);border-radius:8px}
.cost-banner{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;padding:16px;background:rgba(255,159,67,0.07);border:1px solid rgba(255,159,67,0.3);border-radius:8px}
.pipeline-stat{text-align:center}
.pipeline-stat-label{font-size:0.6rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.pipeline-stat-value{font-family:'Syne',sans-serif;font-size:1.1rem;font-weight:700}
.sp-badge{font-size:0.58rem;padding:2px 7px;border-radius:3px;background:rgba(124,106,247,0.2);color:var(--accent);letter-spacing:0.08em;text-transform:uppercase;margin-left:6px}
.cost-badge{font-size:0.58rem;padding:2px 7px;border-radius:3px;background:rgba(255,159,67,0.2);color:var(--orange);letter-spacing:0.08em;text-transform:uppercase;margin-left:6px}
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
.week-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:6px;margin-bottom:24px}
.week-col{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px 6px;cursor:pointer;transition:border-color 0.2s}
.week-col:hover,.week-col.active{border-color:var(--accent)}
.week-col.danger{border-color:rgba(255,107,107,0.5)}.week-col.danger .week-balance{color:var(--red)}
.week-label{font-size:0.55rem;letter-spacing:0.08em;text-transform:uppercase;color:var(--muted);margin-bottom:6px;white-space:nowrap}
.week-in{font-size:0.62rem;color:var(--green);margin-bottom:2px}
.week-pipeline{font-size:0.58rem;color:var(--accent);margin-bottom:2px}
.week-costs{font-size:0.58rem;color:var(--orange);margin-bottom:2px}
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
.detail-row{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.4);font-size:0.7rem;align-items:start}
.detail-row:last-child{border-bottom:none}
.dr-ref{color:var(--accent);font-size:0.62rem;white-space:nowrap}
.dr-name{overflow:hidden}
.dr-breakdown{font-size:0.58rem;color:var(--muted);margin-top:2px;line-height:1.5}
.dr-amt{font-family:'Syne',sans-serif;font-weight:600;text-align:right;white-space:nowrap}
.dr-type{font-size:0.55rem;padding:2px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap}
.type-invoice{background:rgba(78,205,196,0.15);color:var(--accent2)}
.type-bill{background:rgba(255,107,107,0.15);color:var(--red)}
.type-monthly{background:rgba(255,217,61,0.15);color:var(--accent4)}
.type-weekly{background:rgba(124,106,247,0.15);color:var(--accent)}
.type-confirmed{background:rgba(167,139,250,0.2);color:#a78bfa}
.type-provisional{background:rgba(99,102,241,0.2);color:#818cf8}
.type-cost{background:rgba(255,159,67,0.18);color:var(--orange)}
.empty-state{font-size:0.7rem;color:var(--muted);padding:12px 0}
.beyond-table{width:100%;border-collapse:collapse;font-size:0.7rem;margin-top:8px}
.beyond-table th{text-align:left;font-size:0.58rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);padding:0 0 8px;border-bottom:1px solid var(--border);font-weight:400}
.beyond-table td{padding:8px 0;border-bottom:1px solid rgba(42,42,64,0.4);vertical-align:top}
.beyond-table tr:last-child td{border-bottom:none}
.beyond-scroll{max-height:320px;overflow-y:auto}
.beyond-scroll::-webkit-scrollbar{width:3px}
.beyond-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.toggle-bar{display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap}
.toggle-divider{width:1px;height:20px;background:var(--border);margin:0 4px}
.toggle-label{font-size:0.65rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);margin-right:4px}
.toggle-btn{background:var(--surface);border:1px solid var(--border);color:var(--muted);padding:7px 16px;border-radius:4px;cursor:pointer;font-family:'DM Mono',monospace;font-size:0.68rem;letter-spacing:0.08em;transition:all 0.2s}
.toggle-btn:hover{border-color:var(--accent);color:var(--accent)}
.toggle-btn.active{background:var(--accent);border-color:var(--accent);color:#fff}
.toggle-btn.active-orange{background:var(--orange);border-color:var(--orange);color:#fff}
.loading-overlay{display:flex;align-items:center;justify-content:center;height:300px}
.loading-text{font-size:0.68rem;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;animation:pulse 1.5s ease-in-out infinite}
.error-text{font-size:0.68rem;color:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes fadeUp{to{opacity:1;transform:translateY(0)}}
@media(max-width:1100px){.week-grid{grid-template-columns:repeat(7,1fr)}}
@media(max-width:700px){.kpi-row{grid-template-columns:repeat(2,1fr)}.week-grid{grid-template-columns:repeat(4,1fr)}.detail-cols{grid-template-columns:1fr}.pipeline-banner,.cost-banner{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo-area"><h1>Forecast<span>.</span></h1><p>8-month cash flow — Xero + Sonderplan</p></div>
    <div class="nav-links">
      <a href="/dashboard" class="nav-link">← Dashboard</a>
      <a href="/settings" class="nav-link">⚙ Settings</a>
    </div>
  </header>
  <div id="loading-state" class="loading-overlay"><div class="loading-text">Building forecast…</div></div>
  <div id="forecast-content" style="display:none">
    <div class="pipeline-banner">
      <div class="pipeline-stat"><div class="pipeline-stat-label">Confirmed Pipeline <span class="sp-badge">Sonderplan</span></div><div class="pipeline-stat-value positive" id="sp-confirmed">—</div></div>
      <div class="pipeline-stat"><div class="pipeline-stat-label">Provisional Pipeline <span class="sp-badge">Sonderplan</span></div><div class="pipeline-stat-value neutral" id="sp-provisional">—</div></div>
      <div class="pipeline-stat"><div class="pipeline-stat-label">Events in Forecast Window</div><div class="pipeline-stat-value neutral" id="sp-count">—</div></div>
      <div class="pipeline-stat"><div class="pipeline-stat-label">Opening Balance</div><div class="pipeline-stat-value neutral" id="kpi-opening">—</div></div>
    </div>
    <div id="uninvoiced-banner" style="display:none;margin-bottom:16px;padding:14px 18px;background:rgba(255,107,107,0.1);border:1px solid rgba(255,107,107,0.4);border-radius:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer" onclick="toggleUninvoiced()">
        <div>
          <span style="font-family:'Syne',sans-serif;font-weight:700;font-size:0.85rem;color:var(--red)">⚠ Uninvoiced / Unresolved Events</span>
          <span id="uninvoiced-summary" style="font-size:0.68rem;color:var(--muted);margin-left:12px"></span>
        </div>
        <span style="font-size:0.68rem;color:var(--muted)" id="uninvoiced-toggle-label">Show ▼</span>
      </div>
      <div id="uninvoiced-detail" style="display:none;margin-top:14px">
        <div style="font-size:0.65rem;color:var(--muted);margin-bottom:10px;line-height:1.6">
          These events have passed but are still <strong>Confirmed or Provisional</strong> in Sonderplan.
          They are <strong>not included in any forecast figures</strong>.
          Check whether an invoice has been raised and paid in Xero for each one.
          Once the Xero invoice reference link is built, this list will reconcile automatically.
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:0.7rem">
          <thead>
            <tr>
              <th style="text-align:left;color:var(--muted);font-weight:400;padding:0 0 8px;border-bottom:1px solid var(--border)">Event</th>
              <th style="text-align:left;color:var(--muted);font-weight:400;padding:0 0 8px;border-bottom:1px solid var(--border)">Status</th>
              <th style="text-align:left;color:var(--muted);font-weight:400;padding:0 0 8px;border-bottom:1px solid var(--border)">Event Date</th>
              <th style="text-align:right;color:var(--muted);font-weight:400;padding:0 0 8px;border-bottom:1px solid var(--border)">Value</th>
              <th style="text-align:left;color:var(--muted);font-weight:400;padding:0 0 8px;border-bottom:1px solid var(--border)">Price Flag</th>
            </tr>
          </thead>
          <tbody id="uninvoiced-tbody"></tbody>
        </table>
      </div>
    </div>
    <div class="cost-banner">
      <div class="pipeline-stat"><div class="pipeline-stat-label">Est. Total Event Costs <span class="cost-badge">All pipeline</span></div><div class="pipeline-stat-value" style="color:var(--orange)" id="cost-total">—</div></div>
      <div class="pipeline-stat"><div class="pipeline-stat-label">Est. Wages</div><div class="pipeline-stat-value" style="color:var(--orange)" id="cost-wages">—</div></div>
      <div class="pipeline-stat"><div class="pipeline-stat-label">Est. Mileage</div><div class="pipeline-stat-value" style="color:var(--orange)" id="cost-mileage">—</div></div>
      <div class="pipeline-stat"><div class="pipeline-stat-label">Est. Hotel + Subsistence</div><div class="pipeline-stat-value" style="color:var(--orange)" id="cost-hotel">—</div></div>
    </div>
    <div class="toggle-bar">
      <span class="toggle-label">Pipeline by:</span>
      <button class="toggle-btn active" id="btn-payment" onclick="setMode('payment')">Payment Date</button>
      <button class="toggle-btn" id="btn-event" onclick="setMode('event')">Event Date</button>
      <div class="toggle-divider"></div>
      <span class="toggle-label">Case:</span>
      <button class="toggle-btn active" id="btn-best" onclick="setCaseMode('best')">Best Case</button>
      <button class="toggle-btn" id="btn-worst" onclick="setCaseMode('worst')">Confirmed Only</button>
      <div class="toggle-divider"></div>
      <button class="toggle-btn active-orange" id="btn-costs-on" onclick="setCosts(true)">Costs On</button>
      <button class="toggle-btn" id="btn-costs-off" onclick="setCosts(false)">Costs Off</button>
    </div>
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-label">Confirmed Inflows</div><div class="kpi-value positive" id="kpi-confirmed">—</div><div class="kpi-sub" id="kpi-confirmed-sub">Xero invoices</div></div>
      <div class="kpi-card"><div class="kpi-label">Pipeline in Window</div><div class="kpi-value neutral" id="kpi-pipeline">—</div><div class="kpi-sub" id="kpi-pipeline-sub">Sonderplan events</div></div>
      <div class="kpi-card"><div class="kpi-label">Est. Event Costs</div><div class="kpi-value" style="color:var(--orange)" id="kpi-costs">—</div><div class="kpi-sub" id="kpi-costs-sub">in forecast window</div></div>
      <div class="kpi-card"><div class="kpi-label">Closing Balance</div><div class="kpi-value neutral" id="kpi-closing">—</div><div class="kpi-sub">End of week 34</div></div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Weekly Cash Position</span><span class="card-badge" id="chart-badge">8-month rolling</span></div>
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
      <div class="card-header"><span class="card-title">Upcoming Events (outside 34-week window)</span><span class="card-badge" id="beyond-badge">—</span></div>
      <div class="beyond-scroll"><table class="beyond-table"><thead><tr><th>Event</th><th>Status</th><th>Event Date</th><th>Est. Payment</th><th>Units</th><th style="text-align:right">Est. Cost</th><th style="text-align:right">Income</th></tr></thead><tbody id="beyond-tbody"></tbody></table></div>
    </div>
  </div>
</div>
<script>
const fmt=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',maximumFractionDigits:0}).format(n);
const fmtDec=n=>new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP',minimumFractionDigits:2}).format(n);
Chart.defaults.color='#6b6b8a';Chart.defaults.borderColor='#2a2a40';Chart.defaults.font.family="'DM Mono',monospace";Chart.defaults.font.size=11;
let forecastData=null,currentMode='payment',currentCase='best',costsOn=true;
function toggleUninvoiced(){const detail=document.getElementById('uninvoiced-detail'),label=document.getElementById('uninvoiced-toggle-label'),open=detail.style.display==='none';detail.style.display=open?'block':'none';label.textContent=open?'Hide ▲':'Show ▼';}
function typeClass(t){if(t==='Invoice')return 'type-invoice';if(t==='Bill')return 'type-bill';if(t==='Est. Monthly')return 'type-monthly';if(t==='Est. Weekly')return 'type-weekly';if(t==='Confirmed Event')return 'type-confirmed';if(t==='Est. Event Cost')return 'type-cost';return 'type-provisional';}
function renderDetail(wi){const week=forecastData._weeks[wi];document.querySelectorAll('.week-col').forEach((c,i)=>c.classList.toggle('active',i===wi));const panel=document.getElementById('detail-panel');panel.classList.add('visible');document.getElementById('detail-title').textContent=week.label+' ('+week.weekStart+' \u2192 '+week.weekEnd+')';const xeroIn=week.inflows.filter(i=>i.source==='xero'),spIn=week.inflows.filter(i=>i.source==='sonderplan');document.getElementById('detail-in-title').textContent='Inflows \u2014 '+fmt(week.totalIn)+(week.pipelineIn>0?' ('+fmt(week.confirmedIn)+' confirmed + '+fmt(week.pipelineIn)+' pipeline)':'');const makeInRow=i=>'<div class="detail-row"><span class="dr-ref">'+i.ref+'</span><div class="dr-name">'+i.contact+(i.priceFlag&&i.priceFlag!=='Clean'?' <span style="color:var(--muted);font-size:0.58rem">['+i.priceFlag+']</span>':'')+'</div><span class="dr-amt">'+fmtDec(i.amount)+'</span><span class="dr-type '+typeClass(i.type)+'">'+i.type+'</span></div>';const makeCostRow=i=>'<div class="detail-row"><span class="dr-ref">'+i.ref+'</span><div class="dr-name">'+i.contact+'<div class="dr-breakdown">'+(i.breakdown||'')+'</div></div><span class="dr-amt">'+fmtDec(i.amount)+'</span><span class="dr-type type-cost">Est. Cost</span></div>';let inHtml='';if(xeroIn.length){inHtml+='<div style="font-size:0.6rem;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:6px">Confirmed (Xero)</div>'+xeroIn.map(makeInRow).join('');}if(spIn.length){inHtml+='<div style="font-size:0.6rem;color:var(--accent);letter-spacing:0.1em;text-transform:uppercase;margin:'+(xeroIn.length?'12px':'0')+'px 0 6px">Pipeline (Sonderplan)</div>'+spIn.map(makeInRow).join('');}if(!inHtml)inHtml='<div class="empty-state">No inflows this week</div>';document.getElementById('detail-inflows').innerHTML=inHtml;const costOut=week.outflows.filter(o=>o.source==='staff-estimate'),otherOut=week.outflows.filter(o=>o.source!=='staff-estimate'),costSum=costOut.reduce((a,o)=>a+o.amount,0);document.getElementById('detail-out-title').textContent='Outflows \u2014 '+fmt(week.totalOut)+(costSum>0?' (incl. '+fmt(costSum)+' est. costs)':'');let outHtml='';if(otherOut.length){outHtml+=otherOut.map(o=>o.source==='staff-estimate'?makeCostRow(o):makeInRow(o)).join('');}if(costOut.length){outHtml+='<div style="font-size:0.6rem;color:var(--orange);letter-spacing:0.1em;text-transform:uppercase;margin:'+(otherOut.length?'12px':'0')+'px 0 6px">Est. Event Costs</div>'+costOut.map(makeCostRow).join('');}document.getElementById('detail-outflows').innerHTML=outHtml||'<div class="empty-state">No outflows this week</div>';panel.scrollIntoView({behavior:'smooth',block:'nearest'});}
function closeDetail(){document.getElementById('detail-panel').classList.remove('visible');document.querySelectorAll('.week-col').forEach(c=>c.classList.remove('active'));}
function setMode(m){currentMode=m;document.getElementById('btn-payment').classList.toggle('active',m==='payment');document.getElementById('btn-event').classList.toggle('active',m==='event');if(forecastData)rebuild();}
function setCaseMode(m){currentCase=m;document.getElementById('btn-best').classList.toggle('active',m==='best');document.getElementById('btn-worst').classList.toggle('active',m==='worst');if(forecastData)rebuild();}
function setCosts(on){costsOn=on;document.getElementById('btn-costs-on').className='toggle-btn '+(on?'active-orange':'');document.getElementById('btn-costs-off').className='toggle-btn '+(on?'':'active-orange');if(forecastData)rebuild();}
function getWeekIndex(dateStr,forecastFrom){return Math.floor((new Date(dateStr).getTime()-new Date(forecastFrom).getTime())/(86400000*7));}
function rebuild(){const data=forecastData,weeks=JSON.parse(JSON.stringify(data.weeks));for(const w of weeks){w.inflows=w.inflows.filter(i=>i.source!=='sonderplan');w.outflows=w.outflows.filter(o=>o.source!=='staff-estimate');w.totalIn=w.inflows.reduce((a,i)=>a+i.amount,0);w.totalOut=w.outflows.reduce((a,o)=>a+o.amount,0);w.pipelineIn=0;w.estimatedCosts=0;}const items=(data.pipeline.allItems||[]).filter(p=>currentCase==='best'||p.status==='Confirmed');for(const item of items){const inDate=currentMode==='event'?item.eventStart:item.paymentDate,wiIn=getWeekIndex(inDate,data.forecastFrom);if(wiIn>=0&&wiIn<34){weeks[wiIn].inflows.push({ref:item.id,contact:item.name,amount:item.price,due:inDate,type:item.status==='Confirmed'?'Confirmed Event':'Provisional Event',source:'sonderplan',status:item.status,priceFlag:item.priceFlag});weeks[wiIn].totalIn+=item.price;weeks[wiIn].pipelineIn+=item.price;}if(costsOn&&item.costs&&item.costs.total>0){const wiCost=getWeekIndex(item.eventStart,data.forecastFrom);if(wiCost>=0&&wiCost<34){weeks[wiCost].outflows.push({ref:item.id,contact:item.name,amount:item.costs.total,due:item.eventStart,type:'Est. Event Cost',source:'staff-estimate',unitCount:item.unitCount,eventDays:item.eventDays,miles:item.costs.miles,nights:item.costs.nights,breakdown:item.costs.breakdown});weeks[wiCost].totalOut+=item.costs.total;weeks[wiCost].estimatedCosts+=item.costs.total;}}}let running=data.openingBalance;for(const w of weeks){w.net=w.totalIn-w.totalOut;running+=w.net;w.runningBalance=running;}data._weeks=weeks;renderChart(data,weeks);renderWeekGrid(data,weeks);renderKPIs(data,weeks);}
function renderKPIs(data,weeks){const confirmedIn=weeks.reduce((a,w)=>a+w.confirmedIn,0),pipelineIn=weeks.reduce((a,w)=>a+w.pipelineIn,0),estimCosts=weeks.reduce((a,w)=>a+w.estimatedCosts,0),closing=weeks[weeks.length-1].runningBalance;document.getElementById('kpi-opening').textContent=fmt(data.openingBalance);document.getElementById('kpi-opening').className='pipeline-stat-value '+(data.openingBalance>=0?'positive':'negative');document.getElementById('kpi-confirmed').textContent=fmt(confirmedIn);document.getElementById('kpi-confirmed-sub').textContent=weeks.reduce((a,w)=>a+w.inflows.filter(i=>i.source==='xero').length,0)+' invoices';document.getElementById('kpi-pipeline').textContent=fmt(pipelineIn);document.getElementById('kpi-pipeline-sub').textContent=weeks.reduce((a,w)=>a+w.inflows.filter(i=>i.source==='sonderplan').length,0)+' events in window';document.getElementById('kpi-costs').textContent=fmt(estimCosts);document.getElementById('kpi-costs-sub').textContent=costsOn?'est. event costs shown':'costs hidden';const clEl=document.getElementById('kpi-closing');clEl.textContent=fmt(closing);clEl.className='kpi-value '+(closing>=0?'positive':'negative');}
function renderChart(data,weeks){if(window._fChart)window._fChart.destroy();window._fChart=new Chart(document.getElementById('forecastChart').getContext('2d'),{type:'bar',data:{labels:weeks.map(w=>w.label),datasets:[{label:'Confirmed In (Xero)',data:weeks.map(w=>w.confirmedIn),backgroundColor:'rgba(78,205,196,0.75)',borderRadius:0,borderSkipped:false,stack:'in'},{label:'Pipeline In (SP)',data:weeks.map(w=>w.pipelineIn),backgroundColor:'rgba(124,106,247,0.6)',borderRadius:3,borderSkipped:false,stack:'in'},{label:'Est. Event Costs',data:weeks.map(w=>w.estimatedCosts),backgroundColor:'rgba(255,159,67,0.7)',borderRadius:0,borderSkipped:false,stack:'out'},{label:'Other Outflows',data:weeks.map(w=>w.totalOut-w.estimatedCosts),backgroundColor:'rgba(255,107,107,0.65)',borderRadius:3,borderSkipped:false,stack:'out'},{label:'Balance',data:weeks.map(w=>w.runningBalance),type:'line',borderColor:'#ffd93d',backgroundColor:'rgba(255,217,61,0.05)',borderWidth:2,pointRadius:3,pointBackgroundColor:weeks.map(w=>w.runningBalance>=0?'#ffd93d':'#ff6b6b'),fill:true,tension:0.3,yAxisID:'y1',stack:undefined}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index'},plugins:{legend:{display:true,position:'bottom',labels:{boxWidth:10,padding:12}},tooltip:{callbacks:{afterBody:items=>{const wi=items[0].dataIndex;return['Net: '+fmt(weeks[wi].net),' Conf: '+fmt(weeks[wi].confirmedIn),' Pipeline: '+fmt(weeks[wi].pipelineIn),' Est.Costs: '+fmt(weeks[wi].estimatedCosts)];},}}},scales:{x:{grid:{color:'#2a2a40'}},y:{grid:{color:'#2a2a40'},ticks:{callback:v=>fmt(v)},title:{display:true,text:'In / Out',color:'#6b6b8a',font:{size:10}},stacked:true},y1:{position:'right',grid:{display:false},ticks:{callback:v=>fmt(v)},title:{display:true,text:'Balance',color:'#6b6b8a',font:{size:10}}}}}});}
function renderWeekGrid(data,weeks){document.getElementById('week-grid').innerHTML=weeks.map((w,i)=>{const danger=w.runningBalance<0,netClass=w.net>0?'net-positive':w.net<0?'net-negative':'net-zero';return'<div class="week-col'+(danger?' danger':'')+'" onclick="renderDetail('+i+')">'+'<div class="week-label">'+w.label+'</div>'+'<div class="week-in">\u2191 '+fmt(w.confirmedIn)+'</div>'+(w.pipelineIn>0?'<div class="week-pipeline">\u25C6 '+fmt(w.pipelineIn)+'</div>':'')+(w.estimatedCosts>0?'<div class="week-costs">\u25BC '+fmt(w.estimatedCosts)+'</div>':'')+'<div class="week-out">\u2193 '+fmt(w.totalOut)+'</div>'+'<div class="week-net '+netClass+'">'+(w.net>=0?'+':'')+fmt(w.net)+'</div>'+'<div class="week-balance">Bal '+fmt(w.runningBalance)+'</div></div>';}).join('');}
async function loadForecast(){try{const res=await fetch('/api/forecast');if(!res.ok)throw new Error(await res.text());forecastData=await res.json();document.getElementById('loading-state').style.display='none';document.getElementById('forecast-content').style.display='block';document.getElementById('sp-confirmed').textContent=fmt(forecastData.pipeline.confirmedTotal);document.getElementById('sp-provisional').textContent=fmt(forecastData.pipeline.provisionalTotal);document.getElementById('sp-count').textContent=forecastData.pipeline.inWindowCount+' events';const warnings=forecastData.uninvoicedWarnings||[];if(warnings.length>0){document.getElementById('uninvoiced-banner').style.display='block';document.getElementById('uninvoiced-summary').textContent=warnings.length+' event'+(warnings.length===1?'':'s')+' — '+fmt(forecastData.uninvoicedTotalValue)+' total value — not in forecast figures';const statusBadge=s=>'<span style="font-size:0.6rem;padding:2px 6px;border-radius:3px;background:rgba(255,107,107,0.15);color:var(--red)">'+s+'</span>';const flagColour=f=>f==='Clean'?'var(--green)':f==='No Quote'?'var(--red)':'var(--accent4)';document.getElementById('uninvoiced-tbody').innerHTML=warnings.map(p=>'<tr><td style="padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.4)">'+p.name+'</td><td style="padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.4)">'+statusBadge(p.status)+'</td><td style="padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.4);color:var(--muted)">'+p.eventStart+' \u2192 '+p.eventEnd+'</td><td style="padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.4);text-align:right;font-family:Syne,sans-serif;font-weight:600">'+fmtDec(p.price)+'</td><td style="padding:7px 0;border-bottom:1px solid rgba(42,42,64,0.4);color:'+flagColour(p.priceFlag)+';font-size:0.62rem;padding-left:12px">'+p.priceFlag+'</td></tr>').join('');}const allItems=forecastData.pipeline.allItems||[];const totalCosts=allItems.reduce((a,p)=>a+(p.costs?.total||0),0),totalWages=allItems.reduce((a,p)=>a+(p.costs?.wages||0),0),totalMileage=allItems.reduce((a,p)=>a+(p.costs?.mileage||0),0),totalHotelSubs=allItems.reduce((a,p)=>a+(p.costs?.hotel||0)+(p.costs?.subsistence||0),0);document.getElementById('cost-total').textContent=fmt(totalCosts);document.getElementById('cost-wages').textContent=fmt(totalWages);document.getElementById('cost-mileage').textContent=fmt(totalMileage);document.getElementById('cost-hotel').textContent=fmt(totalHotelSubs);const beyond=forecastData.pipeline.beyondWindow||[];document.getElementById('beyond-badge').textContent=beyond.length+' events';const statusBadge=s=>'<span style="font-size:0.6rem;padding:2px 6px;border-radius:3px;background:rgba(124,106,247,0.15);color:var(--accent)">'+s+'</span>';document.getElementById('beyond-tbody').innerHTML=beyond.length?beyond.map(p=>'<tr><td>'+p.name+'</td><td>'+statusBadge(p.status)+'</td><td>'+p.eventStart+'</td><td>'+p.paymentDate+'</td><td style="color:var(--muted)">'+p.unitCount+'u</td><td style="text-align:right;color:var(--orange)">'+fmt(p.costs?.total||0)+'</td><td style="text-align:right;font-family:Syne,sans-serif;font-weight:600">'+fmtDec(p.price)+'</td></tr>').join(''):'<tr><td colspan="7" style="color:var(--muted);padding:12px 0">No events beyond the forecast window</td></tr>';rebuild();const firstActive=(forecastData._weeks||[]).findIndex(w=>w.inflows.length>0||w.outflows.length>0);if(firstActive>=0)renderDetail(firstActive);}catch(e){document.getElementById('loading-state').innerHTML='<div class="error-text">Error: '+e.message+'</div>';}}
loadForecast();
</script>
</body></html>
`;

// ─── Settings HTML ─────────────────────────────────────────────────────────────
const SETTINGS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cost Settings</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--surface:#12121a;--surface2:#1a1a26;--border:#2a2a40;--accent:#7c6af7;--text:#e8e8f0;--muted:#6b6b8a;--green:#51cf66;--red:#ff6b6b;--orange:#ff9f43}
body{background:var(--bg);color:var(--text);font-family:'DM Mono',monospace;min-height:100vh}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:40px 40px;opacity:0.25;pointer-events:none;z-index:0}
.container{position:relative;z-index:1;max-width:800px;margin:0 auto;padding:40px 32px}
header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:40px;padding-bottom:24px;border-bottom:1px solid var(--border)}
.logo-area h1{font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;letter-spacing:-0.03em}
.logo-area h1 span{color:var(--accent)}
.logo-area p{font-size:0.7rem;color:var(--muted);margin-top:4px;letter-spacing:0.1em;text-transform:uppercase}
.nav-links{display:flex;gap:8px}
.nav-link{font-size:0.68rem;color:var(--accent);text-decoration:none;letter-spacing:0.08em;border:1px solid var(--accent);padding:5px 12px;border-radius:4px;transition:all 0.2s}
.nav-link:hover{background:var(--accent);color:#fff}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:28px;margin-bottom:20px}
.card-title{font-family:'Syne',sans-serif;font-size:0.85rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;margin-bottom:6px}
.card-desc{font-size:0.68rem;color:var(--muted);margin-bottom:24px;line-height:1.6}
.field-group{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.field-group-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.field{margin-bottom:0}
.field-label{font-size:0.62rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;display:block}
.field-hint{font-size:0.6rem;color:var(--muted);margin-top:4px;opacity:0.7}
input[type="text"],input[type="number"]{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:'DM Mono',monospace;font-size:0.85rem;padding:10px 14px;border-radius:5px;width:100%;transition:border-color 0.2s;outline:none}
input:focus{border-color:var(--accent)}
.toggle-row{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid var(--border)}
.toggle-row:last-child{border-bottom:none}
.toggle-label-col{flex:1}
.toggle-label-col strong{font-size:0.82rem;display:block;margin-bottom:3px}
.toggle-label-col span{font-size:0.65rem;color:var(--muted)}
.toggle{position:relative;width:44px;height:24px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:var(--border);border-radius:12px;cursor:pointer;transition:0.2s}
.slider::before{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:0.2s}
input:checked+.slider{background:var(--accent)}
input:checked+.slider::before{transform:translateX(20px)}
.btn-row{display:flex;gap:12px;align-items:center;margin-top:28px;padding-top:24px;border-top:1px solid var(--border)}
.btn-save{background:var(--orange);border:none;color:#fff;font-family:'DM Mono',monospace;font-size:0.75rem;font-weight:500;letter-spacing:0.1em;padding:12px 28px;border-radius:5px;cursor:pointer;text-transform:uppercase;transition:opacity 0.2s}
.btn-save:hover{opacity:0.85}
.btn-save:disabled{opacity:0.4;cursor:not-allowed}
.btn-reset{background:none;border:1px solid var(--border);color:var(--muted);font-family:'DM Mono',monospace;font-size:0.68rem;padding:10px 18px;border-radius:5px;cursor:pointer;letter-spacing:0.08em;text-transform:uppercase;transition:all 0.2s}
.btn-reset:hover{border-color:var(--accent);color:var(--accent)}
.status-msg{font-size:0.7rem;padding:8px 14px;border-radius:4px;display:none}
.status-msg.ok{background:rgba(81,207,102,0.12);color:var(--green);border:1px solid rgba(81,207,102,0.3)}
.status-msg.err{background:rgba(255,107,107,0.12);color:var(--red);border:1px solid rgba(255,107,107,0.3)}
.loading-text{font-size:0.68rem;color:var(--muted);letter-spacing:0.1em;text-transform:uppercase;animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@media(max-width:600px){.field-group,.field-group-3{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo-area"><h1>Settings<span>.</span></h1><p>Cost estimation assumptions</p></div>
    <div class="nav-links">
      <a href="/dashboard" class="nav-link">Dashboard</a>
      <a href="/forecast" class="nav-link">Forecast</a>
    </div>
  </header>
  <div id="loading-msg" class="loading-text" style="margin-bottom:20px">Loading current settings…</div>
  <div id="settings-form" style="display:none">
    <div class="card">
      <div class="card-title">Base Location & Travel</div>
      <div class="card-desc">Where vehicles are based, and how driving time and mileage are calculated.</div>
      <div class="field-group" style="margin-bottom:16px">
        <div class="field"><label class="field-label">Base postcode</label><input id="basePostcode" type="text" placeholder="GL10 3RF"><div class="field-hint">Geocoded via postcodes.io — changing this clears the distance cache</div></div>
        <div class="field"><label class="field-label">Driving speed (mph)</label><input id="drivingSpeedMph" type="number" step="5" min="10" placeholder="40"><div class="field-hint">Used to convert distance → driving hours paid. 40mph recommended for vans/trailers.</div></div>
      </div>
      <div class="field-group">
        <div class="field"><label class="field-label">Mileage rate (£/mile)</label><input id="mileageRatePerMile" type="number" step="0.01" min="0" placeholder="0.45"><div class="field-hint">HMRC approved: £0.45/mile — applied to return trip × units</div></div>
        <div class="field"><label class="field-label">Hotel threshold (miles)</label><input id="hotelThresholdMiles" type="number" step="5" min="0" placeholder="50"><div class="field-hint">Hotel added if one-way distance exceeds this, or event is multi-day</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Staff Costs</div>
      <div class="card-desc">1 staff per unit. Paid hours = operational hours + driving time (return) + setup/breakdown + contingency.</div>
      <div class="field-group" style="margin-bottom:16px">
        <div class="field"><label class="field-label">Hourly rate (£)</label><input id="hourlyRate" type="number" step="0.50" min="0" placeholder="12.50"><div class="field-hint">Rate per staff member per paid hour</div></div>
        <div class="field"><label class="field-label">Contingency hours (per event)</label><input id="contingencyHours" type="number" step="0.5" min="0" placeholder="1"><div class="field-hint">Added to every event regardless of resource type</div></div>
      </div>
      <div class="field-group" style="margin-bottom:16px">
        <div class="field"><label class="field-label">Driver payment terms (days after event end)</label><input id="driverPaymentDaysAfterEvent" type="number" step="1" min="0" placeholder="14"><div class="field-hint">Days after event end date before driver pay leaves the bank — used in cash flow timing</div></div>
      </div>
      <div class="field-group-3">
        <div class="field"><label class="field-label">Day Van setup (hours)</label><input id="setup_DayVan" type="number" step="0.5" min="0" placeholder="1"><div class="field-hint">Resources starting "Day Van"</div></div>
        <div class="field"><label class="field-label">Trailer setup (hours)</label><input id="setup_Trailer" type="number" step="0.5" min="0" placeholder="4"><div class="field-hint">Resources starting "Trailer"</div></div>
        <div class="field"><label class="field-label">POD setup (hours)</label><input id="setup_POD" type="number" step="0.5" min="0" placeholder="4"><div class="field-hint">Resources starting "POD"</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Accommodation & Subsistence</div>
      <div class="card-desc">Per staff per night/day.</div>
      <div class="field-group">
        <div class="field"><label class="field-label">Hotel nightly cost (£)</label><input id="hotelNightlyCost" type="number" step="5" min="0" placeholder="80"></div>
        <div class="field"><label class="field-label">Subsistence daily rate (£)</label><input id="subsistenceDailyRate" type="number" step="1" min="0" placeholder="5"><div class="field-hint">HMRC benchmark: £5/day</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Employment Status</div>
      <div class="card-desc">Currently all drivers are treated as self-employed. Enable PAYE to add employer on-costs to wage calculations.</div>
      <div class="toggle-row">
        <div class="toggle-label-col"><strong>PAYE mode</strong><span>Applies on-cost multiplier to all wage calculations globally</span></div>
        <label class="toggle"><input type="checkbox" id="payeMode"><span class="slider"></span></label>
      </div>
      <div style="margin-top:16px">
        <div class="field"><label class="field-label">PAYE on-cost multiplier</label><input id="payeOnCostMultiplier" type="number" step="0.01" min="1" placeholder="1.258"><div class="field-hint">Default 1.258 = employer NI 13.8% + holiday pay 12.07%. Only applied when PAYE mode is on.</div></div>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn-save" id="btn-save" onclick="saveSettings()">Save Settings</button>
      <button class="btn-reset" onclick="resetDefaults()">Reset to Defaults</button>
      <span class="status-msg" id="status-msg"></span>
    </div>
  </div>
</div>
<script>
const DEFAULTS={basePostcode:'GL10 3RF',hourlyRate:12.50,mileageRatePerMile:0.45,hotelThresholdMiles:50,hotelNightlyCost:80,subsistenceDailyRate:5,drivingSpeedMph:40,setupHours:{'Day Van':1,'Trailer':4,'POD':4},contingencyHours:1,payeMode:false,payeOnCostMultiplier:1.258,driverPaymentDaysAfterEvent:14};
function populate(s){document.getElementById('basePostcode').value=s.basePostcode||DEFAULTS.basePostcode;document.getElementById('hourlyRate').value=s.hourlyRate??DEFAULTS.hourlyRate;document.getElementById('mileageRatePerMile').value=s.mileageRatePerMile??DEFAULTS.mileageRatePerMile;document.getElementById('hotelThresholdMiles').value=s.hotelThresholdMiles??DEFAULTS.hotelThresholdMiles;document.getElementById('hotelNightlyCost').value=s.hotelNightlyCost??DEFAULTS.hotelNightlyCost;document.getElementById('subsistenceDailyRate').value=s.subsistenceDailyRate??DEFAULTS.subsistenceDailyRate;document.getElementById('drivingSpeedMph').value=s.drivingSpeedMph??DEFAULTS.drivingSpeedMph;document.getElementById('contingencyHours').value=s.contingencyHours??DEFAULTS.contingencyHours;document.getElementById('payeOnCostMultiplier').value=s.payeOnCostMultiplier??DEFAULTS.payeOnCostMultiplier;document.getElementById('driverPaymentDaysAfterEvent').value=s.driverPaymentDaysAfterEvent??DEFAULTS.driverPaymentDaysAfterEvent;document.getElementById('payeMode').checked=!!s.payeMode;const sh=s.setupHours||DEFAULTS.setupHours;document.getElementById('setup_DayVan').value=sh['Day Van']??1;document.getElementById('setup_Trailer').value=sh['Trailer']??4;document.getElementById('setup_POD').value=sh['POD']??4;}
function gather(){return{basePostcode:document.getElementById('basePostcode').value.trim(),hourlyRate:parseFloat(document.getElementById('hourlyRate').value),mileageRatePerMile:parseFloat(document.getElementById('mileageRatePerMile').value),hotelThresholdMiles:parseFloat(document.getElementById('hotelThresholdMiles').value),hotelNightlyCost:parseFloat(document.getElementById('hotelNightlyCost').value),subsistenceDailyRate:parseFloat(document.getElementById('subsistenceDailyRate').value),drivingSpeedMph:parseFloat(document.getElementById('drivingSpeedMph').value),contingencyHours:parseFloat(document.getElementById('contingencyHours').value),payeOnCostMultiplier:parseFloat(document.getElementById('payeOnCostMultiplier').value),driverPaymentDaysAfterEvent:parseInt(document.getElementById('driverPaymentDaysAfterEvent').value)||14,payeMode:document.getElementById('payeMode').checked,setupHours:{'Day Van':parseFloat(document.getElementById('setup_DayVan').value),'Trailer':parseFloat(document.getElementById('setup_Trailer').value),'POD':parseFloat(document.getElementById('setup_POD').value)}};}
function showStatus(msg,ok){const el=document.getElementById('status-msg');el.textContent=msg;el.className='status-msg '+(ok?'ok':'err');el.style.display='block';if(ok)setTimeout(()=>{el.style.display='none';},3000);}
async function saveSettings(){const btn=document.getElementById('btn-save');btn.disabled=true;btn.textContent='Saving…';try{const res=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(gather())});const data=await res.json();if(data.ok){showStatus('Saved \u2014 forecast will use new values on next load',true);}else{showStatus('Save failed \u2014 check worker logs',false);}}catch(e){showStatus('Error: '+e.message,false);}btn.disabled=false;btn.textContent='Save Settings';}
function resetDefaults(){populate(DEFAULTS);}
async function init(){try{const res=await fetch('/api/settings');const data=await res.json();document.getElementById('loading-msg').style.display='none';document.getElementById('settings-form').style.display='block';populate(data);}catch(e){document.getElementById('loading-msg').textContent='Error loading settings: '+e.message;document.getElementById('loading-msg').style.color='var(--red)';document.getElementById('loading-msg').style.animation='none';}}
init();
</script>
</body></html>
`;
