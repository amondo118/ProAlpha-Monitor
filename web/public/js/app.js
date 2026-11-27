/* ProAlpha Monitor: plain JavaScript, no build step, no external libraries.
 *
 * Loads data/data.json and data/meta.json, written by the importer from the
 * daily SAP exports:
 *   customers  always present
 *   invoices   only once the invoice export exists ({fields, rows} table form)
 * Every invoice-based part of the page checks S.hasInvoices and shows an
 * "export not connected yet" state without it. Adding a further export (e.g.
 * invoice lines / articles) follows the same pattern: index it in index(),
 * link it by customer number, render it where needed.
 *
 * Money rule: amounts are summed as integer cents, and only within the same
 * currency. Ügyintéző (account manager) = the customer's "Ügyintéző" field.
 */
"use strict";

const CONFIG = {
  pageSize: 50,
  pollMinutes: 10,            // how often the page checks for a new import
  staleHours: 30,             // warn when the export is older than this...
  exportsOnWeekends: false,   // ...not counting Saturdays and Sundays if SAP skips them
  newDays: 30,                // "new customer" window
  topN: 10,
  homeCountry: "HU",
  chartYears: 5,              // years shown in the customer's sales chart
  dueSoonDays: 7,             // open invoice due within this many days -> amber pill
  openInvoicesShown: 50,
};

/* ---------- small helpers ---------- */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + n); return isoDate(d); };
const cents = (v) => Math.round((v || 0) * 100);   // money -> integer cents, so sums are exact
const addTo = (map, key, c) => map.set(key, (map.get(key) || 0) + c);
const NONE = "__none";                              // filter value for "no Ügyintéző"

const NOW = new Date();
const TODAY = isoDate(NOW);
const YEAR = NOW.getFullYear();
const daysAgo = (n) => isoDate(new Date(YEAR, NOW.getMonth(), NOW.getDate() - n));
/* ---------- settings (per browser) ---------- */
const loadJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const saveJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered */ } };
const SETTINGS_DEFAULT = { newDays: 30, amount: "net" };
let SETTINGS = { ...SETTINGS_DEFAULT, ...loadJson("settings", {}) };
let CUSTOM_PERIODS = loadJson("customPeriods", []);   // [{id, name, from, to}]
/* Net or gross: one switch in the top bar for every view. The control totals on
   the status page stay net (they check the import, not the view). */
const isGross = () => SETTINGS.amount === "gross";
const amtOf = (i) => (isGross() ? (i.gross ?? i.net) : i.net);
const val = (i) => cents(amtOf(i));
const amtWord = () => t(isGross() ? "sales.gross" : "sales.net");

// "New customer" window (days), from the settings
const PERIOD = {};
function applyNewDays() {
  CONFIG.newDays = Math.max(1, Math.round(+SETTINGS.newDays || 30));
  PERIOD.new = daysAgo(CONFIG.newDays - 1);
  PERIOD.prevNew = daysAgo(CONFIG.newDays * 2 - 1);
}
applyNewDays();

/* ---------- the viewed period (top bar) ----------
   Every "this period" figure on the site uses P: sales, active customers, new
   customers, offers… and compares with P.prevFrom–P.prevTo: the same period one
   year earlier, or for periods longer than a year the equally long period
   before it (so the two never overlap). */
const PERIOD_KEYS = ["ytd", "12m", "q", "pq", "h", "ph", "ly", "2y", "3y", "all"];
let P = null;
const inCur = (d) => !!d && d >= P.from && d <= P.to;
const inPrev = (d) => !!d && !!P.prevFrom && d >= P.prevFrom && d <= P.prevTo;

/* Company-wide settings from config/idoszakok.toml (via meta.json) */
const fiscalStart = () => Math.min(12, Math.max(1, S.meta?.periods?.fiscal_start || 1)) - 1;   // 0 = January
const sharedPeriods = () => S.meta?.periods?.shared || [];

/* A period key -> {from, to, short}. Year-based periods follow the fiscal year
   (config/idoszakok.toml); with a January start they are calendar periods. */
function periodRange(key) {
  const F0 = fiscalStart(), m = NOW.getMonth();
  const D = (Y, M, d) => isoDate(new Date(Y, M, d));
  const fy = m >= F0 ? YEAR : YEAR - 1;                  // the fiscal year we're in (by its first calendar year)
  const fyName = (y) => (F0 === 0 ? String(y) : t("per.fy", { y: `${y}/${String(y + 1).slice(2)}` }));
  const into = (m - F0 + 12) % 12;                         // months since the fiscal year began
  const fq = Math.floor(into / 3), fh = Math.floor(into / 6);
  const roman = (n) => (LANG === "hu" ? ["I", "II", "III", "IV"][n - 1] : n);
  const part = (kind, y, n) => (F0 === 0 ? t(`period.${kind}`, { y, n: roman(n) }) : t(`per.f${kind}`, { y: fyName(y), n: roman(n) }));
  if (key === "12m") return { from: D(YEAR, m - 11, 1), to: TODAY, short: t("per.short.12m") };
  if (key === "q") return { from: D(fy, F0 + fq * 3, 1), to: TODAY, short: part("quarter", fy, fq + 1) };
  if (key === "pq") {
    const y = fq === 0 ? fy - 1 : fy, n = fq === 0 ? 4 : fq;
    return { from: D(y, F0 + (n - 1) * 3, 1), to: D(y, F0 + n * 3, 0), short: part("quarter", y, n) };
  }
  if (key === "h") return { from: D(fy, F0 + fh * 6, 1), to: TODAY, short: part("half", fy, fh + 1) };
  if (key === "ph") {
    const y = fh === 0 ? fy - 1 : fy, n = fh === 0 ? 2 : 1;
    return { from: D(y, F0 + (n - 1) * 6, 1), to: D(y, F0 + n * 6, 0), short: part("half", y, n) };
  }
  if (key === "ly") return { from: D(fy - 1, F0, 1), to: D(fy, F0, 0), short: fyName(fy - 1) };
  if (key === "2y") return { from: D(fy - 1, F0, 1), to: TODAY, short: `${fyName(fy - 1)} – ${fyName(fy)}` };
  if (key === "3y") return { from: D(fy - 2, F0, 1), to: TODAY, short: `${fyName(fy - 2)} – ${fyName(fy)}` };
  if (key === "all") return { from: S.firstDate || D(fy, F0, 1), to: TODAY, short: t("per.short.all") };
  if (key === "ytd") return { from: D(fy, F0, 1), to: TODAY, short: F0 === 0 ? t("per.short.ytd") : fyName(fy) };
  const c = key.startsWith("s:") ? sharedPeriods().find((x) => `s:${x.id}` === key)
    : CUSTOM_PERIODS.find((x) => `c:${x.id}` === key);
  return c ? { from: c.from, to: c.to, short: c.name, name: c.name } : null;
}
function buildPeriod(key) {
  let r = periodRange(key);
  if (!r) { key = "ytd"; r = periodRange(key); }
  // a period reaching into the future ends today (there is no data after today,
  // and the comparison would otherwise span the whole future length)
  if (r.to > TODAY && r.from <= TODAY) r = { ...r, to: TODAY };
  const span = daysBetween(r.from, r.to) + 1;
  const shift = key === "all" ? 0 : Math.max(1, Math.ceil(span / 366));
  return { key, from: r.from, to: r.to, shift,
    prevFrom: shift ? shiftIsoYear(r.from, -shift) : null, prevTo: shift ? shiftIsoYear(r.to, -shift) : null,
    short: r.short, name: r.name };
}
function periodOptionLabel(key) {
  const r = periodRange(key);
  if (!r) return key;
  if (r.name) return `${r.name} (${F.date(r.from)} – ${F.date(r.to)})`;
  if (fiscalStart() && (key === "ytd" || key === "ly")) return t(`per.f${key}`, { s: r.short });
  return t("per." + key, { s: r.short });
}
const periodKeySaved = () => { try { return localStorage.getItem("period") || "ytd"; } catch { return "ytd"; } };

/* ---------- formatting (rebuilt when the language changes) ---------- */

let F;
function buildFormatters() {
  const loc = LOCALES[LANG];
  const cache = new Map();
  const nf = (o) => {
    const k = JSON.stringify(o);
    // Always group thousands ("3 757", not "3757") so numbers in a column line up
    if (!cache.has(k)) cache.set(k, new Intl.NumberFormat(loc, { useGrouping: "always", ...o }));
    return cache.get(k);
  };
  const minor = (cur) => (cur === "HUF" ? 0 : 2);
  const curFmt = (cur, extra = {}) => {
    try { return nf({ style: "currency", currency: cur, minimumFractionDigits: minor(cur), maximumFractionDigits: minor(cur), ...extra }); }
    catch { return null; } // missing or unknown currency code
  };
  F = {
    loc,
    money: (v, cur) => (v == null ? "" : curFmt(cur)?.format(v) ?? `${nf({ maximumFractionDigits: 2 }).format(v)} ${cur || ""}`.trim()),
    /* "41,3 M Ft" split into number and unit, for the big KPI style */
    compactParts: (v, cur) => {
      const f = curFmt(cur, { notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 });
      if (!f) return { num: nf({ notation: "compact", maximumFractionDigits: 1 }).format(v), unit: cur || "" };
      let num = "", unit = [];
      for (const p of f.formatToParts(v)) {
        if (["integer", "group", "decimal", "fraction", "minusSign", "plusSign"].includes(p.type)) num += p.value;
        else if (p.type === "compact" || p.type === "currency") unit.push(p.value);
      }
      return { num, unit: unit.join(" ") };
    },
    axis: (v) => nf({ notation: "compact", maximumFractionDigits: 1 }).format(v),
    num: (v) => (v == null ? "" : nf({ maximumFractionDigits: 2 }).format(v)),
    pct: (v) => (v == null || !isFinite(v) ? "–" : nf({ style: "percent", maximumFractionDigits: 1 }).format(v)),
    signedPct: (v) => (v == null || !isFinite(v) ? "–" : nf({ style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(v)),
    date: (iso) => (iso ? new Date(iso.slice(0, 10) + "T00:00:00").toLocaleDateString(loc) : ""),
    dateTime: (d) => d.toLocaleString(loc, { dateStyle: "medium", timeStyle: "short" }),
    month: (ym) => new Intl.DateTimeFormat(loc, { month: "short" }).format(new Date(ym + "-01T00:00:00")),
    monthYear: (ym) => new Intl.DateTimeFormat(loc, { month: "long", year: "numeric" }).format(new Date(ym + "-01T00:00:00")),
    country: (code) => {
      try { return code ? new Intl.DisplayNames([loc], { type: "region" }).of(code) || code : ""; } catch { return code || ""; }
    },
    decimalComma: (1.5).toLocaleString(loc).includes(","),
  };
}

/* Amounts per currency (cents) -> "1 234 Ft · 56,00 EUR" */
const moneyList = (map) => [...map.entries()].filter(([, c]) => c).sort()
  .map(([cur, c]) => F.money(c / 100, cur)).join(" · ");

/* ---------- data ---------- */

const S = {
  meta: null, customers: [], byId: new Map(), managers: new Map(), groups: new Map(),
  hasInvoices: false, invoiceCount: 0,
  hasPayments: false,   // only with a payment (cleared) column: open-invoice views
  hasOffers: false, offers: [],  // offers (BF = A): counted per Ügyintéző, never sales
  invoices: [],         // every invoice, with .c = its customer (for the sales view)
};

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function load() {
  try {
    const [meta, data] = await Promise.all([fetchJson("data/meta.json"), fetchJson("data/data.json")]);
    S.meta = meta;
    S.data = data;   // kept: a new period or setting re-indexes it
    index(data);
    S.checks = null; // recomputed for the new data
    renderChrome();
    renderPeriodSelect();
    route();
  } catch (e) {
    console.error(e);
    showBanner(t("banner.loadError", { msg: e.message }), true);
    $("#freshness").textContent = t("nodata");
  }
}

async function poll() {
  try {
    const meta = await fetchJson("data/meta.json");
    if (!S.meta || meta.generated_at !== S.meta.generated_at) await load();
    else { renderFreshness(); renderTabs(); } // staleness changes with time
  } catch { /* keep showing the last good data */ }
}

/* {fields, rows} table form -> list of objects */
const expand = (t) => (!t ? null : Array.isArray(t) ? t : t.rows.map((r) => Object.fromEntries(t.fields.map((f, i) => [f, r[i]]))));

const pmKey = (c) => c.account_manager || NONE;
const pmName = (key) => (key === NONE ? t("none") : key);

/* Build lookups and statistics once per import. */
function index(data) {
  S.customers = (data.customers || []).map((c) => ({
    ...c,
    // Name from the code list, or the raw code if the list has no entry for it
    industryLabel: c.industry || c.industry_code || null,
    regionLabel: c.region || c.region_code || null,
    currencyLabel: c.currency || c.currency_code || null,
    isNew: !!c.created && c.created >= PERIOD.new,
    invoices: [],
    _s: [c.id, c.name, c.search_term, c.tax_number, c.eu_vat_number, c.group, c.supplier_id, c.account_manager, c.city]
      .filter(Boolean).join(" ").toLowerCase(),
  }));
  S.byId = new Map(S.customers.map((c) => [c.id, c]));
  S.groups = new Map();
  for (const c of S.customers) if (c.group) (S.groups.get(c.group) || S.groups.set(c.group, []).get(c.group)).push(c);

  // Invoices, linked by customer number
  const invoices = expand(data.invoices);
  S.hasInvoices = !!invoices;
  S.invoiceCount = invoices?.length || 0;
  // Without a payment column every invoice would look open: open-invoice views are hidden then
  S.hasPayments = !!S.meta.sources?.invoices?.has_payments;
  S.invoices = [];
  for (const inv of invoices || []) {
    const c = S.byId.get(inv.customer_id);
    if (!c) continue; // reported by the importer
    const cur = inv.currency || inv.currency_code || c.currency || "";
    const due = inv.due || (inv.date && c.payment_terms != null ? addDays(inv.date, c.payment_terms) : null);
    const open = S.hasPayments && !inv.cleared;
    const x = { ...inv, c, cur, dueEff: due, dueEstimated: !inv.due && !!due, open,
      daysOverdue: open && due ? daysBetween(due, TODAY) : null };
    c.invoices.push(x);
    S.invoices.push(x);
  }
  for (const c of S.customers) c.invoices.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id, undefined, { numeric: true }));
  // The viewed period ("all" starts at the earliest invoice), before any statistics
  S.firstDate = S.invoices.reduce((a, i) => (i.date && (!a || i.date < a) ? i.date : a), null)
    || S.customers.reduce((a, c) => (c.created && (!a || c.created < a) ? c.created : a), null);
  P = buildPeriod(periodKeySaved());
  for (const c of S.customers) c.st = customerStats(c);

  S.managers = new Map();
  for (const c of S.customers) {
    const k = pmKey(c);
    if (!S.managers.has(k)) S.managers.set(k, newManager(k));
    const m = S.managers.get(k);
    m.customers.push(c);
    m.count++;
    if (c.isNew) m.new30++;
    if (inCur(c.created)) m.newYtd++;
    if (c.country && c.country !== CONFIG.homeCountry) m.foreign++;
    if (c.created && (!m.last || c.created > m.last)) m.last = c.created;
    for (const [cur, v] of c.st.ytd) addTo(m.ytd, cur, v);
    for (const [cur, v] of c.st.prev) addTo(m.prev, cur, v);
    for (const [cur, v] of c.st.total) addTo(m.total, cur, v);
    for (const [cur, v] of c.st.open) addTo(m.open, cur, v);
    if (c.st.ytdCount + c.st.ytdCredits) m.active++;
    if (c.st.prevCount) m.activePrev++;
    for (const i of c.invoices) m.invoices.push(i);
  }
  // Offers: never sales. Each belongs to the Ügyintéző who issued it (the
  // document's Ügyintéző, paired with the manager names via kodlistak.toml
  // [ugyintezok]); without one, to the customer's Ügyintéző.
  const offers = expand(data.offers);
  S.hasOffers = !!offers;
  S.offers = [];
  const byName = new Map([...S.managers.keys()].map((k) => [k.toLowerCase().replace(/\s+/g, " "), k]));
  const managerOf = (o, c) => {
    const clerk = (o.clerk || "").trim().replace(/\s+/g, " ");
    if (clerk) return byName.get(clerk.toLowerCase()) || clerk;
    return c ? pmKey(c) : NONE;
  };
  for (const o of offers || []) {
    const c = S.byId.get(o.customer_id);
    if (!c) continue; // reported by the importer
    const key = managerOf(o, c);
    if (!S.managers.has(key)) S.managers.set(key, newManager(key)); // issued offers, has no customers
    const x = { ...o, c, cur: o.currency || o.currency_code || c.currency || "", mgr: key };
    S.offers.push(x);
    const m = S.managers.get(key);
    m.offers.push(x);
    if (inCur(x.date)) { m.offersYtd++; m.offerCustomers.add(c); }
    else if (inPrev(x.date)) m.offersPrev++;
  }
  for (const m of S.managers.values()) m.offers.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id, undefined, { numeric: true }));
  for (const m of S.managers.values()) m._s = pmName(m.key).toLowerCase();
}

function newManager(key) {
  return { key, customers: [], count: 0, new30: 0, newYtd: 0, foreign: 0, last: null,
    ytd: new Map(), prev: new Map(), total: new Map(), open: new Map(), active: 0, activePrev: 0, invoices: [],
    offers: [], offersYtd: 0, offersPrev: 0, offerCustomers: new Set() };
}

/* Per-customer invoice figures, per currency in cents. */
function customerStats(c) {
  const st = { ytd: new Map(), prev: new Map(), total: new Map(), open: new Map(), byYear: new Map(),
    openN: 0, overdueN: 0, firstYear: null, lastYear: null, ytdCount: 0, ytdCredits: 0, prevCount: 0, count: 0, firstDate: null };
  const counts = new Map();
  for (const i of c.invoices) {
    const v = val(i);
    counts.set(i.cur, (counts.get(i.cur) || 0) + 1);
    addTo(st.total, i.cur, v);
    st.count++;
    if (i.date && (!st.firstDate || i.date < st.firstDate)) st.firstDate = i.date;
    if (inCur(i.date)) { if (i.credit) st.ytdCredits++; else st.ytdCount++; }
    if (inPrev(i.date)) st.prevCount++;
    if (i.date) {
      const y = +i.date.slice(0, 4);
      if (!st.byYear.has(y)) st.byYear.set(y, new Map());
      addTo(st.byYear.get(y), i.cur, v);
      st.firstYear = Math.min(st.firstYear ?? y, y);
      st.lastYear = Math.max(st.lastYear ?? y, y);
      if (inCur(i.date)) addTo(st.ytd, i.cur, v);
      if (inPrev(i.date)) addTo(st.prev, i.cur, v);
    }
    if (i.open) {
      addTo(st.open, i.cur, v);
      st.openN++;
      if (i.daysOverdue > 0) st.overdueN++;
    }
  }
  // Main currency: the customer's own, else the one most invoices use
  st.cur = c.currency || [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "HUF";
  st.main = (map) => (map.get(st.cur) || 0) / 100;
  st.others = (map) => new Map([...map].filter(([cur]) => cur !== st.cur));
  return st;
}

/* ---------- routing & URL state ---------- */

const VIEWS = ["overview", "sales", "managers", "customers", "customer", "manager", "status", "help", "settings"];
const TABS = ["overview", "sales", "customers", "managers"];
let current = { view: "overview", params: new URLSearchParams() };
let viewUpdate = null;
const tablePage = {};

function parseHash() {
  const [path, qs] = location.hash.slice(1).split("?");
  return { view: VIEWS.includes(path) ? path : "overview", params: new URLSearchParams(qs || "") };
}

function setParams(updates) {
  for (const [k, v] of Object.entries(updates)) {
    if (v === "" || v == null) current.params.delete(k);
    else current.params.set(k, v);
  }
  const qs = current.params.toString();
  history.replaceState(null, "", `#${current.view}${qs ? "?" + qs : ""}`);
}

let lastRoute = "";
function route() {
  if (!S.meta) return;
  current = parseHash();
  renderTabs();
  // Browser tab title: the open part of the site (customer and Ügyintéző pages set their own name)
  document.title = current.view === "overview" ? t("app.title") : `${t("nav." + current.view)} – ${t("app.title")}`;
  const main = $("#view");
  main.innerHTML = "";
  viewUpdate = null;
  ({ overview: renderOverview, sales: renderSales, managers: renderManagers, customers: renderCustomers,
    customer: renderCustomer, manager: renderManager, status: renderStatus, help: renderHelp, settings: renderSettings })[current.view](main);
  // a new page starts at the top; re-rendering the same page (language, resize) keeps the position
  const where = `${current.view}?${current.params.get("id") || ""}`;
  if (where !== lastRoute) window.scrollTo(0, 0);
  lastRoute = where;
  showWelcome();
}

const customerHref = (id) => `#customer?id=${encodeURIComponent(id)}`;

/* ---------- page chrome ---------- */

function applyStaticText() {
  document.documentElement.lang = LANG;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $("#global-q").placeholder = t("search.placeholder", { id: S.customers[0]?.id ?? "3000095" });
}

function renderChrome() {
  applyStaticText();
  renderFreshness();
  renderBanner();
}

const WARN_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5z" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.6" stroke="currentColor" stroke-width="2"
  stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.2" fill="currentColor"/></svg>`;

const HELP_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2" fill="none"
  stroke="currentColor" stroke-width="2"/><path d="M9.4 9.3a2.7 2.7 0 1 1 3.9 2.4c-.8.4-1.3 1-1.3 1.9v.6" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1.2" fill="currentColor"/></svg>`;

const GEAR_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor"
  stroke-width="2"/><path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"
  stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="6.4" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

function renderTabs() {
  const active = current.view === "customer" ? "customers" : current.view === "manager" ? "managers" : current.view;
  const st = importStatus();
  const label = st.failed ? t("chk.failed", { n: st.failed }) : st.stale ? t("status.stale") : st.count ? t("status.warnings", { n: st.count }) : t("status.ok");
  $("#tabs").innerHTML = TABS.map((v) =>
    `<a href="#${v}"${v === active ? ' aria-current="page"' : ""}>${esc(t("nav." + v))}</a>`).join("") +
    `<span class="tab-icons">
      <a href="#status" class="tab-icon${st.stale ? " bad" : st.count ? " warn" : ""}"${active === "status" ? ' aria-current="page"' : ""}
        title="${esc(`${t("nav.status")}: ${label}`)}" aria-label="${esc(`${t("nav.status")}: ${label}`)}">${WARN_ICON}${
        st.count || st.stale ? `<span class="count">${st.stale && !st.count ? "!" : esc(F.num(st.count))}</span>` : ""}</a>
      <a href="#help" class="tab-icon"${active === "help" ? ' aria-current="page"' : ""} title="${esc(t("nav.help"))}" aria-label="${esc(t("nav.help"))}">${HELP_ICON}</a>
      <a href="#settings" class="tab-icon"${active === "settings" ? ' aria-current="page"' : ""} title="${esc(t("nav.settings"))}" aria-label="${esc(t("nav.settings"))}">${GEAR_ICON}</a>
    </span>`;
}

/* Self-check: the page recomputes the importer's control totals in several
   independent ways (from the invoices, from the customers, from the Ügyintézők,
   period by period). Any mismatch shows on the status tab and turns it red. */
function computeChecks() {
  const m = S.meta, checks = [];
  if (!m) return checks;
  const add = (label, ok, detail) => checks.push({ label, ok, detail });
  const fmtMap = (map, money) => [...map.entries()].sort().map(([c, v]) => (money ? F.money(v / 100, c) : `${c} ${F.num(v)}`)).join(" · ") || "–";
  const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  const ref = m.checks || {};
  if (ref.customers != null) add(t("chk.customers"), ref.customers === S.customers.length, `${F.num(ref.customers)} / ${F.num(S.customers.length)}`);
  const src = m.sources?.invoices;
  if (src?.raw_rows != null) {
    const sum = src.rows + (src.offers || 0) + (src.skipped_rows || 0) + (src.skipped_types || 0) + src.skipped_blocked + src.duplicates_merged;
    add(t("chk.rows"), sum === src.raw_rows, t("chk.rowsDetail", { raw: F.num(src.raw_rows), rows: F.num(src.rows), offers: F.num(src.offers || 0),
      types: F.num(src.skipped_types || 0), skipped: F.num(src.skipped_rows || 0), blocked: F.num(src.skipped_blocked), merged: F.num(src.duplicates_merged) }));
  }
  if (!S.hasInvoices) return checks;
  // 1) the page's invoices vs the importer's control totals
  const count = new Map(), net = new Map();
  for (const i of S.invoices) if (i.date) { count.set(i.cur, (count.get(i.cur) || 0) + 1); addTo(net, i.cur, cents(i.net)); }
  const refCount = new Map(Object.entries(ref.invoices_by_currency || {})), refNet = new Map(Object.entries(ref.net_cents_by_currency || {}));
  add(t("chk.count"), same(count, refCount), fmtMap(count));
  add(t("chk.net"), same(net, refNet), fmtMap(net, true));
  // 2) the same sums via the customers and via the Ügyintézők
  const allNet = new Map(); for (const i of S.invoices) addTo(allNet, i.cur, cents(i.net));
  const viaCustomers = new Map(); for (const c of S.customers) for (const [k, v] of c.st.total) addTo(viaCustomers, k, v);
  const viaManagers = new Map(); for (const mg of S.managers.values()) for (const [k, v] of mg.total) addTo(viaManagers, k, v);
  add(t("chk.customersSum"), same(allNet, viaCustomers), t("chk.same"));
  add(t("chk.managersSum"), same(allNet, viaManagers) && [...S.managers.values()].reduce((s, mg) => s + mg.count, 0) === S.customers.length, t("chk.same"));
  // offers: the importer's count, and every offer assigned to exactly one Ügyintéző
  if (ref.offers != null) {
    const viaManagers = [...S.managers.values()].reduce((s, mg) => s + mg.offers.length, 0);
    add(t("chk.offers"), ref.offers === S.offers.filter((o) => o.date).length && viaManagers === S.offers.length,
      t("chk.offersDetail", { n: F.num(S.offers.length), m: F.num(viaManagers) }));
  }
  // 3) every invoice lands in exactly one period, at every breakdown
  let periodsOk = true;
  for (const g of ["week", "month", "quarter", "half", "year"]) {
    const sums = new Map();
    for (const i of S.invoices) if (i.date) addTo(sums, `${i.cur}|${periodStart(periodKey(i.date, g), g) <= i.date && i.date < nextPeriodStart(periodKey(i.date, g), g)}`, cents(i.net));
    const bad = [...sums.keys()].some((k) => k.endsWith("false"));
    const byCur = new Map(); for (const [k, v] of sums) addTo(byCur, k.split("|")[0], v);
    if (bad || !same(byCur, net)) periodsOk = false;
  }
  add(t("chk.periods"), periodsOk, t("chk.periodsDetail"));
  return checks;
}

/* Import health: warning count, failed checks, and whether the export is overdue. */
function importStatus() {
  const m = S.meta;
  if (!m) return { count: 0, stale: false, hours: 0, failed: 0 };
  const exported = new Date(m.exported_at || m.generated_at);
  const hours = (Date.now() - exported) / 3600000;
  const allowed = CONFIG.staleHours + (CONFIG.exportsOnWeekends ? 0 : 24 * weekendDaysBetween(exported, new Date()));
  if (!S.checks) S.checks = computeChecks();
  const failed = S.checks.filter((c) => !c.ok).length;
  return { count: m.warning_count || 0, stale: (!m.fake && hours > allowed) || failed > 0, hours, failed };
}

function agoText(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return t("ago.now");
  if (mins < 60) return t("ago.min", { n: mins });
  if (mins < 1440) return t("ago.hour", { n: Math.round(mins / 60) });
  return t("ago.day", { n: Math.round(mins / 1440) });
}

function renderFreshness() {
  const m = S.meta;
  if (!m) return;
  const exported = new Date(m.exported_at || m.generated_at);
  $("#freshness").textContent = t("freshness", { date: F.dateTime(exported), ago: agoText(Date.now() - exported) });
  $("#freshness").title = t("freshness.source", { imported: F.dateTime(new Date(m.generated_at)) });
  $("#fake-tag").hidden = !m.fake;
  $("#fake-tag").textContent = t("fake");
}

function weekendDaysBetween(from, to) {
  let n = 0;
  const d = new Date(from); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1);
  for (; d < to; d.setDate(d.getDate() + 1)) if (d.getDay() === 0 || d.getDay() === 6) n++;
  return n;
}

/* Only the sample-data notice is shown on top. Warnings and stale data live in
   the status tab (the "!" icon at the right end of the tab bar). */
function renderBanner() {
  const m = S.meta;
  if (!m) return;
  if (m.fake) showBanner(t("fakeNotice"));
  else $("#banner").hidden = true;
}

function showBanner(text, bad = false) {
  const b = $("#banner");
  b.textContent = text;
  b.classList.toggle("bad", bad);
  b.hidden = false;
}

/* ---------- reusable bits ---------- */

const custLink = (c, text = c.name || c.id, cls = "") => `<a href="${customerHref(c.id)}"${cls ? ` class="${cls}"` : ""}>${esc(text)}</a>`;
const managerHref = (key) => `#manager?id=${encodeURIComponent(key)}`;
const pmLink = (key) => `<a href="${managerHref(key)}"${key === NONE ? ' class="muted"' : ""}>${esc(pmName(key))}</a>`;
const newBadge = (c) => (c.isNew ? `<span class="badge new">${esc(F.date(c.created))}</span>` : esc(F.date(c.created)));
/* Name with its SAP code on hover; an unknown code is shown as itself, marked. */
const codeLabel = (name, code) => (name
  ? `<span title="${esc(t("code", { code }))}">${esc(name)}</span>`
  : code ? `<span class="unknown-code" title="${esc(t("code.unknown"))}">${esc(code)}</span>` : "");
const days = (n) => (n == null ? "" : t("cust.days", { n }));

/* Filter controls; each writes its value to the URL parameter named in data-param. */
const fSearch = (param, phKey) =>
  `<input type="search" data-param="${param}" placeholder="${esc(t(phKey))}" value="${esc(current.params.get(param) || "")}" autocomplete="off">`;
const fSelect = (param, allKey, options) => {
  const v = current.params.get(param) || "";
  return `<select data-param="${param}"><option value="">${esc(t(allKey))}</option>${options.map(([val, label]) =>
    `<option value="${esc(val)}"${val === v ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
};
const fDate = (param, labelKey) =>
  `<label class="date-label">${esc(t(labelKey))} <input type="date" data-param="${param}" value="${esc(current.params.get(param) || "")}"></label>`;

/* A filter card + results area. `draw(host)` renders the results. */
function filteredView(main, filtersHtml, draw, exportFn, { outside = false } = {}) {
  main.innerHTML = `<section class="card"><div class="filters">${filtersHtml}
      <span class="spacer"></span>
      <button type="button" class="secondary" data-act="reset">${esc(t("f.reset"))}</button>
      <button type="button" data-act="export">${esc(t("f.export"))}</button>
    </div>${outside ? "" : '<div class="results"></div>'}</section>${outside ? '<div class="results" style="display:contents"></div>' : ""}`;
  const card = main.firstElementChild;
  const host = $(".results", main);
  viewUpdate = () => draw(host);
  let timer;
  card.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.dataset.param) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      // e.g. choosing a range preset clears the custom from/to dates
      for (const other of (el.dataset.clears || "").split(",").filter(Boolean)) {
        setParams({ [other]: "" });
        const input = card.querySelector(`[data-param="${other}"]`);
        if (input) input.value = "";
      }
      setParams({ [el.dataset.param]: el.value.trim() });
      tablePage[current.view] = 0;
      viewUpdate();
    }, el.type === "search" ? 200 : 0);
  });
  card.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "reset") {
      card.querySelectorAll("[data-param]").forEach((el) => setParams({ [el.dataset.param]: "" }));
      tablePage[current.view] = 0;
      route(); // re-render, so every control shows its default again
    } else if (act === "export") exportFn();
  });
  viewUpdate();
}

/* ---------- column layout (per table, saved in this browser) ---------- */
/* {order: [keys], widths: {key: px}}. Widths are only stored once a column has
   been resized; until then the browser sizes the columns automatically. */
const MIN_COL = 60, NEW_COL = 140;
function loadLayout(id) {
  try { return JSON.parse(localStorage.getItem(`cols:${id}`)) || {}; } catch { return {}; }
}
function saveLayout(id, layout) {
  try {
    if (!layout.order?.length && !Object.keys(layout.widths || {}).length) localStorage.removeItem(`cols:${id}`);
    else localStorage.setItem(`cols:${id}`, JSON.stringify(layout));
  } catch { /* storage blocked: the layout just isn't remembered */ }
}
/* Columns in the saved order; columns the saved order doesn't know (e.g. the
   invoice columns once that export arrives) keep their place at the end. */
function layoutColumns(id, columns) {
  const order = loadLayout(id).order || [];
  const pos = (c) => { const i = order.indexOf(c.key); return i === -1 ? order.length + columns.indexOf(c) : i; };
  return [...columns].sort((a, b) => pos(a) - pos(b));
}

/* Sortable, paged table. Columns: {key, label, value(r), html?(r), num?, wrap?, csv?(r)}
   Click a header to sort, drag a header to move the column, drag its right edge
   to resize (double-click the edge: automatic widths again). */
let dragKey = null, suppressSortClick = false;
function drawTable(host, opts) {
  const { rows, defaultSort, total = rows.length, totals = "", id = current.view, pageSize = CONFIG.pageSize, sortParam = "sort" } = opts;
  const layout = loadLayout(id);
  const columns = layoutColumns(id, opts.columns);
  const widths = layout.widths || {};
  const fixed = Object.keys(widths).length > 0;
  const sp = current.params.get(sortParam) || defaultSort;
  const desc = sp.startsWith("-");
  const col = columns.find((c) => c.key === sp.replace(/^-/, "")) || columns[0];
  const sorted = [...rows].sort((a, b) => {
    const x = col.value(a), y = col.value(b);
    if (x == null || x === "") return y == null || y === "" ? 0 : 1; // empty values last
    if (y == null || y === "") return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), F.loc, { numeric: true });
    return desc ? -c : c;
  });
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(tablePage[id] || 0, pages - 1);
  const slice = sorted.slice(page * pageSize, (page + 1) * pageSize);
  const custom = fixed || (layout.order || []).length > 0;
  const widthOf = (c) => widths[c.key] || NEW_COL;

  host.innerHTML = `
    <div class="table-meta"><span>${esc(t("t.count", { shown: F.num(rows.length), total: F.num(total) }))}${custom
      ? ` · <button type="button" class="link-btn" data-layout-reset>${esc(t("t.layoutReset"))}</button>` : ""}</span><span class="totals">${totals}</span></div>
    <div class="table-wrap"><table${fixed ? ` class="fixed" style="width:${columns.reduce((s, c) => s + widthOf(c), 0)}px"` : ""}>
      ${fixed ? `<colgroup>${columns.map((c) => `<col data-key="${c.key}" style="width:${widthOf(c)}px">`).join("")}</colgroup>` : ""}
      <thead><tr>${columns.map((c) => `<th class="sortable${c.num ? " num" : ""}" data-key="${c.key}" draggable="true" title="${esc(t("t.colHint"))}"
        aria-sort="${c === col ? (desc ? "descending" : "ascending") : "none"}">${esc(c.label)}<span class="col-resize" data-key="${c.key}" aria-hidden="true"></span></th>`).join("")}</tr></thead>
      <tbody>${slice.length ? slice.map((r) => `<tr>${columns.map((c) =>
        `<td class="${c.num ? "num" : ""}${c.wrap ? " wrap" : ""}">${c.html ? c.html(r) : esc(c.value(r))}</td>`).join("")}</tr>`).join("")
        : `<tr class="empty-row"><td colspan="${columns.length}">${esc(t("t.empty"))}</td></tr>`}</tbody>
    </table></div>
    ${pages > 1 ? `<div class="pager"><button type="button" class="secondary" data-page="-1"${page === 0 ? " disabled" : ""}>${esc(t("t.prev"))}</button>
      <span>${esc(t("t.page", { p: page + 1, n: pages }))}</span>
      <button type="button" class="secondary" data-page="1"${page >= pages - 1 ? " disabled" : ""}>${esc(t("t.next"))}</button></div>` : ""}`;

  const redraw = () => drawTable(host, opts);

  host.onclick = (e) => {
    if (e.target.closest("[data-layout-reset]")) { saveLayout(id, {}); redraw(); return; }
    if (e.target.closest(".col-resize") || suppressSortClick) return;
    const th = e.target.closest("th[data-key]");
    if (th) {
      const k = th.dataset.key;
      setParams({ [sortParam]: sp.replace(/^-/, "") === k && !desc ? "-" + k : k });
      tablePage[id] = 0;
      redraw();
      return;
    }
    const pg = e.target.closest("[data-page]");
    if (pg) {
      tablePage[id] = page + +pg.dataset.page;
      redraw();
      host.scrollIntoView({ block: "nearest" });
    }
  };

  /* Resize: drag the right edge of a header. The first resize freezes every
     column at its current width, then the dragged one follows the pointer. */
  host.ondblclick = (e) => {
    if (!e.target.closest(".col-resize")) return;
    saveLayout(id, { ...loadLayout(id), widths: {} });
    redraw();
  };
  host.onpointerdown = (e) => {
    const handle = e.target.closest(".col-resize");
    if (!handle || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const table = $("table", host), ths = [...table.querySelectorAll("thead th")];
    const w = {};
    for (const th of ths) w[th.dataset.key] = widths[th.dataset.key] || Math.ceil(th.getBoundingClientRect().width) + 1; // +1: no clipped headers
    let cg = $("colgroup", table);
    if (!cg) {
      cg = document.createElement("colgroup");
      cg.innerHTML = ths.map((th) => `<col data-key="${th.dataset.key}">`).join("");
      table.prepend(cg);
    }
    const apply = () => {
      for (const c of cg.children) c.style.width = `${w[c.dataset.key]}px`;
      table.classList.add("fixed");
      table.style.width = `${Object.values(w).reduce((a, b) => a + b, 0)}px`;
    };
    apply();
    const key = handle.dataset.key, startX = e.clientX, startW = w[key];
    ths.forEach((th) => { th.draggable = false; });
    document.body.classList.add("resizing");
    const move = (ev) => { w[key] = Math.max(MIN_COL, Math.round(startW + ev.clientX - startX)); apply(); };
    const up = () => {
      window.removeEventListener("pointermove", move);
      document.body.classList.remove("resizing");
      ths.forEach((th) => { th.draggable = true; });
      saveLayout(id, { ...loadLayout(id), widths: w });
      // the pointer is released over a header: don't let that count as a sort click
      suppressSortClick = true;
      setTimeout(() => { suppressSortClick = false; redraw(); }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  /* Reorder: drag a header onto another; it lands before or after it,
     depending on which half of the target the pointer is over. */
  const clearMarks = () => host.querySelectorAll("th.drop-before, th.drop-after, th.dragging")
    .forEach((th) => th.classList.remove("drop-before", "drop-after", "dragging"));
  const side = (th, e) => (e.clientX > th.getBoundingClientRect().left + th.getBoundingClientRect().width / 2 ? "after" : "before");
  host.ondragstart = (e) => {
    const th = e.target.closest("th[data-key]");
    if (!th) return;
    dragKey = th.dataset.key;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragKey);
    th.classList.add("dragging");
  };
  host.ondragover = (e) => {
    const th = e.target.closest("th[data-key]");
    if (!th || !dragKey) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    host.querySelectorAll("th.drop-before, th.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    if (th.dataset.key !== dragKey) th.classList.add(`drop-${side(th, e)}`);
  };
  host.ondrop = (e) => {
    const th = e.target.closest("th[data-key]");
    if (!th || !dragKey) return;
    e.preventDefault();
    const keys = columns.map((c) => c.key).filter((k) => k !== dragKey);
    const at = keys.indexOf(th.dataset.key);
    if (at !== -1) {
      keys.splice(at + (side(th, e) === "after" ? 1 : 0), 0, dragKey);
      saveLayout(id, { ...loadLayout(id), order: keys });
    }
    dragKey = null;
    redraw();
  };
  host.ondragend = () => { dragKey = null; clearMarks(); };
  return sorted;
}

/* CSV that opens correctly in the user's Excel: ";" and decimal comma for Hungarian. */
function exportCsv(name, columns, rows) {
  const sep = F.decimalComma ? ";" : ",";
  const cell = (v) => {
    if (v == null) return "";
    if (typeof v === "number") return F.decimalComma ? String(v).replace(".", ",") : String(v);
    v = String(v);
    return /[";,\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = [columns.map((c) => cell(c.label)).join(sep)];
  for (const r of rows) lines.push(columns.map((c) => cell(c.csv ? c.csv(r) : c.value(r))).join(sep));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}_${TODAY}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* Horizontal bars. items: [{label (html), value, tip}]; fmt formats the value column. */
function hbars(items, fmt = (v) => F.num(v)) {
  const max = Math.max(...items.map((i) => i.value), 1);
  if (!items.length) return `<div class="empty-state">${esc(t("t.empty"))}</div>`;
  return `<div class="hbars">${items.map((i) => `
    <span class="name">${i.label}</span>
    <span class="track" data-tip="${esc(i.tip)}"><span class="fill" style="width:${(Math.max(0, i.value) / max) * 100}%"></span></span>
    <span class="val">${esc(fmt(i.value))}</span>`).join("")}</div>`;
}
const compactMoney = (v, cur) => { const p = F.compactParts(v, cur); return `${p.num} ${p.unit}`.trim(); };

function countBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r) || ""; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p);
}

/* Top-rounded bar anchored to the baseline */
const barPath = (x, w, top, base, cls) => {
  const h = base - top, r = Math.min(4, w / 2, h);
  return h > 0 ? `<path class="${cls}" d="M${x},${base}V${top + r}q0,-${r} ${r},-${r}h${w - 2 * r}q${r},0 ${r},${r}V${base}Z"/>` : "";
};

/* ---------- overview ---------- */

function renderOverview(main) {
  const all = S.customers;
  const between = (c, from, to) => c.created && c.created >= from && c.created <= to;
  const new30 = all.filter((c) => between(c, PERIOD.new, TODAY)).length;
  const prev30 = all.filter((c) => between(c, PERIOD.prevNew, daysAgo(CONFIG.newDays))).length;
  const newYtd = all.filter((c) => between(c, P.from, P.to)).length;
  const prevYtd = all.filter((c) => !!P.prevFrom && between(c, P.prevFrom, P.prevTo)).length;
  const foreign = all.filter((c) => c.country && c.country !== CONFIG.homeCountry);
  const pmCount = [...S.managers.keys()].filter((k) => k !== NONE).length;

  const tile = (href, label, value, sub, hl = false) =>
    `<a class="kpi${hl ? " hl" : ""}" href="${href}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></a>`;
  const deltaHtml = (now, prev, key = "cust.vsPrev") => (prev
    ? `<span class="${now >= prev ? "delta-up" : "delta-down"}">${esc(t(key, { pct: F.signedPct((now - prev) / Math.abs(prev)) }))}</span>` : "");
  const big = (v) => { const p = F.compactParts(v, "HUF"); return `${esc(p.num)}<span class="unit">${esc(p.unit)}</span>`; };
  const pmItems = [...S.managers.values()].filter((m) => m.key !== NONE).sort((a, b) => b.count - a.count).map((m) => ({
    label: pmLink(m.key), value: m.count,
    tip: `${pmName(m.key)}\n${t("chart.customersN", { n: F.num(m.count) })}\n${t("kpi.newYtd", { p: P.short })}: ${m.newYtd}`,
  }));
  const latest = [...all].filter((c) => c.created).sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id)).slice(0, 8);
  const latestCard = `<section class="card">
      <div class="card-head"><h2>${esc(t("chart.latest"))}</h2><a class="sub" href="#customers?from=${PERIOD.new}">${esc(t("ov.allNew"))}</a></div>
      <div class="table-wrap plain"><table><thead><tr><th>${esc(t("col.name"))}</th><th>${esc(t("col.manager"))}</th><th>${esc(t("col.created"))}</th></tr></thead>
      <tbody>${latest.map((c) => `<tr><td class="wrap">${custLink(c)}</td><td>${pmLink(pmKey(c))}</td><td>${newBadge(c)}</td></tr>`).join("")}</tbody></table></div>
    </section>`;
  const newChartCard = `<section class="card chart">
      <div class="card-head"><h2>${esc(t("chart.newMonthly"))}</h2><span class="sub">${esc(t("chart.newMonthlySub"))}</span></div>
      <div id="monthly"></div>
    </section>`;
  const customerTiles = `
      ${tile(`#customers?from=${PERIOD.new}`, t("kpi.new30", { n: CONFIG.newDays }), esc(F.num(new30)), esc(t("kpi.vsPrev30", { n: F.num(prev30), d: CONFIG.newDays })))}`;

  if (!S.hasInvoices) {
    // Customer data only: the customer dashboard
    const groupItems = (key, param, label) => countBy(all, (c) => c[key]).slice(0, CONFIG.topN).map(([k, n]) => ({
      label: k ? `<a href="#customers?${param}=${encodeURIComponent(k)}">${esc(label(k))}</a>` : `<span class="muted">${esc(t("none"))}</span>`,
      value: n, tip: `${k ? label(k) : t("none")}\n${t("chart.customersN", { n: F.num(n) })}`,
    }));
    main.innerHTML = `
      <section class="kpis">
        ${tile("#customers", t("kpi.customers"), esc(F.num(all.length)), esc(t("kpi.customersSub", { n: pmCount })), true)}
        ${customerTiles}
        ${tile(`#customers?from=${P.from}&to=${P.to}`, t("kpi.newYtd"), esc(F.num(newYtd)), esc(t("kpi.vsPrevYtd", { n: F.num(prevYtd) })))}
        ${tile("#customers?sort=country", t("kpi.foreign"), esc(F.num(foreign.length)), esc(t("kpi.foreignSub", { n: new Set(foreign.map((c) => c.country)).size })))}
      </section>
      ${newChartCard}
      <div class="grid-2">
        <section class="card"><div class="card-head"><h2>${esc(t("chart.byManager"))}</h2></div>${hbars(pmItems)}</section>
        ${latestCard}
      </div>
      <div class="grid-3">
        <section class="card"><div class="card-head"><h2>${esc(t("chart.byIndustry"))}</h2></div>${hbars(groupItems("industryLabel", "industry", (k) => k))}</section>
        <section class="card"><div class="card-head"><h2>${esc(t("chart.byRegion"))}</h2></div>${hbars(groupItems("regionLabel", "region", (k) => k))}</section>
        <section class="card"><div class="card-head"><h2>${esc(t("chart.byCountry"))}</h2></div>${hbars(groupItems("country", "country", (k) => `${F.country(k)} (${k})`))}</section>
      </div>`;
    drawMonthly($("#monthly"), all);
    return;
  }

  // ---- With invoices: the sales dashboard (net, HUF invoices; other currencies on the Sales tab) ----
  const lmStart = isoDate(new Date(YEAR, NOW.getMonth() - 1, 1));
  const lmKey = periodKey(lmStart, "month"), lmPrevKey = shiftKeyYear(lmKey, -1);
  // sales chart over the viewed period, breakdown by its length, vs the comparison period
  const g = autoGran(P.from, P.to);
  const keys = periodKeys(P.from, P.to, g);
  const per = new Map(keys.map((k) => [k, { v: 0, prev: 0 }]));
  let ytd = 0, prevYtdSales = 0, lm = 0, lmPrev = 0;
  const active = new Set(), activePrev = new Set();
  const byIndustry = new Map(), byRegion = new Map(), byCurrency = new Map(), curCount = new Map();
  for (const i of S.invoices) {
    if (!i.date) continue;
    if (inCur(i.date)) {
      active.add(i.c);
      addTo(byCurrency, i.cur, val(i));
      if (!i.credit) curCount.set(i.cur, (curCount.get(i.cur) || 0) + 1);
    } else if (inPrev(i.date)) activePrev.add(i.c);
    if (i.cur !== "HUF") continue;
    const v = val(i), k = periodKey(i.date, g), km = periodKey(i.date, "month");
    if (inCur(i.date)) {
      ytd += v;
      addTo(byIndustry, i.c.industryLabel || "", v);
      addTo(byRegion, i.c.regionLabel || "", v);
    } else if (inPrev(i.date)) prevYtdSales += v;
    if (km === lmKey) lm += v;
    if (km === lmPrevKey) lmPrev += v;
    if (inCur(i.date) && per.has(k)) per.get(k).v += v;
    if (inPrev(i.date)) { const row = per.get(shiftKeyYear(k, P.shift)); if (row) row.prev += v; }
  }
  const money = (v) => compactMoney(v, "HUF");
  const salesItems = (map, param, label) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, CONFIG.topN).map(([k, v]) => ({
    label: k ? `<a href="#sales?${param}=${encodeURIComponent(k)}">${esc(label(k))}</a>` : `<span class="muted">${esc(t("none"))}</span>`,
    value: v / 100, tip: `${k ? label(k) : t("none")}\n${F.money(v / 100, "HUF")}\n${F.pct(ytd ? v / ytd : 0)}`,
  }));
  const topCustomers = all.map((c) => [c, c.st.ytd.get("HUF") || 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, CONFIG.topN)
    .map(([c, v]) => ({ label: custLink(c), value: v / 100, tip: `${c.name}\n${F.money(v / 100, "HUF")}\n${F.pct(ytd ? v / ytd : 0)}` }));
  const managerSales = [...S.managers.values()].filter((m) => m.key !== NONE).map((m) => [m, m.ytd.get("HUF") || 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([m, v]) => ({ label: pmLink(m.key), value: v / 100, tip: `${pmName(m.key)}\n${F.money(v / 100, "HUF")}\n${F.pct(ytd ? v / ytd : 0)}` }));
  const lmLabel = F.monthYear(lmKey);
  const offersYtd = S.offers.filter((o) => inCur(o.date)).length;
  const offersPrev = S.offers.filter((o) => inPrev(o.date)).length;
  const offerTop = [...S.managers.values()].filter((m) => m.offersYtd).sort((a, b) => b.offersYtd - a.offersYtd)
    .map((m) => ({ label: pmLink(m.key), value: m.offersYtd, tip: `${pmName(m.key)}\n${t("off.count", { n: F.num(m.offersYtd) })}\n${t("off.customersN", { n: F.num(m.offerCustomers.size) })}` }));

  main.innerHTML = `
    <section class="kpis">
      ${tile("#sales", t("kpi.salesYtd", { p: P.short }), big(ytd / 100), deltaHtml(ytd, prevYtdSales), true)}
      ${tile(`#sales?from=${lmStart}&to=${addDays(periodStart(periodKey(TODAY, "month"), "month"), -1)}&g=day`, t("ov.lastMonth", { month: lmLabel }), big(lm / 100), deltaHtml(lm, lmPrev, "ov.vsPrevMonth"))}
      ${tile("#sales?by=customer", t("ov.active", { p: P.short }), esc(F.num(active.size)), esc(t("ov.activeSub", { n: F.num(activePrev.size) })))}
      ${S.hasOffers ? tile("#managers?sort=-offers", t("off.kpi", { p: P.short }), esc(F.num(offersYtd)), esc(t("off.kpiSub", { n: F.num(offersPrev) }))) : ""}
      ${customerTiles}
    </section>
    <section class="card chart">
      <div class="card-head"><h2>${esc(t("ov.monthly", { p: P.short, g: t("gran." + g).toLowerCase() }))}</h2><a class="sub" href="#sales">${esc(t("ov.details"))}</a></div>
      <div class="legend"><span><i style="background:var(--bar)"></i>${esc(`${P.short} (${F.date(P.from)} – ${F.date(P.to)})`)}</span>${P.prevFrom ? `<span><i style="background:var(--bar-muted)"></i>${esc(`${t("sales.prevYear")} (${F.date(P.prevFrom)} – ${F.date(P.prevTo)})`)}</span>` : ""}</div>
      <div id="ov-monthly"></div>
      <div class="card-foot">${esc(t("ov.hufNote"))}</div>
    </section>
    <div class="${S.hasOffers ? "grid-3" : "grid-2"}">
      <section class="card"><div class="card-head"><h2>${esc(t("ov.topCustomers", { p: P.short }))}</h2><a class="sub" href="#sales?by=customer">${esc(t("ov.all"))}</a></div>${hbars(topCustomers, money)}</section>
      <section class="card"><div class="card-head"><h2>${esc(t("ov.byManager", { p: P.short }))}</h2><a class="sub" href="#sales?by=manager">${esc(t("ov.all"))}</a></div>${hbars(managerSales, money)}</section>
      ${S.hasOffers ? `<section class="card"><div class="card-head"><h2>${esc(t("off.byManager", { p: P.short }))}</h2><a class="sub" href="#managers?sort=-offers">${esc(t("ov.all"))}</a></div>
        ${hbars(offerTop, (v) => t("off.pcs", { n: F.num(v) }))}<div class="card-foot">${esc(t("off.note"))}</div></section>` : ""}
    </div>
    <div class="grid-3">
      <section class="card"><div class="card-head"><h2>${esc(t("ov.byIndustry", { p: P.short }))}</h2></div>${hbars(salesItems(byIndustry, "industry", (k) => k), money)}</section>
      <section class="card"><div class="card-head"><h2>${esc(t("ov.byRegion", { p: P.short }))}</h2></div>${hbars(salesItems(byRegion, "region", (k) => k), money)}</section>
      <section class="card"><div class="card-head"><h2>${esc(t("ov.byCurrency", { p: P.short }))}</h2></div>
        <dl class="rows">${currencyOrder().filter((c) => byCurrency.has(c)).map((c) => `<div><dt><a href="#sales?cur=${encodeURIComponent(c)}"><b>${esc(c)}</b></a>
          <span class="muted"> · ${esc(t("ov.invoicesN", { n: F.num(curCount.get(c) || 0) }))}</span></dt><dd>${esc(F.money(byCurrency.get(c) / 100, c))}</dd></div>`).join("")}</dl>
        <div class="card-foot">${esc(t("ov.curNote"))}</div></section>
    </div>
    <div class="grid-2">
      ${newChartCard}
      ${latestCard}
    </div>`;
  drawPeriodChart($("#ov-monthly"), { keys, g, values: keys.map((k) => per.get(k).v / 100), prev: P.prevFrom ? keys.map((k) => per.get(k).prev / 100) : null,
    cur: "HUF", mode: "compare", label: t("ov.monthly"), shift: P.shift, href: (k) => bucketHref(k, g, { cur: "HUF" }, P) });
  drawMonthly($("#monthly"), all);
}

/* New customers per month, last 24 months. Single series, SVG sized to its container. */
function drawMonthly(host, rows) {
  const months = [];
  for (let k = 23; k >= 0; k--) {
    const d = new Date(YEAR, NOW.getMonth() - k, 1);
    months.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  }
  const counts = new Map(months.map((m) => [m, 0]));
  for (const c of rows) { const k = c.created?.slice(0, 7); if (counts.has(k)) counts.set(k, counts.get(k) + 1); }
  const vals = months.map((m) => counts.get(m));
  const W = Math.max(320, host.clientWidth), H = 220;
  const m = { l: 40, r: 8, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b, base = m.t + ph;
  const rawMax = Math.max(...vals, 1);
  const step = niceStep(rawMax / 4);
  const max = Math.ceil(rawMax / step) * step;
  const y = (v) => m.t + ph - (v / max) * ph;
  const bw = pw / months.length;
  const barW = Math.min(24, bw * 0.6);
  let svg = "";
  for (let v = 0; v <= max; v += step) {
    svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="axis-label" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(F.num(v))}</text>`;
  }
  const labelEvery = W < 700 ? 3 : 1;
  months.forEach((mo, k) => {
    const cx = m.l + bw * k + bw / 2;
    svg += barPath(cx - barW / 2, barW, y(vals[k]), base, "bar-out");
    if (k % labelEvery === 0) svg += `<text class="axis-label" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(F.month(mo))}</text>`;
    const link = `#customers?from=${mo}-01&to=${addDays(nextPeriodStart(mo, "month"), -1)}`;
    svg += `<rect class="band link" x="${m.l + bw * k}" y="${m.t}" width="${bw}" height="${ph}" data-href="${esc(link)}"
      data-tip="${esc(`${F.monthYear(mo)}\n${t("chart.newN", { n: vals[k] })}\n${t("chart.clickNew")}`)}"/>`;
  });
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("chart.newMonthly"))}">${svg}</svg>`;
}

/* ---------- account managers ---------- */

const hufOf = (map) => (map.get("HUF") || 0) / 100;
const changeHtml = (a, b) => (b ? `<span class="${a >= b ? "delta-up" : "delta-down"}">${esc(F.signedPct((a - b) / Math.abs(b)))}</span>` : "–");
// Sales figures here are HUF (net); other currencies are listed separately, never added in.
function managerColumns() {
  const totalCustomers = S.customers.length || 1;
  const totalHuf = [...S.managers.values()].reduce((s, m) => s + (m.ytd.get("HUF") || 0), 0);
  const cols = [
    { key: "name", label: t("col.manager"), value: (m) => pmName(m.key), html: (m) => pmLink(m.key), wrap: true },
    { key: "count", label: t("col.customers"), num: true, value: (m) => m.count,
      html: (m) => `<a href="#customers?pm=${encodeURIComponent(m.key)}">${esc(F.num(m.count))}</a>` },
  ];
  if (S.hasInvoices) {
    cols.push(
      { key: "active", label: t("mgr.col.active", { p: P.short }), num: true, value: (m) => m.active },
      // HUF and EUR side by side, same format; never added together
      ...["HUF", "EUR"].map((cur) => ({ key: cur === "HUF" ? "ytd" : "ytdEUR", label: t("mgr.col.ytd", { p: P.short, cur }), num: true,
        value: (m) => (m.ytd.get(cur) || 0) / 100, html: (m) => esc(F.money((m.ytd.get(cur) || 0) / 100, cur)) })),
      { key: "prev", label: t("mgr.col.prev"), num: true, value: (m) => hufOf(m.prev), html: (m) => `<span class="muted">${esc(F.money(hufOf(m.prev), "HUF"))}</span>` },
      { key: "salesShare", label: t("mgr.col.share"), num: true, value: (m) => (totalHuf ? (m.ytd.get("HUF") || 0) / totalHuf : 0),
        html: (m) => esc(F.pct(totalHuf ? (m.ytd.get("HUF") || 0) / totalHuf : 0)) },
      ...(S.hasOffers ? [{ key: "offers", label: t("off.col", { p: P.short }), num: true, value: (m) => m.offersYtd,
        html: (m) => (m.offersYtd ? `<a href="${managerHref(m.key)}" title="${esc(t("off.customersN", { n: F.num(m.offerCustomers.size) }))}">${esc(F.num(m.offersYtd))}</a>` : "0") }] : []),
    );
    if (S.hasPayments) cols.push({ key: "open", label: t("col.openNet"), num: true, value: (m) => hufOf(m.open), html: (m) => esc(moneyList(m.open)), csv: (m) => moneyList(m.open) });
  } else {
    cols.push({ key: "share", label: t("col.share"), num: true, value: (m) => m.count / totalCustomers, html: (m) => esc(F.pct(m.count / totalCustomers)) });
  }
  cols.push(
    { key: "foreign", label: t("col.foreign"), num: true, value: (m) => m.foreign },
    { key: "last", label: t("col.lastCreated"), value: (m) => m.last, html: (m) => esc(F.date(m.last)) },
  );
  return cols;
}
const MANAGER_TABLE = "managers-v3";   // new column set: old saved layouts don't apply

function renderManagers(main) {
  const p = current.params;
  const managers = [...S.managers.values()];
  const named = managers.filter((m) => m.key !== NONE);
  const none = S.managers.get(NONE);
  let rows = [];
  filteredView(main, fSearch("q", "f.searchManagers"), (host) => {
    const q = (p.get("q") || "").toLowerCase();
    rows = managers.filter((m) => !q || m._s.includes(q));
    rows = drawTable(host, { id: MANAGER_TABLE, columns: managerColumns(), rows, defaultSort: S.hasInvoices ? "-ytd" : "-count", total: managers.length,
      totals: S.hasInvoices ? esc(t("mgr.hufNote")) : "" });
  }, () => exportCsv("ugyintezok", layoutColumns(MANAGER_TABLE, managerColumns()), rows));

  // Summary above the table
  const tile = (label, value, sub, hl = false) => `<div class="kpi${hl ? " hl" : ""}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const big = (v) => { const x = F.compactParts(v, "HUF"); return `${esc(x.num)}<span class="unit">${esc(x.unit)}</span>`; };
  const totalYtd = managers.reduce((s, m) => s + hufOf(m.ytd), 0), totalPrev = managers.reduce((s, m) => s + hufOf(m.prev), 0);
  // A few summary figures above the table (the table is the main content)
  main.insertAdjacentHTML("afterbegin", `
    <section class="kpis kpis-compact">
      ${tile(t("mgr.kpi.count"), esc(F.num(named.length)), esc(t("mgr.kpi.countSub", { n: F.num(S.customers.length) })))}
      ${S.hasInvoices ? tile(t("kpi.salesYtd", { p: P.short }), big(totalYtd), changeHtml(totalYtd, totalPrev) + " " + esc(t("mgr.kpi.vsPrev")), true) : ""}
      ${S.hasOffers ? tile(t("off.kpi", { p: P.short }), esc(F.num(managers.reduce((s, m) => s + m.offersYtd, 0))), esc(t("off.kpiSub", { n: F.num(managers.reduce((s, m) => s + m.offersPrev, 0)) }))) : ""}
      ${tile(t("kpi.noManager"), esc(F.num(none?.count || 0)), S.hasInvoices && none ? esc(t("mgr.kpi.noneSales", { amount: compactMoney(hufOf(none.ytd), "HUF") })) : esc(t("kpi.noManagerSub")))}
    </section>`);
}

/* Offers of an Ügyintéző in the viewed period: how many, and to whom. The amount is shown
   quietly; offers never count as sales. */
function offersCard(m) {
  const list = m.offers.filter((o) => inCur(o.date));
  const shown = list.slice(0, 50);
  return `<section class="card" id="offers">
    <div class="card-head"><h2>${esc(t("off.title", { p: P.short }))}</h2>
      <span class="sub">${esc(t("off.summary", { n: F.num(list.length), c: F.num(m.offerCustomers.size), prev: F.num(m.offersPrev) }))}</span></div>
    ${list.length ? `<div class="table-wrap plain" style="max-height:360px;overflow:auto"><table>
      <thead><tr><th>${esc(t("col.invDate"))}</th><th>${esc(t("off.number"))}</th><th>${esc(t("off.customer"))}</th><th class="num">${esc(t("off.amount"))}</th></tr></thead>
      <tbody>${shown.map((o) => `<tr><td>${esc(F.date(o.date))}</td><td class="mono">${esc(o.id)}</td><td class="wrap">${custLink(o.c)}</td>
        <td class="num muted">${amtOf(o) ? esc(F.money(amtOf(o), o.cur)) : "–"}</td></tr>`).join("")}</tbody></table></div>
      ${list.length > shown.length ? `<div class="card-foot">+${esc(F.num(list.length - shown.length))}</div>` : ""}`
      : `<div class="empty-state">${esc(t("off.none"))}</div>`}
    <div class="card-foot">${esc(t("off.note"))}</div>
  </section>`;
}

/* ---------- account manager page ---------- */

function renderManager(main) {
  const key = current.params.get("id");
  const m = S.managers.get(key);
  if (!m) {
    main.innerHTML = `<div class="notice bad">${esc(t("mgr.notFound", { name: key }))}</div><a class="back" href="#managers">${esc(t("mgr.back"))}</a>`;
    return;
  }
  const name = pmName(key);
  document.title = `${name} – ${t("app.title")}`;
  const tile = (label, value, sub, hl = false) => `<div class="kpi${hl ? " hl" : ""}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const big = (v) => { const x = F.compactParts(v, "HUF"); return `${esc(x.num)}<span class="unit">${esc(x.unit)}</span>`; };
  const deltaText = (a, b, k = "cust.vsPrev") => (b ? `<span class="${a >= b ? "delta-up" : "delta-down"}">${esc(t(k, { pct: F.signedPct((a - b) / Math.abs(b)) }))}</span>` : "");

  // last month (HUF), active customers, industries, top customer
  const lmKey = periodKey(isoDate(new Date(YEAR, NOW.getMonth() - 1, 1)), "month"), lmPrevKey = shiftKeyYear(lmKey, -1);
  let lm = 0, lmPrev = 0;
  const byIndustry = new Map();
  for (const i of m.invoices) {
    if (i.cur !== "HUF" || !i.date) continue;
    const k = periodKey(i.date, "month");
    if (k === lmKey) lm += val(i);
    if (k === lmPrevKey) lmPrev += val(i);
    if (inCur(i.date)) addTo(byIndustry, i.c.industryLabel || "", val(i));
  }
  const top = [...m.customers].sort((a, b) => (b.st.ytd.get("HUF") || 0) - (a.st.ytd.get("HUF") || 0))[0];
  const topIndustry = [...byIndustry.entries()].sort((a, b) => b[1] - a[1])[0];
  const latest = [...m.customers].filter((c) => c.created).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 6);
  const chip = (label, value, href) => `<a class="chip" href="${href}"><b>${esc(label)}</b>${esc(value)}</a>`;

  const kpis = S.hasInvoices ? [
    tile(t("kpi.salesYtd", { p: P.short }), big(hufOf(m.ytd)), deltaText(hufOf(m.ytd), hufOf(m.prev)), true),
    tile(t("ov.lastMonth", { month: F.monthYear(lmKey) }), big(lm / 100), deltaText(lm, lmPrev, "ov.vsPrevMonth")),
    tile(t("ov.active", { p: P.short }), esc(F.num(m.active)), esc(t("mgr.activeSub", { n: F.num(m.activePrev), all: F.num(m.count) }))),
    tile(t("kpi.newYtd"), esc(F.num(m.newYtd)), esc(t("mgr.new30", { n: F.num(m.new30) }))),
  ] : [
    tile(t("col.customers"), esc(F.num(m.count)), esc(t("kpi.foreignSub", { n: m.foreign })), true),
    tile(t("kpi.newYtd"), esc(F.num(m.newYtd)), esc(t("mgr.new30", { n: F.num(m.new30) }))),
  ];

  main.innerHTML = `
    <a class="back" href="#managers">${esc(t("mgr.back"))}</a>
    <section class="cust-head">
      <div class="avatar" aria-hidden="true">${esc(key === NONE ? "?" : initials(name))}</div>
      <div>
        <div class="eyebrow">${esc(t("mgr.label"))}</div>
        <h1>${esc(name)}</h1>
        <div class="chips">
          ${chip(t("col.customers"), F.num(m.count), `#customers?pm=${encodeURIComponent(key)}`)}
          ${S.hasInvoices ? chip(t("mgr.chipActive", { p: P.short }), F.num(m.active), `#sales?pm=${encodeURIComponent(key)}`) : ""}
          ${chip(t("col.foreign"), F.num(m.foreign), `#customers?pm=${encodeURIComponent(key)}&sort=country`)}
        </div>
      </div>
      <div class="cust-contact">
        ${S.hasInvoices ? `<div class="eyebrow">${esc(t("mgr.topCustomer", { p: P.short }))}</div><div>${top && top.st.ytd.get("HUF") ? `${custLink(top)} · ${esc(compactMoney(hufOf(top.st.ytd), "HUF"))}` : "–"}</div>
        <div class="eyebrow">${esc(t("mgr.topIndustry", { p: P.short }))}</div><div>${topIndustry ? `${esc(topIndustry[0] || t("none"))} · ${esc(compactMoney(topIndustry[1] / 100, "HUF"))}` : "–"}</div>` : ""}
      </div>
    </section>
    <section class="kpis">${kpis.join("")}</section>
    <div class="cust-grid">
      <div class="stack">
        ${S.hasInvoices ? `<section class="card chart">
          <div class="card-head"><h2>${esc(t("cust.revenueBy"))}</h2>${granSwitch(custGran(), CUST_GRANS)}</div>
          <div id="mgr-chart"></div><div class="card-foot">${esc(t("mgr.chartFoot"))}</div>
        </section>` : ""}
        ${S.hasOffers ? offersCard(m) : ""}
        <section class="card">
          <div class="card-head"><h2>${esc(t("d.customersOf"))} (${esc(F.num(m.count))})</h2><a class="sub" href="#sales?by=customer&pm=${encodeURIComponent(key)}">${S.hasInvoices ? esc(t("mgr.toSales")) : ""}</a></div>
          <div id="mgr-customers"></div>
        </section>
      </div>
      <div class="stack">
        ${S.hasInvoices ? `<section class="card"><div class="card-head"><h2>${esc(t("ov.byCurrency", { p: P.short }))}</h2></div>
          <dl class="rows">${currencyOrder().filter((c) => m.ytd.has(c)).map((c) => `<div><dt><a href="#sales?cur=${encodeURIComponent(c)}&pm=${encodeURIComponent(key)}"><b>${esc(c)}</b></a></dt>
            <dd>${esc(F.money(m.ytd.get(c) / 100, c))}</dd></div>`).join("") || `<div><dt>${esc(t("t.empty"))}</dt><dd></dd></div>`}</dl></section>
        <section class="card"><div class="card-head"><h2>${esc(t("ov.byIndustry", { p: P.short }))}</h2><span class="sub">${esc(t("mgr.hufShort"))}</span></div>
          ${hbars([...byIndustry.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: esc(k || t("none")), value: v / 100, tip: `${k || t("none")}\n${F.money(v / 100, "HUF")}` })), (v) => compactMoney(v, "HUF"))}</section>` : ""}
        <section class="card"><div class="card-head"><h2>${esc(t("chart.latest"))}</h2></div>
          <dl class="rows">${latest.map((c) => `<div><dt>${custLink(c)}</dt><dd class="none">${newBadge(c)}</dd></div>`).join("") || `<div><dt>${esc(t("t.empty"))}</dt><dd></dd></div>`}</dl></section>
      </div>
    </div>`;

  if (S.hasInvoices) {
    drawInvoicePeriods($("#mgr-chart"), m.invoices, "HUF", { pm: key });
    onGranSwitch(main, () => drawInvoicePeriods($("#mgr-chart"), m.invoices, "HUF", { pm: key }));
  }
  const money = (c, map) => F.money(c.st.main(map) || null, c.st.cur) + (c.st.others(map).size ? " +" : "");
  const cols = [
    { key: "name", label: t("col.name"), value: (c) => c.name, html: (c) => custLink(c), wrap: true },
    ...(S.hasInvoices ? [
      { key: "ytd", label: t("col.revenueYtd", { p: P.short }), num: true, value: (c) => c.st.main(c.st.ytd) || null, html: (c) => esc(money(c, c.st.ytd)) },
      { key: "change", label: t("sales.col.change"), num: true, value: (c) => (c.st.main(c.st.prev) ? (c.st.main(c.st.ytd) - c.st.main(c.st.prev)) / Math.abs(c.st.main(c.st.prev)) : null),
        html: (c) => `<span title="${esc(`${t("mgr.col.prev")}: ${money(c, c.st.prev)}`)}">${changeHtml(c.st.main(c.st.ytd), c.st.main(c.st.prev))}</span>` },
      { key: "inv", label: t("mgr.col.invoices", { p: P.short }), num: true, value: (c) => c.st.ytdCount },
    ] : []),
    { key: "industry", label: t("col.industry"), value: (c) => c.industryLabel, html: (c) => codeLabel(c.industry, c.industry_code) },
  ];
  drawTable($("#mgr-customers"), { id: "manager-customers", columns: cols, rows: m.customers, defaultSort: S.hasInvoices ? "-ytd" : "name", pageSize: 25 });
}

/* ---------- customers list ---------- */

/* Default order: name, industry, Ügyintéző, tax no., currency, payment terms,
   sales this year, country, region, city (+ open invoices with payment data). */
function customerColumns() {
  const cols = [
    { key: "name", label: t("col.name"), value: (c) => c.name, html: (c) => custLink(c), wrap: true },
    { key: "industry", label: t("col.industry"), value: (c) => c.industryLabel, html: (c) => codeLabel(c.industry, c.industry_code) },
    { key: "pm", label: t("col.manager"), value: (c) => c.account_manager, html: (c) => pmLink(pmKey(c)) },
    { key: "tax", label: t("col.taxNumber"), value: (c) => c.tax_number, html: (c) => `<span class="mono">${esc(c.tax_number)}</span>` },
    { key: "currency", label: t("col.currency"), value: (c) => c.currencyLabel, html: (c) => codeLabel(c.currency, c.currency_code) },
    { key: "terms", label: t("col.paymentTerms"), num: true, value: (c) => c.payment_terms, html: (c) => esc(days(c.payment_terms)) },
  ];
  if (S.hasInvoices) {
    const money = (c, map) => F.money(c.st.main(map) || null, c.st.cur) + (c.st.others(map).size ? " +" : "");
    cols.push({ key: "ytd", label: t("col.revenueYtd", { p: P.short }), num: true, value: (c) => c.st.main(c.st.ytd) || null, html: (c) => esc(money(c, c.st.ytd)), csv: (c) => moneyList(c.st.ytd) });
    if (S.hasPayments) cols.push({ key: "open", label: t("col.openNet"), num: true, value: (c) => c.st.main(c.st.open) || null,
      html: (c) => (c.st.openN ? `${c.st.overdueN ? `<span class="pill bad">${c.st.overdueN}</span> ` : ""}${esc(money(c, c.st.open))}` : ""), csv: (c) => moneyList(c.st.open) });
  }
  cols.push(
    { key: "country", label: t("col.country"), value: (c) => c.country, html: (c) => `<span title="${esc(F.country(c.country))}">${esc(c.country)}</span>` },
    { key: "region", label: t("col.region"), value: (c) => c.regionLabel, html: (c) => codeLabel(c.region, c.region_code) },
    { key: "city", label: t("col.city"), value: (c) => c.city },
  );
  return cols;
}
// New column set: a fresh saved-layout key, so old saved orders don't hide the new default
const CUSTOMER_TABLE = "customers-v2";

function renderCustomers(main) {
  const p = current.params;
  const pms = [...S.managers.keys()].filter((k) => k !== NONE).sort((a, b) => a.localeCompare(b, F.loc));
  const sortedSet = (key) => [...new Set(S.customers.map((c) => c[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, F.loc));
  const countries = [...new Set(S.customers.map((c) => c.country).filter(Boolean))].sort();
  let rows = [];
  filteredView(main, [
    fSearch("q", "f.searchCustomers"),
    fSelect("pm", "f.allManagers", [...pms.map((k) => [k, k]), ...(S.managers.has(NONE) ? [[NONE, t("none")]] : [])]),
    fSelect("country", "f.allCountries", countries.map((c) => [c, `${c} – ${F.country(c)}`])),
    fSelect("region", "f.allRegions", sortedSet("regionLabel").map((r) => [r, r])),
    fSelect("industry", "f.allIndustries", sortedSet("industryLabel").map((i) => [i, i])),
    fDate("from", "f.from"), fDate("to", "f.to"),
  ].join(""), (host) => {
    const words = (p.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
    rows = S.customers.filter((c) =>
      (!p.get("pm") || pmKey(c) === p.get("pm")) &&
      (!p.get("country") || c.country === p.get("country")) &&
      (!p.get("region") || c.regionLabel === p.get("region")) &&
      (!p.get("industry") || c.industryLabel === p.get("industry")) &&
      (!p.get("from") || (c.created && c.created >= p.get("from"))) &&
      (!p.get("to") || (c.created && c.created <= p.get("to"))) &&
      words.every((w) => c._s.includes(w)));
    rows = drawTable(host, { id: CUSTOMER_TABLE, columns: customerColumns(), rows, defaultSort: S.hasInvoices ? "-ytd" : "name",
      total: S.customers.length, totals: S.hasInvoices ? esc(t("t.mixed")) : "" });
  }, () => exportCsv("vevok", layoutColumns(CUSTOMER_TABLE, customerColumns()), rows));
}

/* ---------- customer page ---------- */

const FORMS = /^(kft\.?|zrt\.?|nyrt\.?|bt\.?|kkt\.?|e\.?v\.?|gmbh|ag|s\.?r\.?o\.?|s\.?r\.?l\.?|d\.?o\.?o\.?|b\.?v\.?|ltd\.?|inc\.?|és|and|-|&)$/i;
function initials(name) {
  const words = String(name || "?").split(/\s+/).filter((w) => w && !FORMS.test(w) && /\p{L}/u.test(w));
  return (words.slice(0, 2).map((w) => w.match(/\p{L}/u)[0]).join("") || "?").toUpperCase();
}

function kpiTile(label, valueHtml, sub, hl = false) {
  return `<div class="kpi${hl ? " hl" : ""}"><div class="label">${esc(label)}</div><div class="value">${valueHtml}</div><div class="sub">${sub}</div></div>`;
}
function bigMoney(v, cur) {
  const p = F.compactParts(v, cur);
  return `${esc(p.num)}<span class="unit">${esc(p.unit)}</span>`;
}

function renderCustomer(main) {
  const id = current.params.get("id");
  const c = S.byId.get(id);
  if (!c) {
    main.innerHTML = `<div class="notice bad">${esc(t("cust.notFound", { id }))}</div><a class="back" href="#customers">${esc(t("cust.back"))}</a>`;
    return;
  }
  document.title = `${c.name || c.id} – ${t("app.title")}`;
  const st = c.st;
  const chip = (label, value, href) => (value ? `<a class="chip" href="${href}"><b>${esc(label)}</b>${esc(value)}</a>` : "");
  const address = [[c.street, c.house_number].filter(Boolean).join(" "), [c.postal_code, c.city].filter(Boolean).join(" "), c.country]
    .filter(Boolean).join(", ");
  const contact = [c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`, c.phone && `<a href="tel:${esc(c.phone.replace(/\s/g, ""))}">${esc(c.phone)}</a>`]
    .filter(Boolean).join(" · ");

  // KPI tiles (invoice-based ones show an empty state without the invoice export)
  let kpis;
  const termsTile = kpiTile(t("cust.paymentTerms"), c.payment_terms != null ? esc(days(c.payment_terms)) : `<span class="empty">–</span>`,
    esc(c.payment_method || c.payment_method_code || ""));
  if (S.hasInvoices) {
    const ytd = st.main(st.ytd), prev = st.main(st.prev);
    const delta = prev ? (ytd - prev) / Math.abs(prev) : null;
    const others = (map) => (st.others(map).size ? `<br>${esc(t("cust.otherCur", { list: moneyList(st.others(map)) }))}` : "");
    const yearsSpan = st.firstYear ? (st.firstYear === st.lastYear ? `${st.firstYear}` : `${st.firstYear}–${st.lastYear}`) : "";
    kpis = [
      kpiTile(t("cust.revenueYtd", { p: P.short }), bigMoney(ytd, st.cur),
        (delta == null ? esc(t("cust.noPrev")) : `<span class="${delta >= 0 ? "delta-up" : "delta-down"}">${esc(t("cust.vsPrev", { pct: F.signedPct(delta) }))}</span>`) + others(st.ytd), true),
      S.hasPayments
        ? kpiTile(t("cust.openInvoices"), bigMoney(st.main(st.open), st.cur),
          esc(st.overdueN ? t("cust.overdueCount", { n: st.openN, o: st.overdueN }) : t("cust.openCount", { n: st.openN })) + others(st.open))
        : kpiTile(t("cust.invoicesYtd", { p: P.short }), esc(F.num(st.ytdCount)),
          esc([st.ytdCredits ? t("cust.creditCount", { n: st.ytdCredits }) : "", t("cust.invoiceCountAll", { n: F.num(st.count) })].filter(Boolean).join(" · "))),
      termsTile,
      kpiTile(t("cust.revenueTotal"), bigMoney(st.main(st.total), st.cur), esc(yearsSpan) + others(st.total)),
    ];
  } else {
    const empty = (label) => kpiTile(label, `<span class="empty">–</span>`, esc(t("cust.noExport")));
    kpis = [empty(t("cust.revenueYtd", { p: P.short })), empty(t("cust.invoicesYtd", { p: P.short })), termsTile, empty(t("cust.revenueTotal"))];
  }

  const src = (key) => S.meta.sources?.[key];
  const srcTag = (key) => (src(key) ? `<span class="src">${esc(src(key).file)}</span>` : "");
  const row = (label, value) => `<div><dt>${esc(label)}</dt><dd${value ? "" : ' class="none"'}>${value || esc(t("none"))}</dd></div>`;
  const same = c.group ? (S.groups.get(c.group) || []).filter((x) => x !== c) : [];

  main.innerHTML = `
    <a class="back" href="#customers">${esc(t("cust.back"))}</a>
    <section class="cust-head">
      <div class="avatar" aria-hidden="true">${esc(initials(c.name))}</div>
      <div>
        <div class="eyebrow">${esc(t("cust.label"))} · ${esc(c.id)}</div>
        <h1>${esc(c.name || c.id)}</h1>
        <div class="chips">
          ${chip(t("col.industry"), c.industryLabel, `#customers?industry=${encodeURIComponent(c.industryLabel || "")}`)}
          ${chip(t("col.region"), c.regionLabel, `#customers?region=${encodeURIComponent(c.regionLabel || "")}`)}
          ${chip(t("col.currency"), c.currencyLabel, `#customers?q=${encodeURIComponent(c.currencyLabel || "")}`)}
          ${chip(t("col.country"), c.country && F.country(c.country), `#customers?country=${encodeURIComponent(c.country || "")}`)}
        </div>
      </div>
      <div class="cust-contact">
        <div class="eyebrow">${esc(t("cust.address"))}</div><div>${esc(address) || `<span class="muted">${esc(t("none"))}</span>`}</div>
        <div class="eyebrow">${esc(t("cust.contact"))}</div><div>${contact || `<span class="muted">${esc(t("none"))}</span>`}</div>
      </div>
    </section>
    <section class="kpis">${kpis.join("")}</section>
    <div class="cust-grid">
      <div class="stack">
        <section class="card chart">
          <div class="card-head"><h2>${esc(t("cust.revenueBy"))}</h2>${S.hasInvoices && c.invoices.length ? granSwitch(custGran(), CUST_GRANS) : srcTag("invoices")}</div>
          ${!S.hasInvoices ? `<div class="empty-state">${esc(t("cust.noInvoiceExport"))}</div>`
            : !c.invoices.length ? `<div class="empty-state">${esc(t("cust.noInvoices"))}</div>`
            : `<div id="years"></div><div class="card-foot">${esc(t("cust.revenueFoot", { cur: st.cur }))}</div>`}
        </section>
        <section class="card">
          <div class="card-head"><h2>${esc(t(S.hasPayments || !S.hasInvoices ? "cust.openTitle" : "cust.latest"))}</h2>${srcTag("invoices")}</div>
          ${S.hasPayments || !S.hasInvoices ? openInvoicesHtml(c) : latestInvoicesHtml(c)}
        </section>
      </div>
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>${esc(t("cust.terms"))}</h2>${srcTag("customers")}</div>
          <dl class="rows">
            ${row(t("cust.paymentTerms"), c.payment_terms != null ? esc(days(c.payment_terms)) : "")}
            ${row(t("col.paymentMethod"), codeLabel(c.payment_method, c.payment_method_code))}
            ${row(t("col.currency"), codeLabel(c.currency, c.currency_code))}
            ${row(t("col.association"), esc(c.association))}
            ${row(t("col.manager"), c.account_manager ? pmLink(c.account_manager) : "")}
          </dl>
        </section>
        <section class="card">
          <div class="card-head"><h2>${esc(t("cust.ids"))}</h2></div>
          <dl class="rows">
            ${row(t("col.id"), `<span class="mono">${esc(c.id)}</span>`)}
            ${row(t("col.searchTerm"), esc(c.search_term))}
            ${row(t("col.taxNumber"), c.tax_number ? `<span class="mono">${esc(c.tax_number)}</span>` : "")}
            ${row(t("col.euVat"), c.eu_vat_number ? `<span class="mono">${esc(c.eu_vat_number)}</span>` : "")}
            ${row(t("col.group"), c.group ? `<span class="mono">${esc(c.group)}</span>` : "")}
            ${row(t("col.supplierId"), c.supplier_id ? `<span class="mono">${esc(c.supplier_id)}</span>` : "")}
            ${row(t("col.created"), esc(F.date(c.created)))}
          </dl>
        </section>
        ${same.length ? `<section class="card">
          <div class="card-head"><h2>${esc(t("cust.sameGroup"))}</h2><span class="src">${esc(c.group)}</span></div>
          <dl class="rows">${same.slice(0, 12).map((x) => `<div><dt>${custLink(x)}</dt><dd class="none mono">${esc(x.id)}</dd></div>`).join("")}</dl>
          ${same.length > 12 ? `<div class="card-foot"><a href="#customers?q=${encodeURIComponent(c.group)}">+${same.length - 12}</a></div>` : ""}
        </section>` : ""}
      </div>
    </div>
    <footer class="sources">
      <span>${esc(t("cust.sources"))}${S.meta.fake ? ` · <b>${esc(t("fake"))}</b>` : ""}</span>
      ${["customers", "invoices"].map((k) => (src(k) ? `<code title="${esc(F.dateTime(new Date(src(k).exported_at)))}">${esc(src(k).file)}</code>` : "")).join("")}
      ${src("invoices") ? "" : `<code>${esc(t("cust.noFile"))}</code>`}
    </footer>`;
  if (S.hasInvoices && c.invoices.length) drawCustomerPeriods($("#years"), c);
  onGranSwitch(main, () => drawCustomerPeriods($("#years"), c));
}

/* Latest invoices (when the export has no payment data, open invoices can't be shown). */
function latestInvoicesHtml(c) {
  if (!c.invoices.length) return `<div class="empty-state">${esc(t("cust.noInvoices"))}</div>`;
  const shown = c.invoices.slice(0, 15);
  return `<div class="table-wrap plain"><table>
    <thead><tr><th>${esc(t("col.invNumber"))}</th><th>${esc(t("col.invDate"))}</th><th class="num">${esc(amtWord())}</th><th></th></tr></thead>
    <tbody>${shown.map((i) => `<tr><td class="mono">${esc(i.id)}</td><td>${esc(F.date(i.date))}</td>
      <td class="num">${esc(F.money(amtOf(i), i.cur))}</td><td>${i.credit ? `<span class="pill warn">${esc(t("cust.credit"))}</span>` : ""}${i.origin && i.origin !== "R" ? ` <span class="pill ok">${esc(i.origin)}</span>` : ""}</td></tr>`).join("")}</tbody>
  </table></div>
  <div class="card-foot"><a href="#sales?from=${esc(c.st.firstDate || TODAY)}&to=${TODAY}&cur=${encodeURIComponent(c.st.cur)}&cust=${encodeURIComponent(c.id)}">${esc(t("cust.allSales", { n: F.num(c.invoices.length) }))}</a></div>`;
}

/* Customer sales chart: the last few periods, the current one highlighted. */
const CUST_GRANS = ["year", "half", "quarter", "month"];
const CUST_PERIODS = { year: 5, half: 8, quarter: 12, month: 24 };
const custGran = () => (CUST_GRANS.includes(current.params.get("g")) ? current.params.get("g") : "year");
function granSwitch(active, grans) {
  return `<div class="seg" role="group" aria-label="${esc(t("sales.gran"))}">${grans.map((g) =>
    `<button type="button" data-gran="${g}" aria-pressed="${g === active}">${esc(t("gran." + g))}</button>`).join("")}</div>`;
}
function drawCustomerPeriods(host, c) { drawInvoicePeriods(host, c.invoices, c.st.cur, { cust: c.id }); }
/* The last few periods of these invoices in one currency, the current period highlighted. */
function drawInvoicePeriods(host, invoices, cur, extra = {}) {
  const g = custGran();
  const first = invoices.reduce((a, i) => (i.cur === cur && i.date && (!a || i.date < a) ? i.date : a), null) || TODAY;
  const keys = periodKeys(first, TODAY, g).slice(-CUST_PERIODS[g]);
  const sums = new Map();
  for (const i of invoices) if (i.cur === cur && i.date) addTo(sums, periodKey(i.date, g), val(i));
  drawPeriodChart(host, { keys, g, values: keys.map((k) => (sums.get(k) || 0) / 100), cur, mode: "highlight", label: t("cust.revenueBy"),
    href: (k) => bucketHref(k, g, { cur, ...extra }) });
}
/* Wire a year/half/quarter/month switch to a redraw function. */
function onGranSwitch(root, redraw) {
  root.querySelector(".seg[role=group]:not([data-param])")?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-gran]");
    if (!b) return;
    setParams({ g: b.dataset.gran });
    b.parentElement.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    redraw();
  });
}

function openInvoicesHtml(c) {
  if (!S.hasInvoices) return `<div class="empty-state">${esc(t("cust.noInvoiceExport"))}</div>`;
  const open = c.invoices.filter((i) => i.open).sort((a, b) => (a.dueEff || "9999").localeCompare(b.dueEff || "9999"));
  if (!open.length) return `<div class="empty-state">${esc(t("cust.noOpen"))}</div>`;
  const pill = (i) => {
    if (i.daysOverdue == null) return "";
    if (i.daysOverdue > 0) return `<span class="pill bad">${esc(t("pill.overdue", { n: i.daysOverdue }))}</span>`;
    if (i.daysOverdue === 0) return `<span class="pill warn">${esc(t("pill.today"))}</span>`;
    return `<span class="pill ${-i.daysOverdue <= CONFIG.dueSoonDays ? "warn" : "ok"}">${esc(t("pill.inDays", { n: -i.daysOverdue }))}</span>`;
  };
  const shown = open.slice(0, CONFIG.openInvoicesShown);
  const estimated = shown.some((i) => i.dueEstimated);
  return `<div class="table-wrap plain"><table>
    <thead><tr><th>${esc(t("col.invNumber"))}</th><th>${esc(t("col.invDate"))}</th><th class="num">${esc(amtWord())}</th><th>${esc(t("col.due"))}</th><th>${esc(t("col.state"))}</th></tr></thead>
    <tbody>${shown.map((i) => `<tr><td class="mono">${esc(i.id)}</td><td>${esc(F.date(i.date))}</td>
      <td class="num">${esc(F.money(amtOf(i), i.cur))}</td><td>${esc(F.date(i.dueEff))}${i.dueEstimated ? "*" : ""}</td><td>${pill(i)}</td></tr>`).join("")}</tbody>
  </table></div>
  ${open.length > shown.length ? `<div class="card-foot">+${open.length - shown.length}</div>` : ""}
  <div class="card-foot">${esc(estimated ? t("cust.openFoot") : t("cust.openFoot").split(" * ")[0])}</div>`;
}

/* ---------- periods ---------- */
/* Period keys: day 2026-06-08 · week 2026-W23 (ISO) · month 2026-06 · quarter 2026-Q2
   · half 2026-H1 · year 2026. A key with the year lowered by one is the same
   period of the previous year (also for ISO weeks). */
const GRANS = ["day", "week", "month", "quarter", "half", "year"];
function isoWeek(iso) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // Thursday of this week decides the year
  const y = d.getFullYear(), jan4 = new Date(y, 0, 4);
  return [y, 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7)];
}
function periodKey(iso, g) {
  const y = iso.slice(0, 4), m = +iso.slice(5, 7);
  if (g === "day") return iso.slice(0, 10);
  if (g === "week") { const [wy, w] = isoWeek(iso); return `${wy}-W${pad(w)}`; }
  if (g === "month") return iso.slice(0, 7);
  if (g === "quarter") return `${y}-Q${Math.ceil(m / 3)}`;
  if (g === "half") return `${y}-H${m <= 6 ? 1 : 2}`;
  return y;
}
function periodStart(key, g) {
  const y = +key.slice(0, 4), n = +key.slice(6);
  if (g === "day") return key;
  if (g === "week") { const jan4 = new Date(y, 0, 4); return isoDate(new Date(y, 0, 4 - ((jan4.getDay() + 6) % 7) + (n - 1) * 7)); }
  if (g === "month") return `${key}-01`;
  if (g === "quarter") return `${y}-${pad((n - 1) * 3 + 1)}-01`;
  if (g === "half") return `${y}-${n === 1 ? "01" : "07"}-01`;
  return `${y}-01-01`;
}
function nextPeriodStart(key, g) {
  const d = new Date(periodStart(key, g) + "T00:00:00");
  if (g === "day") d.setDate(d.getDate() + 1);
  else if (g === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + ({ month: 1, quarter: 3, half: 6, year: 12 })[g]);
  return isoDate(d);
}
function periodKeys(from, to, g) {
  const keys = [];
  for (let k = periodKey(from, g); periodStart(k, g) <= to && keys.length < 4000; k = periodKey(nextPeriodStart(k, g), g)) keys.push(k);
  return keys;
}
const shiftKeyYear = (key, n) => `${+key.slice(0, 4) + n}${key.slice(4)}`;
const shiftIsoYear = (iso, n) => { const d = new Date(iso + "T00:00:00"); d.setFullYear(d.getFullYear() + n); return isoDate(d); };
const ROMAN = ["I", "II", "III", "IV"];
function periodLabel(key, g, short = false) {
  const y = key.slice(0, 4), n = +key.slice(6);
  const roman = LANG === "hu" ? ROMAN[n - 1] : n;
  if (g === "day") return short ? new Date(key + "T00:00:00").toLocaleDateString(F.loc, { month: "short", day: "numeric" }) : F.date(key);
  if (g === "week") return t(short ? "period.weekShort" : "period.week", { y, n });
  if (g === "month") return short ? F.month(key) : F.monthYear(key);
  if (g === "quarter") return t(short ? "period.quarterShort" : "period.quarter", { y, n: roman });
  if (g === "half") return t(short ? "period.halfShort" : "period.half", { y, n: roman });
  return y;
}

/* Bar chart over periods.
   mode "highlight": one series, the last (current) period in the accent colour;
   mode "compare":   previous year (muted) next to this period (accent). */
/* Link to the invoices behind one chart period: the Sales tab on that date range
   (cut to `clip`, never past today), with its own finer breakdown and the filters in `extra`. */
function bucketHref(key, g, extra = {}, clip = null) {
  let from = periodStart(key, g), to = addDays(nextPeriodStart(key, g), -1);
  if (clip) { if (from < clip.from) from = clip.from; if (to > clip.to) to = clip.to; }
  if (to > TODAY) to = TODAY;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v && !["from", "to", "g", "isort"].includes(k)) q.set(k, v);
  q.set("from", from);
  q.set("to", to);
  return `#sales?${q}`;
}
function drawPeriodChart(host, { keys, g, values, prev = null, cur, mode = "highlight", label = "", height = 270, shift = 1, href = null }) {
  const n = keys.length;
  const W = Math.max(300, host.clientWidth), H = height;
  const m = { l: 56, r: 8, t: 24, b: 30 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const all = [...values, ...(prev || [])];
  const hi = Math.max(...all, 0), lo = Math.min(...all, 0);
  const step = niceStep(Math.max(hi - lo, 1) / 4);
  const max = Math.ceil(hi / step) * step || step, min = Math.floor(lo / step) * step;
  const y = (v) => m.t + ((max - v) / (max - min)) * ph;
  const base = y(0), bw = pw / Math.max(n, 1);
  const pair = mode === "compare";
  const barW = Math.max(1, pair ? Math.min(28, bw * 0.38) : Math.min(64, bw * 0.6));
  const bar = (x, v, cls) => (v >= 0 ? barPath(x, barW, y(v), base, cls)
    : `<rect class="${cls}" x="${x}" y="${base}" width="${barW}" height="${y(v) - base}"/>`);
  let svg = "";
  for (let v = min; v <= max + step / 2; v += step) {
    if (v !== 0) svg += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="axis-label" x="${m.l - 10}" y="${y(v) + 4}" text-anchor="end">${esc(v ? F.axis(v) : "0")}</text>`;
  }
  svg += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${base}" y2="${base}"/>`;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 64))));
  const showValues = !pair && n <= 12;
  keys.forEach((k, i) => {
    const cx = m.l + bw * i + bw / 2;
    const now = mode === "highlight" && i === n - 1 ? " now" : "";
    if (pair) {
      if (prev) svg += bar(cx - barW - 1, prev[i], "bar");
      svg += bar(prev ? cx + 1 : cx - barW / 2, values[i], "bar now");
    } else svg += bar(cx - barW / 2, values[i], mode === "plain" ? "bar now" : `bar${now}`);
    if (showValues && values[i]) svg += `<text class="value-label${now}" x="${cx}" y="${values[i] >= 0 ? y(values[i]) - 8 : y(values[i]) + 14}" text-anchor="middle">${esc(F.axis(values[i]))}</text>`;
    if (i % every === 0) {
      const newYear = g !== "year" && (i === 0 || keys[i - 1].slice(0, 4) !== k.slice(0, 4));
      const text = g === "year" ? k : `${newYear ? k.slice(0, 4) + " " : ""}${periodLabel(k, g, true)}`;
      svg += `<text class="${g === "year" ? `year-label${now}` : "axis-label"}" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(text)}</text>`;
    }
    const tipLines = [periodLabel(k, g), F.money(values[i], cur)];
    if (prev) {
      tipLines.push(`${t("sales.prevYear")} (${periodLabel(shiftKeyYear(k, -shift), g)}): ${F.money(prev[i], cur)}`);
      if (prev[i]) tipLines.push(`${t("sales.col.change")}: ${F.signedPct((values[i] - prev[i]) / Math.abs(prev[i]))}`);
    }
    const link = href ? href(k) : null;
    if (link) tipLines.push(t("chart.click"));
    svg += `<rect class="band${link ? " link" : ""}" x="${m.l + bw * i}" y="${m.t}" width="${bw}" height="${ph}" data-tip="${esc(tipLines.join("\n"))}"${link ? ` data-href="${esc(link)}"` : ""}/>`;
  });
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${svg}</svg>`;
}

/* ---------- sales view ---------- */

const BREAKDOWNS = ["customer", "manager", "region", "industry", "country", "clerk"];

/* The sales tab shows the period picked in the top bar, unless custom dates are
   set here. Comparison: shifted back like everywhere else (P.shift years). */
function salesRange(p) {
  if (p.get("from") || p.get("to")) {
    const from = p.get("from") || S.firstDate || TODAY, to = p.get("to") || TODAY;
    const shift = Math.max(1, Math.ceil((daysBetween(from, to) + 1) / 366));
    return { from, to, shift, prevFrom: shiftIsoYear(from, -shift), prevTo: shiftIsoYear(to, -shift), custom: true };
  }
  return { from: P.from, to: P.to, shift: P.shift, prevFrom: P.prevFrom, prevTo: P.prevTo, custom: false };
}
/* A sensible time breakdown for the length of the range */
function autoGran(from, to) {
  const days = daysBetween(from, to) + 1;
  return days <= 45 ? "day" : days <= 120 ? "week" : days <= 800 ? "month" : days <= 2000 ? "quarter" : "year";
}

function breakdownKey(by, i) {
  const c = i.c;
  if (by === "manager") return [pmKey(c), pmName(pmKey(c)), pmKey(c) === NONE ? null : `#customers?pm=${encodeURIComponent(pmKey(c))}`];
  if (by === "region") return [c.regionLabel || "", c.regionLabel || t("none"), null];
  if (by === "industry") return [c.industryLabel || "", c.industryLabel || t("none"), null];
  if (by === "country") return [c.country || "", c.country ? `${F.country(c.country)} (${c.country})` : t("none"), null];
  if (by === "clerk") return [i.clerk || "", i.clerk || t("none"), null];
  return [c.id, c.name || c.id, customerHref(c.id)];
}

/* Currencies: HUF first, then by number of invoices (amounts in different
   currencies can't be compared, so they never decide the order). */
function currencyOrder() {
  const n = new Map();
  for (const i of S.invoices) n.set(i.cur, (n.get(i.cur) || 0) + 1);
  return [...n.entries()].sort((a, b) => (b[0] === "HUF") - (a[0] === "HUF") || b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
}

/* Button group: one choice of a URL parameter. */
const pills = (param, options, active, cls = "") =>
  `<div class="seg seg-lg ${cls}" role="group" data-param="${param}">${options.map(([v, l]) =>
    `<button type="button" data-value="${esc(v)}" aria-pressed="${v === active}">${esc(l)}</button>`).join("")}</div>`;

function renderSales(main) {
  if (!S.hasInvoices) {
    main.innerHTML = `<section class="card"><div class="empty-state">${esc(t("sales.noInvoices"))}</div></section>`;
    return;
  }
  const p = current.params;
  const currencies = currencyOrder();
  const pms = [...S.managers.keys()].filter((k) => k !== NONE).sort((a, b) => a.localeCompare(b, F.loc));
  const sortedSet = (key) => [...new Set(S.customers.map((c) => c[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, F.loc));
  const countries = [...new Set(S.customers.map((c) => c.country).filter(Boolean))].sort();
  const range0 = salesRange(p);
  const rangeChip = (r) => `<span class="chip"><b>${esc(t("sales.ctl.range"))}</b>${esc(r.custom ? t("range.custom") : P.short)}</span>
    <span class="muted range-dates">${esc(`${F.date(r.from)} – ${F.date(r.to)}`)}</span>
    ${r.custom ? `<button type="button" class="link-btn" data-act="clear-dates">${esc(t("sales.backToPeriod", { p: P.short }))}</button>`
      : `<span class="muted">${esc(t("sales.periodHint"))}</span>`}`;

  main.innerHTML = `<div class="sales-view" style="display:contents">
    <section class="card sales-controls">
      <div class="ctl-row">
        <span class="range-info">${rangeChip(range0)}</span>
        <span class="ctl-dates">${fDate("from", "f.fromDate")}${fDate("to", "f.toDate")}</span>
        ${p.get("cust") ? `<span class="chip cust-chip"><b>${esc(t("sales.custFilter"))}</b>${esc(S.byId.get(p.get("cust"))?.name || p.get("cust"))}
          <button type="button" class="link-btn" data-act="clear-cust" aria-label="${esc(t("f.reset"))}">✕</button></span>` : ""}
      </div>
      <div class="ctl-row">
        <span class="ctl-label">${esc(t("sales.gran"))}</span>
        ${pills("g", GRANS.map((g) => [g, t("gran." + g)]), p.get("g") || autoGran(range0.from, range0.to))}
      </div>
      <div class="filters">
        ${fSearch("q", "f.searchCustomers")}
        ${fSelect("pm", "f.allManagers", [...pms.map((k) => [k, k]), ...(S.managers.has(NONE) ? [[NONE, t("none")]] : [])])}
        ${fSelect("region", "f.allRegions", sortedSet("regionLabel").map((r) => [r, r]))}
        ${fSelect("industry", "f.allIndustries", sortedSet("industryLabel").map((i) => [i, i]))}
        ${fSelect("country", "f.allCountries", countries.map((c) => [c, `${c} – ${F.country(c)}`]))}
        <span class="spacer"></span>
        <button type="button" class="secondary" data-act="reset">${esc(t("f.reset"))}</button>
        <button type="button" data-act="export">${esc(t("f.export"))}</button>
      </div>
    </section>
    <div class="results sales-results"></div>
  </div>`;
  const view = main.firstElementChild, host = $(".results", view), controls = $(".sales-controls", view);
  let state = {};
  const draw = () => {
    // Redrawing replaces the results; keep the reader where they are (e.g. at the
    // breakdown buttons). The results area never shrinks while on this tab, so a
    // shorter table (e.g. "Ország") can't pull the page up under the mouse.
    const y = window.scrollY;
    const tallest = Math.max(parseFloat(host.dataset.tallest || 0), host.scrollHeight);
    host.dataset.tallest = tallest;
    host.style.minHeight = `${tallest}px`;
    state = drawSales(host, currencies);
    window.scrollTo(0, y);
    // reflect the effective choices (defaults, custom dates) on the controls
    $(".range-info", controls).innerHTML = rangeChip(state.range);
    controls.querySelectorAll('.seg[data-param="g"] button').forEach((b) => b.setAttribute("aria-pressed", b.dataset.value === state.g));
  };
  const set = (updates) => { setParams(updates); tablePage["sales-by"] = 0; tablePage["sales-invoices"] = 0; draw(); };

  // buttons: range, breakdown, amount, currency, "by"
  view.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg[data-param] button, .cur-switch[data-param] button");
    if (btn) {
      const group = btn.closest("[data-param]"), param = group.dataset.param, value = btn.dataset.value;
      set({ [param]: value });
      group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === btn));
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "clear-cust") {
      e.target.closest(".cust-chip")?.remove();
      set({ cust: "" });
    } else if (act === "export-inv") {
      exportCsv(`szamlak_${state.range.from}_${state.range.to}_${state.cur}`, layoutColumns("sales-invoices", state.invColumns), state.invRows);
    } else if (act === "clear-dates") {
      controls.querySelectorAll('input[data-param="from"], input[data-param="to"]').forEach((i) => { i.value = ""; });
      set({ from: "", to: "", g: "" });
    } else if (act === "reset") {
      for (const k of [...current.params.keys()]) setParams({ [k]: "" });
      route();
    } else if (act === "export") {
      exportCsv(`ertekesites_${state.g}_${state.cur}`, [
        { label: t("sales.col.period"), value: (r) => periodLabel(r.key, state.g) },
        { label: t("sales.col.from"), value: (r) => periodStart(r.key, state.g) },
        { label: `${t("sales.col.amount")} (${state.cur})`, value: (r) => r.v / 100 },
        { label: `${t("sales.prevYear")} (${state.cur})`, value: (r) => r.prev / 100 },
        { label: t("sales.col.count"), value: (r) => r.n },
        { label: t("sales.col.credits"), value: (r) => r.credits },
      ], state.periods);
    }
  });
  // search, dropdowns, custom dates
  let timer;
  controls.addEventListener("input", (e) => {
    const el = e.target;
    if (!el.dataset.param) return;
    clearTimeout(timer);
    timer = setTimeout(() => set({ [el.dataset.param]: el.value.trim() }), el.type === "search" ? 200 : 0);
  });
  draw();
}

function drawSales(host, currencies) {
  const p = current.params;
  const range = salesRange(p);
  const g = GRANS.includes(p.get("g")) ? p.get("g") : autoGran(range.from, range.to);
  const cur = currencies.includes(p.get("cur")) ? p.get("cur") : (currencies.includes("HUF") ? "HUF" : currencies[0]);
  const amt = isGross() ? "gross" : "net";
  const by = BREAKDOWNS.includes(p.get("by")) ? p.get("by") : "customer";
  const amount = val;
  const words = (p.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
  const customerOk = (c) => (!p.get("cust") || c.id === p.get("cust")) &&
    (!p.get("pm") || pmKey(c) === p.get("pm")) && (!p.get("region") || c.regionLabel === p.get("region")) &&
    (!p.get("industry") || c.industryLabel === p.get("industry")) && (!p.get("country") || c.country === p.get("country")) &&
    words.every((w) => c._s.includes(w));
  const pFrom = range.prevFrom, pTo = range.prevTo, shift = range.shift;

  const keys = periodKeys(range.from, range.to, g);
  const per = new Map(keys.map((k) => [k, { key: k, v: 0, prev: 0, n: 0, credits: 0 }]));
  const groups = new Map(), byCur = new Map();
  let total = 0, prevTotal = 0, count = 0, credits = 0, positive = 0;
  const list = [];
  for (const i of S.invoices) {
    if (!i.date || !customerOk(i.c)) continue;
    const inRange = i.date >= range.from && i.date <= range.to;
    const inPrev = !!pFrom && i.date >= pFrom && i.date <= pTo;
    if (!inRange && !inPrev) continue;
    if (inRange) addTo(byCur, i.cur, amount(i));
    if (i.cur !== cur) continue;
    const v = amount(i);
    const [gk, glabel, ghref] = breakdownKey(by, i);
    if (!groups.has(gk)) groups.set(gk, { key: gk, label: glabel, href: ghref, v: 0, prev: 0, n: 0 });
    const grp = groups.get(gk);
    if (inRange) {
      const row = per.get(periodKey(i.date, g));
      if (row) { row.v += v; if (i.credit) row.credits++; else row.n++; }
      total += v; grp.v += v;
      list.push(i);
      if (i.credit) credits++; else { count++; grp.n++; positive += v; }
    }
    if (inPrev) {
      const row = per.get(shiftKeyYear(periodKey(i.date, g), shift));
      if (row) row.prev += v;
      prevTotal += v; grp.prev += v;
    }
  }
  const periods = [...per.values()];
  const keep = { ...Object.fromEntries(p), cur };   // filters kept when opening one period
  const big = (c) => { const x = F.compactParts(c / 100, cur); return `${esc(x.num)}<span class="unit">${esc(x.unit)}</span>`; };
  const tile = (label, value, sub, hl) => `<div class="kpi${hl ? " hl" : ""}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const change = (a, b) => (b ? `<span class="${a >= b ? "delta-up" : "delta-down"}">${esc(F.signedPct((a - b) / Math.abs(b)))}</span>` : "–");
  const rangeText = `${F.date(range.from)} – ${F.date(range.to)}`;
  const prevText = pFrom ? `${F.date(pFrom)} – ${F.date(pTo)}` : t("sales.noCompare");

  host.innerHTML = `
    <section class="cur-switch" data-param="cur" role="group" aria-label="${esc(t("sales.ctl.currency"))}">
      <span class="ctl-label">${esc(t("sales.ctl.currency"))}</span>
      ${currencies.map((c) => `<button type="button" data-value="${esc(c)}" aria-pressed="${c === cur}">
        <b>${esc(c)}</b><span>${byCur.get(c) ? esc(compactMoney(byCur.get(c) / 100, c)) : "–"}</span></button>`).join("")}
      <span class="cur-hint">${esc(t("sales.curHint"))}</span>
    </section>
    <section class="kpis">
      ${tile(t(amt === "gross" ? "sales.kpi.gross" : "sales.kpi.net"), big(total), esc(rangeText), true)}
      ${tile(t("sales.kpi.prev"), big(prevTotal), prevTotal ? `${change(total, prevTotal)} · ${esc(prevText)}` : esc(prevText))}
      ${tile(t("sales.kpi.count"), esc(F.num(count)), esc(credits ? t("cust.creditCount", { n: F.num(credits) }) : ""))}
      ${tile(t("sales.kpi.avg"), count ? big(Math.round(positive / count)) : "–", esc(t("sales.kpi.avgSub")))}
    </section>
    <div class="grid-2 sales-pair">
      <section class="card chart">
        <div class="card-head"><h2>${esc(t("sales.chart"))}</h2><span class="sub">${esc(`${t(amt === "gross" ? "sales.gross" : "sales.net")}, ${cur}`)}</span></div>
        <div class="legend"><span><i style="background:var(--bar)"></i>${esc(rangeText)}</span><span><i style="background:var(--bar-muted)"></i>${esc(t("sales.prevYear"))}</span></div>
        <div id="sales-chart"></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>${esc(t("sales.periods"))}</h2><span class="sub">${esc(`${t("gran." + g)}, ${cur}`)}</span></div>
        <div class="table-wrap plain periods"><table>
          <thead><tr><th>${esc(t("sales.col.period"))}</th><th class="num">${esc(t("sales.col.amount"))}</th><th class="num">${esc(t("sales.prevYear"))}</th><th class="num">${esc(t("sales.col.change"))}</th><th class="num">${esc(t("sales.col.count"))}</th></tr></thead>
          <tbody>${[...periods].reverse().map((r) => `<tr><td><a href="${esc(bucketHref(r.key, g, keep, range))}" title="${esc(t("chart.click"))}">${esc(periodLabel(r.key, g))}</a></td><td class="num">${esc(F.money(r.v / 100, cur))}</td>
            <td class="num muted">${esc(F.money(r.prev / 100, cur))}</td><td class="num">${change(r.v, r.prev)}</td><td class="num">${esc(F.num(r.n))}${r.credits ? ` <span class="muted">(−${r.credits})</span>` : ""}</td></tr>`).join("")}</tbody>
        </table></div>
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h2>${esc(t("sales.breakdown"))}</h2>${pills("by", BREAKDOWNS.map((b) => [b, t("byShort." + b)]), by)}</div>
      <div id="sales-by"></div>
    </section>
    <section class="card" id="sales-inv-card">
      <div class="card-head"><h2>${esc(t("sales.invoices"))}</h2>
        <span class="sub">${esc(`${rangeText} · ${cur}, ${amtWord().toLowerCase()}`)}</span>
        <button type="button" class="secondary small" data-act="export-inv">${esc(t("f.export"))}</button></div>
      <div id="sales-inv"></div>
    </section>`;

  drawPeriodChart($("#sales-chart", host), { keys, g, values: periods.map((r) => r.v / 100), prev: pFrom ? periods.map((r) => r.prev / 100) : null,
    cur, mode: "compare", label: t("sales.chart"), height: 240, shift, href: (k) => bucketHref(k, g, keep, range) });
  const rows = [...groups.values()].filter((r) => r.v || r.prev);
  drawTable($("#sales-by", host), {
    id: "sales-by", defaultSort: "-amount", rows, total: rows.length,
    columns: [
      { key: "name", label: t("by." + by), value: (r) => r.label, html: (r) => (r.href ? `<a href="${r.href}">${esc(r.label)}</a>` : esc(r.label)), wrap: true },
      { key: "amount", label: `${t("sales.col.amount")} (${cur})`, num: true, value: (r) => r.v / 100, html: (r) => esc(F.money(r.v / 100, cur)) },
      { key: "share", label: t("sales.col.share"), num: true, value: (r) => (total ? r.v / total : 0), html: (r) => esc(F.pct(total ? r.v / total : 0)) },
      { key: "count", label: t("sales.col.count"), num: true, value: (r) => r.n },
      { key: "prev", label: t("sales.prevYear"), num: true, value: (r) => r.prev / 100, html: (r) => `<span class="muted">${esc(F.money(r.prev / 100, cur))}</span>` },
      { key: "change", label: t("sales.col.change"), num: true, value: (r) => (r.prev ? (r.v - r.prev) / Math.abs(r.prev) : null), html: (r) => change(r.v, r.prev) },
    ],
  });
  const invColumns = [
    { key: "date", label: t("col.invDate"), value: (i) => i.date, html: (i) => esc(F.date(i.date)) },
    { key: "id", label: t("col.invNumber"), value: (i) => i.id, html: (i) => `<span class="mono">${esc(i.id)}</span>` },
    { key: "customer", label: t("off.customer"), value: (i) => i.c.name || i.c.id, html: (i) => custLink(i.c), wrap: true },
    { key: "amount", label: `${amtWord()} (${cur})`, num: true, value: (i) => amtOf(i), html: (i) => esc(F.money(amtOf(i), i.cur)) },
    { key: "type", label: t("sales.col.type"), value: (i) => `${i.origin || ""}${i.credit ? " " + t("cust.credit") : ""}`,
      html: (i) => `${i.origin ? `<span class="pill ok">${esc(i.origin)}</span>` : ""}${i.credit ? ` <span class="pill warn">${esc(t("cust.credit"))}</span>` : ""}` },
    { key: "manager", label: t("col.manager"), value: (i) => pmName(pmKey(i.c)), html: (i) => pmLink(pmKey(i.c)) },
    { key: "clerk", label: t("byShort.clerk"), value: (i) => i.clerk || "" },
  ];
  const invRows = drawTable($("#sales-inv", host), { id: "sales-invoices", sortParam: "isort", defaultSort: "-date", rows: list, pageSize: 25,
    columns: invColumns, totals: esc(`${t("sales.invTotal")}: ${F.money(total / 100, cur)}`) });
  return { g, cur, periods, range, invColumns, invRows };
}

/* ---------- import status page ---------- */

function renderStatus(main) {
  const m = S.meta;
  const st = importStatus();
  const exported = new Date(m.exported_at || m.generated_at), imported = new Date(m.generated_at);
  const src = m.sources || {};
  const blocked = src.customers?.skipped_blocked || 0, blockedInv = src.invoices?.skipped_blocked || 0;
  const stateText = st.failed ? t("chk.failed", { n: st.failed }) : st.stale ? t("status.stale") : st.count ? t("status.warnings", { n: F.num(st.count) }) : t("status.okShort");
  const stateCls = st.stale ? "delta-down" : st.count ? "" : "status-ok";
  const tile = (label, value, sub, hl = false) =>
    `<div class="kpi${hl ? " hl" : ""}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${esc(sub)}</div></div>`;
  const shown = m.warnings || [];
  const cfgRows = Object.entries(m.config || {}).map(([name, path]) => `<div><dt class="mono">${esc(name)}</dt>
    <dd class="${path.includes("config.example") ? "none" : ""}">${esc(path.includes("config.example") ? t("status.configDefault") : t("status.configOwn"))}</dd></div>`).join("");

  main.innerHTML = `
    <section class="kpis">
      ${tile(t("status.state"), `<span class="${stateCls}">${esc(stateText)}</span>`, st.failed ? t("chk.failedSub") : st.stale ? t("banner.stale", { n: Math.round(st.hours) }) : "", true)}
      ${tile(t("status.exported"), esc(F.date(isoDate(exported))), `${F.dateTime(exported)} · ${agoText(Date.now() - exported)}`)}
      ${tile(t("status.imported"), esc(F.date(isoDate(imported))), `${F.dateTime(imported)} · ${agoText(Date.now() - imported)}`)}
      ${tile(t("status.blocked"), esc(F.num(blocked)), blockedInv ? t("status.blockedInv", { n: F.num(blockedInv) }) : "")}
    </section>
    <div class="cust-grid">
      <section class="card">
        <div class="card-head"><h2>${esc(t("status.warningsTitle"))} (${esc(F.num(st.count))})</h2>
          ${shown.length > 8 ? `<input type="search" id="warn-filter" class="mono" placeholder="${esc(t("status.filter"))}" style="border:1px solid var(--border);border-radius:8px;padding:6px 10px;background:var(--surface)">` : ""}</div>
        ${st.stale ? `<div class="notice bad" style="margin-bottom:12px">${esc(t("banner.stale", { n: Math.round(st.hours) }))}</div>` : ""}
        ${shown.length ? `<ul class="warn-list" id="warn-list">${shown.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
          ${st.count > shown.length ? `<div class="card-foot">${esc(t("status.more", { n: F.num(st.count - shown.length) }))}</div>` : ""}`
          : `<div class="empty-state">${esc(t("status.noWarnings"))}</div>`}
        <div class="card-foot">${esc(t("status.log"))} <code class="mono">docker compose logs importer</code></div>
      </section>
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>${esc(t("chk.title"))}</h2><span class="sub">${esc(t("chk.sub"))}</span></div>
          <dl class="rows">${(S.checks || []).map((c) => `<div><dt>${c.ok ? '<span class="status-ok">✓</span>' : '<span class="delta-down">✗</span>'} ${esc(c.label)}<br>
            <span class="muted mono" style="font-size:11px">${esc(c.detail)}</span></dt><dd class="${c.ok ? "status-ok" : "delta-down"}">${esc(t(c.ok ? "chk.ok" : "chk.bad"))}</dd></div>`).join("")}</dl>
        </section>
        <section class="card">
          <div class="card-head"><h2>${esc(t("status.sources"))}</h2></div>
          <dl class="rows">${["customers", "invoices"].map((k) => src[k] ? `<div><dt>${esc(t("status.ds." + k))}<br><span class="mono muted">${esc(src[k].file)}</span></dt>
            <dd>${esc(t("status.rows", { n: F.num(src[k].rows) }))}<br><span class="muted" style="font-weight:400">${esc(F.dateTime(new Date(src[k].exported_at)))}</span></dd></div>`
            : `<div><dt>${esc(t("status.ds." + k))}</dt><dd class="none">${esc(t("status.noExport"))}</dd></div>`).join("")}
            ${src.invoices?.types ? `<div><dt>${esc(t("status.types"))}</dt><dd>${Object.entries(src.invoices.types).sort().map(([k, n]) => {
              const role = (src.invoices.invoice_types || []).includes(k) ? t("status.typeSales") : (src.invoices.offer_types || []).includes(k) ? t("status.typeOffer") : t("status.typeSkipped");
              return esc(`${k}: ${F.num(n)} – ${role}`);
            }).join("<br>")}</dd></div>` : ""}
            ${src.invoices?.kinds ? `<div><dt>${esc(t("status.kinds"))}</dt><dd>${Object.entries(src.invoices.kinds).map(([k, n]) => esc(`${k || "–"}: ${F.num(n)}`)).join("<br>")}</dd></div>` : ""}
            ${src.invoices?.duplicates_merged ? `<div><dt>${esc(t("status.merged"))}</dt><dd>${esc(F.num(src.invoices.duplicates_merged))}</dd></div>` : ""}
            ${src.invoices?.cancelled_flagged ? `<div><dt>${esc(t("status.cancelled"))}</dt><dd>${esc(F.num(src.invoices.cancelled_flagged))}</dd></div>` : ""}
            ${src.invoices && !src.invoices.has_payments ? `<div><dt>${esc(t("status.payments"))}</dt><dd class="none">${esc(t("status.noPayments"))}</dd></div>` : ""}</dl>
        </section>
        ${cfgRows ? `<section class="card"><div class="card-head"><h2>${esc(t("status.config"))}</h2></div><dl class="rows">${cfgRows}</dl></section>` : ""}
      </div>
    </div>`;
  $("#warn-filter")?.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll("#warn-list li").forEach((li) => { li.hidden = q && !li.textContent.toLowerCase().includes(q); });
  });
}

/* ---------- settings (stored in this browser) ---------- */

function renderSettings(main) {
  const row = (label, control, hint = "") => `<div class="set-row"><div><div class="set-label">${esc(label)}</div>${hint ? `<div class="muted set-hint">${esc(hint)}</div>` : ""}</div><div>${control}</div></div>`;
  main.innerHTML = `
    <section class="card help-intro"><h1>${esc(t("set.title"))}</h1><p>${esc(t("set.intro"))}</p></section>
    <section class="card">
      <div class="card-head"><h2>${esc(t("set.shared"))}</h2><span class="sub mono">config/idoszakok.toml</span></div>
      <div class="set-row"><div><div class="set-label">${esc(t("set.fiscal"))}</div><div class="muted set-hint">${esc(t("set.fiscalHint"))}</div></div>
        <div><b>${esc(new Intl.DateTimeFormat(F.loc, { month: "long" }).format(new Date(2026, fiscalStart(), 1)))}</b></div></div>
      <div class="table-wrap plain"><table>
        <thead><tr><th>${esc(t("set.name"))}</th><th>${esc(t("set.from"))}</th><th>${esc(t("set.to"))}</th><th></th></tr></thead>
        <tbody>${sharedPeriods().map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(F.date(c.from))}</td><td>${esc(F.date(c.to))}</td>
          <td class="num"><button type="button" class="link-btn" data-use-shared="${esc(c.id)}">${esc(t("set.use"))}</button></td></tr>`).join("")
          || `<tr class="empty-row"><td colspan="4">${esc(t("set.noShared"))}</td></tr>`}</tbody>
      </table></div>
      <div class="card-foot">${esc(t("set.sharedHint"))}</div>
    </section>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>${esc(t("set.periods"))}</h2><span class="sub">${esc(t("set.periodsSub"))}</span></div>
        <div class="table-wrap plain"><table>
          <thead><tr><th>${esc(t("set.name"))}</th><th>${esc(t("set.from"))}</th><th>${esc(t("set.to"))}</th><th></th></tr></thead>
          <tbody>${CUSTOM_PERIODS.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(F.date(c.from))}</td><td>${esc(F.date(c.to))}</td>
            <td class="num"><button type="button" class="link-btn" data-use="${esc(c.id)}">${esc(t("set.use"))}</button> ·
              <button type="button" class="link-btn danger" data-del="${esc(c.id)}">${esc(t("set.delete"))}</button></td></tr>`).join("")
            || `<tr class="empty-row"><td colspan="4">${esc(t("set.noPeriods"))}</td></tr>`}</tbody>
        </table></div>
        <form class="set-form" id="period-form">
          <input name="name" required maxlength="40" placeholder="${esc(t("set.namePh"))}">
          <input name="from" type="date" required aria-label="${esc(t("set.from"))}">
          <input name="to" type="date" required aria-label="${esc(t("set.to"))}">
          <button type="submit">${esc(t("set.add"))}</button>
        </form>
        <div class="card-foot" id="period-msg"></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>${esc(t("set.defaults"))}</h2></div>
        ${row(t("set.period"), `<span class="muted">${esc(periodOptionLabel(P.key))}</span>`, t("set.periodHint"))}
        ${row(t("set.newDays"), `<input type="number" id="new-days" min="1" max="365" value="${esc(CONFIG.newDays)}"> <span class="muted">${esc(t("set.days"))}</span>`, t("set.newDaysHint"))}
        ${row(t("theme"), `<select id="theme"><option value="auto">${esc(t("theme.auto"))}</option><option value="light">${esc(t("theme.light"))}</option>
          <option value="dark">${esc(t("theme.dark"))}</option></select>`)}
        ${row(t("lang"), `<select id="lang"><option value="hu">Magyar</option><option value="en">English</option></select>`)}
        <h3>${esc(t("set.reset"))}</h3>
        <div class="set-actions">
          <button type="button" class="secondary" data-act="cols">${esc(t("set.resetCols"))}</button>
          <button type="button" class="secondary" data-act="welcome">${esc(t("set.resetWelcome"))}</button>
          <button type="button" class="secondary" data-act="all">${esc(t("set.resetAll"))}</button>
        </div>
        <div class="card-foot" id="set-msg"></div>
      </section>
    </div>`;

  // the page may already be gone (e.g. a field's change event fires as you navigate away)
  const msg = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  $("#theme").value = document.documentElement.dataset.theme || "auto";
  $("#lang").value = LANG;
  $("#period-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target), name = String(f.get("name")).trim(), from = f.get("from"), to = f.get("to");
    if (!name || !from || !to) return;
    if (from > to) { msg("#period-msg", t("set.badRange")); return; }
    const id = Date.now().toString(36);
    CUSTOM_PERIODS.push({ id, name, from, to });
    saveJson("customPeriods", CUSTOM_PERIODS);
    applyPeriod(`c:${id}`); // use it right away
  });
  main.addEventListener("click", (e) => {
    const use = e.target.closest("[data-use]"), del = e.target.closest("[data-del]"), useShared = e.target.closest("[data-use-shared]");
    if (use) { applyPeriod(`c:${use.dataset.use}`); return; }
    if (useShared) { applyPeriod(`s:${useShared.dataset.useShared}`); return; }
    if (del) {
      CUSTOM_PERIODS = CUSTOM_PERIODS.filter((c) => c.id !== del.dataset.del);
      saveJson("customPeriods", CUSTOM_PERIODS);
      applyPeriod(P.key === `c:${del.dataset.del}` ? "ytd" : P.key);
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    try {
      if (act === "cols") Object.keys(localStorage).filter((k) => k.startsWith("cols:")).forEach((k) => localStorage.removeItem(k));
      if (act === "welcome") localStorage.removeItem("welcomed");
      if (act === "all") {
        ["settings", "customPeriods", "period", "welcomed", "theme", "lang"].forEach((k) => localStorage.removeItem(k));
        Object.keys(localStorage).filter((k) => k.startsWith("cols:")).forEach((k) => localStorage.removeItem(k));
        location.reload();
        return;
      }
    } catch { /* storage blocked */ }
    if (act) msg("#set-msg", t("set.done"));
  });
  $("#new-days").addEventListener("change", (e) => {
    const n = Math.round(+e.target.value);
    if (!(n >= 1 && n <= 365)) { e.target.value = CONFIG.newDays; return; }
    SETTINGS.newDays = n;
    saveJson("settings", SETTINGS);
    applyNewDays();
    index(S.data);
    S.checks = null;
    msg("#set-msg", t("set.saved"));
  });
}

/* ---------- help ---------- */

function renderHelp(main) {
  const sections = HELP[LANG] || HELP.hu;
  main.innerHTML = `
    <section class="card help-intro">
      <h1>${esc(t("help.title"))}</h1>
      <p>${t("help.intro")}</p>
    </section>
    <div class="grid-2 help">${sections.map((sec) => `<section class="card">
      <div class="card-head"><h2>${esc(sec.title)}</h2></div>
      <ul>${sec.items.map((item) => `<li>${item}</li>`).join("")}</ul>
    </section>`).join("")}</div>`;
}

/* First visit: a short welcome in the corner, pointing to the help tab.
   Hides itself after a while (not while the mouse or keyboard focus is on it). */
function showWelcome() {
  if (showWelcome.done) return;
  showWelcome.done = true;
  try { if (localStorage.getItem("welcomed")) return; localStorage.setItem("welcomed", "1"); } catch { /* shown, not remembered */ }
  if (current.view === "help") return;
  const box = document.createElement("div");
  box.className = "toast";
  box.setAttribute("role", "status");
  box.innerHTML = `<button type="button" class="toast-close" aria-label="${esc(t("welcome.close"))}">✕</button>
    <div class="toast-title">${esc(t("welcome.title"))}</div>
    <p>${esc(t("welcome.text"))}</p>
    <a href="#help" class="toast-link">${HELP_ICON}<span>${esc(t("welcome.open"))}</span></a>
    <span class="toast-timer"></span>`;
  document.body.append(box);
  let left = 12000, last = Date.now(), timer;
  const hide = () => { clearInterval(timer); box.classList.add("toast-out"); setTimeout(() => box.remove(), 300); };
  const paused = () => box.matches(":hover") || box.contains(document.activeElement);
  timer = setInterval(() => {
    const now = Date.now();
    if (!paused()) left -= now - last;
    last = now;
    box.style.setProperty("--left", Math.max(0, left / 12000));
    if (left <= 0) hide();
  }, 100);
  box.querySelector(".toast-close").addEventListener("click", hide);
  box.querySelector(".toast-link").addEventListener("click", hide);
}

/* ---------- global search (top bar) ---------- */

function searchCustomers(q, limit = 8) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const words = s.split(/\s+/);
  const scored = [];
  for (const c of S.customers) {
    if (!words.every((w) => c._s.includes(w))) continue;
    const name = (c.name || "").toLowerCase();
    const score = c.id === q.trim() ? 0 : c.id.startsWith(s) ? 1 : name.startsWith(s) ? 2 : (c.search_term || "").toLowerCase().startsWith(s) ? 3 : 4;
    scored.push([score, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || (a[1].name || "").localeCompare(b[1].name || "", F.loc));
  return scored.slice(0, limit).map(([, c]) => c);
}

(function setupSearch() {
  const input = $("#global-q"), list = $("#suggest");
  let items = [], sel = -1;
  const close = () => { list.hidden = true; sel = -1; input.setAttribute("aria-expanded", "false"); };
  const draw = () => {
    if (!items.length) return close();
    list.innerHTML = items.map((c, i) => `<li role="option" data-id="${esc(c.id)}" aria-selected="${i === sel}">
      <span class="sid">${esc(c.id)}</span><span class="sname">${esc(c.name || "")}</span><span class="scity">${esc(c.city || "")}</span></li>`).join("");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };
  const go = (c) => { close(); input.value = ""; input.blur(); location.hash = customerHref(c.id); };
  input.addEventListener("input", () => { items = searchCustomers(input.value); sel = -1; draw(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      draw();
    } else if (e.key === "Escape") close();
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) { e.preventDefault(); go(S.byId.get(li.dataset.id)); }
  });
  input.addEventListener("blur", () => setTimeout(close, 100));
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    // Exact customer number, selected suggestion, or a single match opens the customer; else the filtered list
    const exact = S.byId.get(q);
    const pick = exact || (sel >= 0 ? items[sel] : null) || (searchCustomers(q, 2).length === 1 ? searchCustomers(q, 1)[0] : null);
    if (pick) go(pick);
    else { close(); location.hash = `#customers?q=${encodeURIComponent(q)}`; input.value = ""; }
  });
})();

/* ---------- global events ---------- */

window.addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-href]");
  if (el) { tip.hidden = true; location.hash = el.dataset.href; }
});

/* Period picker (top bar): the default period everywhere; remembered per browser. */
function renderPeriodSelect() {
  const sel = $("#period");
  const opt = (k) => `<option value="${esc(k)}"${k === P.key ? " selected" : ""}>${esc(periodOptionLabel(k))}</option>`;
  sel.innerHTML = PERIOD_KEYS.map(opt).join("") +
    (sharedPeriods().length ? `<optgroup label="${esc(t("per.shared"))}">${sharedPeriods().map((c) => opt(`s:${c.id}`)).join("")}</optgroup>` : "") +
    (CUSTOM_PERIODS.length ? `<optgroup label="${esc(t("per.custom"))}">${CUSTOM_PERIODS.map((c) => opt(`c:${c.id}`)).join("")}</optgroup>` : "") +
    `<option value="__manage">${esc(t("per.manage"))}</option>`;
  renderAmtSwitch();
  sel.closest("label").title = `${t("per.title")}: ${F.date(P.from)} – ${F.date(P.to)}` +
    (P.prevFrom ? `\n${t("per.compare")}: ${F.date(P.prevFrom)} – ${F.date(P.prevTo)}` : "");
}
/* Net / gross switch (top bar), remembered per browser like the period. */
function renderAmtSwitch() {
  const box = $("#amt");
  box.setAttribute("aria-label", t("amt.title"));
  box.title = t("amt.hint");
  box.innerHTML = [["net", t("sales.net")], ["gross", t("sales.gross")]].map(([v, l]) =>
    `<button type="button" data-value="${v}" aria-pressed="${(v === "gross") === isGross()}">${esc(l)}</button>`).join("");
}
$("#amt").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-value]");
  if (!b || b.dataset.value === SETTINGS.amount) return;
  SETTINGS.amount = b.dataset.value;
  saveJson("settings", SETTINGS);
  renderAmtSwitch();
  if (!S.meta) return;
  index(S.data);
  route();
});
function applyPeriod(key) {
  try { localStorage.setItem("period", key); } catch { /* not remembered */ }
  index(S.data);
  S.checks = null;
  renderPeriodSelect();
  route();
}
$("#period").addEventListener("change", (e) => {
  if (e.target.value === "__manage") { e.target.value = P.key; location.hash = "#settings"; return; }
  applyPeriod(e.target.value);
});

/* Theme: "auto" follows the OS setting (the default); light/dark override it.
   The colours are CSS variables, so no re-render is needed. */
document.addEventListener("change", (e) => {
  if (e.target.id !== "theme") return;
  const v = e.target.value;
  if (v === "light" || v === "dark") document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
  try { if (v === "auto") localStorage.removeItem("theme"); else localStorage.setItem("theme", v); } catch { /* not saved */ }
});

document.addEventListener("change", (e) => {
  if (e.target.id !== "lang") return;
  setLang(e.target.value);
  buildFormatters();
  renderChrome();
  P = buildPeriod(P.key);
  renderPeriodSelect();
  route();
});

// Tooltips for anything with data-tip
const tip = $("#tooltip");
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
});
document.addEventListener("mousemove", (e) => {
  if (tip.hidden) return;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(e.clientX + 14, innerWidth - r.width - 8) + "px";
  tip.style.top = (e.clientY + 14 + r.height > innerHeight ? e.clientY - r.height - 10 : e.clientY + 14) + "px";
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (["overview", "customer", "manager", "sales", "managers"].includes(current.view) && S.meta) route(); }, 250);
});

buildFormatters();
applyStaticText();
load();
setInterval(poll, CONFIG.pollMinutes * 60000);
