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
const PERIOD = {
  new: daysAgo(CONFIG.newDays - 1),
  prevNew: daysAgo(CONFIG.newDays * 2 - 1),
  ytd: `${YEAR}-01-01`,
  prevYtd: `${YEAR - 1}-01-01`,
  prevYtdEnd: `${YEAR - 1}${TODAY.slice(4)}`,
};

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
    index(data);
    S.checks = null; // recomputed for the new data
    renderChrome();
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
  for (const c of S.customers) c.st = customerStats(c);

  S.managers = new Map();
  for (const c of S.customers) {
    const k = pmKey(c);
    if (!S.managers.has(k)) S.managers.set(k, { key: k, customers: [], count: 0, new30: 0, newYtd: 0, foreign: 0, last: null,
      ytd: new Map(), prev: new Map(), total: new Map(), open: new Map(), active: 0, activePrev: 0, invoices: [] });
    const m = S.managers.get(k);
    m.customers.push(c);
    m.count++;
    if (c.isNew) m.new30++;
    if (c.created && c.created >= PERIOD.ytd) m.newYtd++;
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
  for (const m of S.managers.values()) m._s = pmName(m.key).toLowerCase();
}

/* Per-customer invoice figures, per currency in cents. */
function customerStats(c) {
  const st = { ytd: new Map(), prev: new Map(), total: new Map(), open: new Map(), byYear: new Map(),
    openN: 0, overdueN: 0, firstYear: null, lastYear: null, ytdCount: 0, ytdCredits: 0, prevCount: 0, count: 0, firstDate: null };
  const counts = new Map();
  for (const i of c.invoices) {
    const v = cents(i.net);
    counts.set(i.cur, (counts.get(i.cur) || 0) + 1);
    addTo(st.total, i.cur, v);
    st.count++;
    if (i.date && (!st.firstDate || i.date < st.firstDate)) st.firstDate = i.date;
    if (i.date >= PERIOD.ytd) { if (i.credit) st.ytdCredits++; else st.ytdCount++; }
    if (i.date >= PERIOD.prevYtd && i.date <= PERIOD.prevYtdEnd) st.prevCount++;
    if (i.date) {
      const y = +i.date.slice(0, 4);
      if (!st.byYear.has(y)) st.byYear.set(y, new Map());
      addTo(st.byYear.get(y), i.cur, v);
      st.firstYear = Math.min(st.firstYear ?? y, y);
      st.lastYear = Math.max(st.lastYear ?? y, y);
      if (i.date >= PERIOD.ytd) addTo(st.ytd, i.cur, v);
      if (i.date >= PERIOD.prevYtd && i.date <= PERIOD.prevYtdEnd) addTo(st.prev, i.cur, v);
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

const VIEWS = ["overview", "sales", "managers", "customers", "customer", "manager", "status"];
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

function route() {
  if (!S.meta) return;
  current = parseHash();
  renderTabs();
  const main = $("#view");
  main.innerHTML = "";
  viewUpdate = null;
  ({ overview: renderOverview, sales: renderSales, managers: renderManagers, customers: renderCustomers,
    customer: renderCustomer, manager: renderManager, status: renderStatus })[current.view](main);
  if (current.view === "customer" || current.view === "manager") window.scrollTo(0, 0);
}

const customerHref = (id) => `#customer?id=${encodeURIComponent(id)}`;

/* ---------- page chrome ---------- */

function applyStaticText() {
  document.documentElement.lang = LANG;
  document.title = t("app.title");
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $("#lang").value = LANG;
  $("#theme").value = document.documentElement.dataset.theme || "auto";
  $("#theme").setAttribute("aria-label", t("theme"));
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

function renderTabs() {
  const active = current.view === "customer" ? "customers" : current.view === "manager" ? "managers" : current.view;
  const st = importStatus();
  const label = st.failed ? t("chk.failed", { n: st.failed }) : st.stale ? t("status.stale") : st.count ? t("status.warnings", { n: st.count }) : t("status.ok");
  $("#tabs").innerHTML = TABS.map((v) =>
    `<a href="#${v}"${v === active ? ' aria-current="page"' : ""}>${esc(t("nav." + v))}</a>`).join("") +
    `<a href="#status" class="tab-icon${st.stale ? " bad" : st.count ? " warn" : ""}"${active === "status" ? ' aria-current="page"' : ""}
      title="${esc(`${t("nav.status")}: ${label}`)}" aria-label="${esc(`${t("nav.status")}: ${label}`)}">${WARN_ICON}${
      st.count || st.stale ? `<span class="count">${st.stale && !st.count ? "!" : esc(F.num(st.count))}</span>` : ""}</a>`;
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
    const sum = src.rows + (src.skipped_rows || 0) + src.skipped_blocked + src.duplicates_merged;
    add(t("chk.rows"), sum === src.raw_rows, t("chk.rowsDetail", { raw: F.num(src.raw_rows), rows: F.num(src.rows), skipped: F.num(src.skipped_rows || 0),
      blocked: F.num(src.skipped_blocked), merged: F.num(src.duplicates_merged) }));
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
  const { rows, defaultSort, total = rows.length, totals = "", id = current.view, pageSize = CONFIG.pageSize } = opts;
  const layout = loadLayout(id);
  const columns = layoutColumns(id, opts.columns);
  const widths = layout.widths || {};
  const fixed = Object.keys(widths).length > 0;
  const sp = current.params.get("sort") || defaultSort;
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
      setParams({ sort: sp.replace(/^-/, "") === k && !desc ? "-" + k : k });
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
  const newYtd = all.filter((c) => between(c, PERIOD.ytd, TODAY)).length;
  const prevYtd = all.filter((c) => between(c, PERIOD.prevYtd, PERIOD.prevYtdEnd)).length;
  const noPm = S.managers.get(NONE)?.count || 0;
  const foreign = all.filter((c) => c.country && c.country !== CONFIG.homeCountry);
  const pmCount = [...S.managers.keys()].filter((k) => k !== NONE).length;

  const tile = (href, label, value, sub, hl = false) =>
    `<a class="kpi${hl ? " hl" : ""}" href="${href}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></a>`;
  const deltaHtml = (now, prev, key = "cust.vsPrev") => (prev
    ? `<span class="${now >= prev ? "delta-up" : "delta-down"}">${esc(t(key, { pct: F.signedPct((now - prev) / Math.abs(prev)) }))}</span>` : "");
  const big = (v) => { const p = F.compactParts(v, "HUF"); return `${esc(p.num)}<span class="unit">${esc(p.unit)}</span>`; };
  const pmItems = [...S.managers.values()].sort((a, b) => b.count - a.count).map((m) => ({
    label: pmLink(m.key), value: m.count,
    tip: `${pmName(m.key)}\n${t("chart.customersN", { n: F.num(m.count) })}\n${t("col.newYtd")}: ${m.newYtd}`,
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
      ${tile(`#customers?from=${PERIOD.new}`, t("kpi.new30"), esc(F.num(new30)), esc(t("kpi.vsPrev30", { n: F.num(prev30) })))}
      ${tile(`#customers?pm=${NONE}`, t("kpi.noManager"), esc(F.num(noPm)), esc(t("kpi.noManagerSub")))}`;

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
        ${tile(`#customers?from=${PERIOD.ytd}`, t("kpi.newYtd"), esc(F.num(newYtd)), esc(t("kpi.vsPrevYtd", { n: F.num(prevYtd) })))}
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
  const from12 = isoDate(new Date(YEAR, NOW.getMonth() - 11, 1));
  const keys = periodKeys(from12, TODAY, "month");
  const per = new Map(keys.map((k) => [k, { v: 0, prev: 0 }]));
  const pFrom = shiftIsoYear(from12, -1), pTo = shiftIsoYear(TODAY, -1);
  let ytd = 0, prevYtdSales = 0, lm = 0, lmPrev = 0;
  const active = new Set(), activePrev = new Set();
  const byIndustry = new Map(), byRegion = new Map(), byCurrency = new Map(), curCount = new Map();
  for (const i of S.invoices) {
    if (!i.date) continue;
    if (i.date >= PERIOD.ytd) {
      active.add(i.c);
      addTo(byCurrency, i.cur, cents(i.net));
      if (!i.credit) curCount.set(i.cur, (curCount.get(i.cur) || 0) + 1);
    } else if (i.date >= PERIOD.prevYtd && i.date <= PERIOD.prevYtdEnd) activePrev.add(i.c);
    if (i.cur !== "HUF") continue;
    const v = cents(i.net), k = periodKey(i.date, "month");
    if (i.date >= PERIOD.ytd) {
      ytd += v;
      addTo(byIndustry, i.c.industryLabel || "", v);
      addTo(byRegion, i.c.regionLabel || "", v);
    } else if (i.date >= PERIOD.prevYtd && i.date <= PERIOD.prevYtdEnd) prevYtdSales += v;
    if (k === lmKey) lm += v;
    if (k === lmPrevKey) lmPrev += v;
    if (i.date >= from12 && per.has(k)) per.get(k).v += v;
    if (i.date >= pFrom && i.date <= pTo) { const row = per.get(shiftKeyYear(k, 1)); if (row) row.prev += v; }
  }
  const money = (v) => compactMoney(v, "HUF");
  const salesItems = (map, param, label) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, CONFIG.topN).map(([k, v]) => ({
    label: k ? `<a href="#sales?r=ytd&${param}=${encodeURIComponent(k)}">${esc(label(k))}</a>` : `<span class="muted">${esc(t("none"))}</span>`,
    value: v / 100, tip: `${k ? label(k) : t("none")}\n${F.money(v / 100, "HUF")}\n${F.pct(ytd ? v / ytd : 0)}`,
  }));
  const topCustomers = all.map((c) => [c, c.st.ytd.get("HUF") || 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, CONFIG.topN)
    .map(([c, v]) => ({ label: custLink(c), value: v / 100, tip: `${c.name}\n${F.money(v / 100, "HUF")}\n${F.pct(ytd ? v / ytd : 0)}` }));
  const managerSales = [...S.managers.values()].map((m) => [m, m.ytd.get("HUF") || 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    .map(([m, v]) => ({ label: pmLink(m.key), value: v / 100, tip: `${pmName(m.key)}\n${F.money(v / 100, "HUF")}\n${F.pct(ytd ? v / ytd : 0)}` }));
  const lmLabel = F.monthYear(lmKey);

  main.innerHTML = `
    <section class="kpis">
      ${tile("#sales?r=ytd", t("kpi.salesYtd", { year: YEAR }), big(ytd / 100), deltaHtml(ytd, prevYtdSales), true)}
      ${tile(`#sales?from=${lmStart}&to=${addDays(periodStart(periodKey(TODAY, "month"), "month"), -1)}&g=day`, t("ov.lastMonth", { month: lmLabel }), big(lm / 100), deltaHtml(lm, lmPrev, "ov.vsPrevMonth"))}
      ${tile("#sales?r=ytd&by=customer", t("ov.active", { year: YEAR }), esc(F.num(active.size)), esc(t("ov.activeSub", { n: F.num(activePrev.size) })))}
      ${customerTiles}
    </section>
    <section class="card chart">
      <div class="card-head"><h2>${esc(t("ov.monthly"))}</h2><a class="sub" href="#sales">${esc(t("ov.details"))}</a></div>
      <div class="legend"><span><i style="background:var(--bar)"></i>${esc(t("ov.last12"))}</span><span><i style="background:var(--bar-muted)"></i>${esc(t("sales.prevYear"))}</span></div>
      <div id="ov-monthly"></div>
      <div class="card-foot">${esc(t("ov.hufNote"))}</div>
    </section>
    <div class="grid-2">
      <section class="card"><div class="card-head"><h2>${esc(t("ov.topCustomers", { year: YEAR }))}</h2><a class="sub" href="#sales?r=ytd&by=customer">${esc(t("ov.all"))}</a></div>${hbars(topCustomers, money)}</section>
      <section class="card"><div class="card-head"><h2>${esc(t("ov.byManager", { year: YEAR }))}</h2><a class="sub" href="#sales?r=ytd&by=manager">${esc(t("ov.all"))}</a></div>${hbars(managerSales, money)}</section>
    </div>
    <div class="grid-3">
      <section class="card"><div class="card-head"><h2>${esc(t("ov.byIndustry", { year: YEAR }))}</h2></div>${hbars(salesItems(byIndustry, "industry", (k) => k), money)}</section>
      <section class="card"><div class="card-head"><h2>${esc(t("ov.byRegion", { year: YEAR }))}</h2></div>${hbars(salesItems(byRegion, "region", (k) => k), money)}</section>
      <section class="card"><div class="card-head"><h2>${esc(t("ov.byCurrency", { year: YEAR }))}</h2></div>
        <dl class="rows">${currencyOrder().filter((c) => byCurrency.has(c)).map((c) => `<div><dt><a href="#sales?r=ytd&cur=${encodeURIComponent(c)}"><b>${esc(c)}</b></a>
          <span class="muted"> · ${esc(t("ov.invoicesN", { n: F.num(curCount.get(c) || 0) }))}</span></dt><dd>${esc(F.money(byCurrency.get(c) / 100, c))}</dd></div>`).join("")}</dl>
        <div class="card-foot">${esc(t("ov.curNote"))}</div></section>
    </div>
    <div class="grid-2">
      ${newChartCard}
      ${latestCard}
    </div>`;
  drawPeriodChart($("#ov-monthly"), { keys, g: "month", values: keys.map((k) => per.get(k).v / 100), prev: keys.map((k) => per.get(k).prev / 100),
    cur: "HUF", mode: "compare", label: t("ov.monthly") });
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
    svg += `<rect class="band" x="${m.l + bw * k}" y="${m.t}" width="${bw}" height="${ph}" data-tip="${esc(`${F.monthYear(mo)}\n${t("chart.newN", { n: vals[k] })}`)}"/>`;
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
      { key: "active", label: t("mgr.col.active", { year: YEAR }), num: true, value: (m) => m.active },
      { key: "ytd", label: t("mgr.col.ytd", { year: YEAR }), num: true, value: (m) => hufOf(m.ytd), html: (m) => esc(F.money(hufOf(m.ytd), "HUF")) },
      { key: "prev", label: t("mgr.col.prev"), num: true, value: (m) => hufOf(m.prev), html: (m) => `<span class="muted">${esc(F.money(hufOf(m.prev), "HUF"))}</span>` },
      { key: "change", label: t("sales.col.change"), num: true, value: (m) => (hufOf(m.prev) ? (hufOf(m.ytd) - hufOf(m.prev)) / Math.abs(hufOf(m.prev)) : null),
        html: (m) => changeHtml(hufOf(m.ytd), hufOf(m.prev)) },
      { key: "salesShare", label: t("mgr.col.share"), num: true, value: (m) => (totalHuf ? (m.ytd.get("HUF") || 0) / totalHuf : 0),
        html: (m) => esc(F.pct(totalHuf ? (m.ytd.get("HUF") || 0) / totalHuf : 0)) },
      { key: "other", label: t("mgr.col.other"), value: (m) => moneyList(new Map([...m.ytd].filter(([c]) => c !== "HUF"))),
        html: (m) => `<span class="muted">${esc(moneyList(new Map([...m.ytd].filter(([c]) => c !== "HUF"))))}</span>` });
    if (S.hasPayments) cols.push({ key: "open", label: t("col.openNet"), num: true, value: (m) => hufOf(m.open), html: (m) => esc(moneyList(m.open)), csv: (m) => moneyList(m.open) });
  } else {
    cols.push({ key: "share", label: t("col.share"), num: true, value: (m) => m.count / totalCustomers, html: (m) => esc(F.pct(m.count / totalCustomers)) });
  }
  cols.push(
    { key: "new30", label: t("col.new30"), num: true, value: (m) => m.new30, html: (m) => (m.new30 ? `<span class="badge new">${esc(F.num(m.new30))}</span>` : "0") },
    { key: "newYtd", label: t("col.newYtd"), num: true, value: (m) => m.newYtd },
    { key: "foreign", label: t("col.foreign"), num: true, value: (m) => m.foreign },
    { key: "last", label: t("col.lastCreated"), value: (m) => m.last, html: (m) => esc(F.date(m.last)) },
  );
  return cols;
}
const MANAGER_TABLE = "managers-v2";

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
  const bars = (list, value, fmt, tip) => hbars(list.filter((m) => value(m)).sort((a, b) => value(b) - value(a)).map((m) => ({ label: pmLink(m.key), value: value(m), tip: tip(m) })), fmt);
  main.insertAdjacentHTML("afterbegin", `
    <section class="kpis">
      ${tile(t("mgr.kpi.count"), esc(F.num(named.length)), esc(t("mgr.kpi.countSub", { n: F.num(S.customers.length) })), !S.hasInvoices)}
      ${S.hasInvoices ? tile(t("kpi.salesYtd", { year: YEAR }), big(totalYtd), changeHtml(totalYtd, totalPrev) + " " + esc(t("mgr.kpi.vsPrev")), true) : ""}
      ${tile(t("kpi.noManager"), esc(F.num(none?.count || 0)), S.hasInvoices && none ? esc(t("mgr.kpi.noneSales", { amount: compactMoney(hufOf(none.ytd), "HUF") })) : esc(t("kpi.noManagerSub")))}
      ${tile(t("mgr.kpi.avg"), esc(F.num(named.length ? Math.round(named.reduce((s, m) => s + m.count, 0) / named.length) : 0)), esc(t("mgr.kpi.avgSub")))}
    </section>
    <div class="grid-2">
      ${S.hasInvoices ? `<section class="card"><div class="card-head"><h2>${esc(t("ov.byManager", { year: YEAR }))}</h2><span class="sub">${esc(t("mgr.hufShort"))}</span></div>
        ${bars(managers, (m) => hufOf(m.ytd), (v) => compactMoney(v, "HUF"), (m) => `${pmName(m.key)}\n${F.money(hufOf(m.ytd), "HUF")}`)}</section>` : ""}
      <section class="card"><div class="card-head"><h2>${esc(t("chart.byManager"))}</h2></div>
        ${bars(managers, (m) => m.count, (v) => F.num(v), (m) => `${pmName(m.key)}\n${t("chart.customersN", { n: F.num(m.count) })}`)}</section>
    </div>`);
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
    if (k === lmKey) lm += cents(i.net);
    if (k === lmPrevKey) lmPrev += cents(i.net);
    if (i.date >= PERIOD.ytd) addTo(byIndustry, i.c.industryLabel || "", cents(i.net));
  }
  const top = [...m.customers].sort((a, b) => (b.st.ytd.get("HUF") || 0) - (a.st.ytd.get("HUF") || 0))[0];
  const topIndustry = [...byIndustry.entries()].sort((a, b) => b[1] - a[1])[0];
  const latest = [...m.customers].filter((c) => c.created).sort((a, b) => b.created.localeCompare(a.created)).slice(0, 6);
  const chip = (label, value, href) => `<a class="chip" href="${href}"><b>${esc(label)}</b>${esc(value)}</a>`;

  const kpis = S.hasInvoices ? [
    tile(t("kpi.salesYtd", { year: YEAR }), big(hufOf(m.ytd)), deltaText(hufOf(m.ytd), hufOf(m.prev)), true),
    tile(t("ov.lastMonth", { month: F.monthYear(lmKey) }), big(lm / 100), deltaText(lm, lmPrev, "ov.vsPrevMonth")),
    tile(t("ov.active", { year: YEAR }), esc(F.num(m.active)), esc(t("mgr.activeSub", { n: F.num(m.activePrev), all: F.num(m.count) }))),
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
          ${S.hasInvoices ? chip(t("mgr.chipActive", { year: YEAR }), F.num(m.active), `#sales?r=ytd&pm=${encodeURIComponent(key)}`) : ""}
          ${chip(t("col.foreign"), F.num(m.foreign), `#customers?pm=${encodeURIComponent(key)}&sort=country`)}
        </div>
      </div>
      <div class="cust-contact">
        ${S.hasInvoices ? `<div class="eyebrow">${esc(t("mgr.topCustomer", { year: YEAR }))}</div><div>${top && top.st.ytd.get("HUF") ? `${custLink(top)} · ${esc(compactMoney(hufOf(top.st.ytd), "HUF"))}` : "–"}</div>
        <div class="eyebrow">${esc(t("mgr.topIndustry", { year: YEAR }))}</div><div>${topIndustry ? `${esc(topIndustry[0] || t("none"))} · ${esc(compactMoney(topIndustry[1] / 100, "HUF"))}` : "–"}</div>` : ""}
      </div>
    </section>
    <section class="kpis">${kpis.join("")}</section>
    <div class="cust-grid">
      <div class="stack">
        ${S.hasInvoices ? `<section class="card chart">
          <div class="card-head"><h2>${esc(t("cust.revenueBy"))}</h2>${granSwitch(custGran(), CUST_GRANS)}</div>
          <div id="mgr-chart"></div><div class="card-foot">${esc(t("mgr.chartFoot"))}</div>
        </section>` : ""}
        <section class="card">
          <div class="card-head"><h2>${esc(t("d.customersOf"))} (${esc(F.num(m.count))})</h2><a class="sub" href="#sales?r=ytd&by=customer&pm=${encodeURIComponent(key)}">${S.hasInvoices ? esc(t("mgr.toSales")) : ""}</a></div>
          <div id="mgr-customers"></div>
        </section>
      </div>
      <div class="stack">
        ${S.hasInvoices ? `<section class="card"><div class="card-head"><h2>${esc(t("ov.byCurrency", { year: YEAR }))}</h2></div>
          <dl class="rows">${currencyOrder().filter((c) => m.ytd.has(c)).map((c) => `<div><dt><a href="#sales?r=ytd&cur=${encodeURIComponent(c)}&pm=${encodeURIComponent(key)}"><b>${esc(c)}</b></a></dt>
            <dd>${esc(F.money(m.ytd.get(c) / 100, c))}</dd></div>`).join("") || `<div><dt>${esc(t("t.empty"))}</dt><dd></dd></div>`}</dl></section>
        <section class="card"><div class="card-head"><h2>${esc(t("ov.byIndustry", { year: YEAR }))}</h2><span class="sub">${esc(t("mgr.hufShort"))}</span></div>
          ${hbars([...byIndustry.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: esc(k || t("none")), value: v / 100, tip: `${k || t("none")}\n${F.money(v / 100, "HUF")}` })), (v) => compactMoney(v, "HUF"))}</section>` : ""}
        <section class="card"><div class="card-head"><h2>${esc(t("chart.latest"))}</h2></div>
          <dl class="rows">${latest.map((c) => `<div><dt>${custLink(c)}</dt><dd class="none">${newBadge(c)}</dd></div>`).join("") || `<div><dt>${esc(t("t.empty"))}</dt><dd></dd></div>`}</dl></section>
      </div>
    </div>`;

  if (S.hasInvoices) {
    drawInvoicePeriods($("#mgr-chart"), m.invoices, "HUF");
    onGranSwitch(main, () => drawInvoicePeriods($("#mgr-chart"), m.invoices, "HUF"));
  }
  const money = (c, map) => F.money(c.st.main(map) || null, c.st.cur) + (c.st.others(map).size ? " +" : "");
  const cols = [
    { key: "name", label: t("col.name"), value: (c) => c.name, html: (c) => custLink(c), wrap: true },
    ...(S.hasInvoices ? [
      { key: "ytd", label: t("col.revenueYtd", { year: YEAR }), num: true, value: (c) => c.st.main(c.st.ytd) || null, html: (c) => esc(money(c, c.st.ytd)) },
      { key: "change", label: t("sales.col.change"), num: true, value: (c) => (c.st.main(c.st.prev) ? (c.st.main(c.st.ytd) - c.st.main(c.st.prev)) / Math.abs(c.st.main(c.st.prev)) : null),
        html: (c) => `<span title="${esc(`${t("mgr.col.prev")}: ${money(c, c.st.prev)}`)}">${changeHtml(c.st.main(c.st.ytd), c.st.main(c.st.prev))}</span>` },
      { key: "inv", label: t("mgr.col.invoices", { year: YEAR }), num: true, value: (c) => c.st.ytdCount },
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
    cols.push({ key: "ytd", label: t("col.revenueYtd", { year: YEAR }), num: true, value: (c) => c.st.main(c.st.ytd) || null, html: (c) => esc(money(c, c.st.ytd)), csv: (c) => moneyList(c.st.ytd) });
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
      kpiTile(t("cust.revenueYtd", { year: YEAR }), bigMoney(ytd, st.cur),
        (delta == null ? esc(t("cust.noPrev")) : `<span class="${delta >= 0 ? "delta-up" : "delta-down"}">${esc(t("cust.vsPrev", { pct: F.signedPct(delta) }))}</span>`) + others(st.ytd), true),
      S.hasPayments
        ? kpiTile(t("cust.openInvoices"), bigMoney(st.main(st.open), st.cur),
          esc(st.overdueN ? t("cust.overdueCount", { n: st.openN, o: st.overdueN }) : t("cust.openCount", { n: st.openN })) + others(st.open))
        : kpiTile(t("cust.invoicesYtd", { year: YEAR }), esc(F.num(st.ytdCount)),
          esc([st.ytdCredits ? t("cust.creditCount", { n: st.ytdCredits }) : "", t("cust.invoiceCountAll", { n: F.num(st.count) })].filter(Boolean).join(" · "))),
      termsTile,
      kpiTile(t("cust.revenueTotal"), bigMoney(st.main(st.total), st.cur), esc(yearsSpan) + others(st.total)),
    ];
  } else {
    const empty = (label) => kpiTile(label, `<span class="empty">–</span>`, esc(t("cust.noExport")));
    kpis = [empty(t("cust.revenueYtd", { year: YEAR })), empty(t("cust.invoicesYtd", { year: YEAR })), termsTile, empty(t("cust.revenueTotal"))];
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
    <thead><tr><th>${esc(t("col.invNumber"))}</th><th>${esc(t("col.invDate"))}</th><th class="num">${esc(t("col.net"))}</th><th></th></tr></thead>
    <tbody>${shown.map((i) => `<tr><td class="mono">${esc(i.id)}</td><td>${esc(F.date(i.date))}</td>
      <td class="num">${esc(F.money(i.net, i.cur))}</td><td>${i.credit ? `<span class="pill warn">${esc(t("cust.credit"))}</span>` : ""}</td></tr>`).join("")}</tbody>
  </table></div>
  <div class="card-foot"><a href="#sales?r=all&g=month&q=${encodeURIComponent(c.id)}">${esc(t("cust.allSales", { n: F.num(c.invoices.length) }))}</a></div>`;
}

/* Customer sales chart: the last few periods, the current one highlighted. */
const CUST_GRANS = ["year", "half", "quarter", "month"];
const CUST_PERIODS = { year: 5, half: 8, quarter: 12, month: 24 };
const custGran = () => (CUST_GRANS.includes(current.params.get("g")) ? current.params.get("g") : "year");
function granSwitch(active, grans) {
  return `<div class="seg" role="group" aria-label="${esc(t("sales.gran"))}">${grans.map((g) =>
    `<button type="button" data-gran="${g}" aria-pressed="${g === active}">${esc(t("gran." + g))}</button>`).join("")}</div>`;
}
function drawCustomerPeriods(host, c) { drawInvoicePeriods(host, c.invoices, c.st.cur); }
/* The last few periods of these invoices in one currency, the current period highlighted. */
function drawInvoicePeriods(host, invoices, cur) {
  const g = custGran();
  const first = invoices.reduce((a, i) => (i.cur === cur && i.date && (!a || i.date < a) ? i.date : a), null) || TODAY;
  const keys = periodKeys(first, TODAY, g).slice(-CUST_PERIODS[g]);
  const sums = new Map();
  for (const i of invoices) if (i.cur === cur && i.date) addTo(sums, periodKey(i.date, g), cents(i.net));
  drawPeriodChart(host, { keys, g, values: keys.map((k) => (sums.get(k) || 0) / 100), cur, mode: "highlight", label: t("cust.revenueBy") });
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
    <thead><tr><th>${esc(t("col.invNumber"))}</th><th>${esc(t("col.invDate"))}</th><th class="num">${esc(t("col.net"))}</th><th>${esc(t("col.due"))}</th><th>${esc(t("col.state"))}</th></tr></thead>
    <tbody>${shown.map((i) => `<tr><td class="mono">${esc(i.id)}</td><td>${esc(F.date(i.date))}</td>
      <td class="num">${esc(F.money(i.net, i.cur))}</td><td>${esc(F.date(i.dueEff))}${i.dueEstimated ? "*" : ""}</td><td>${pill(i)}</td></tr>`).join("")}</tbody>
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
function drawPeriodChart(host, { keys, g, values, prev = null, cur, mode = "highlight", label = "", height = 270 }) {
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
      tipLines.push(`${t("sales.prevYear")} (${periodLabel(shiftKeyYear(k, -1), g)}): ${F.money(prev[i], cur)}`);
      if (prev[i]) tipLines.push(`${t("sales.col.change")}: ${F.signedPct((values[i] - prev[i]) / Math.abs(prev[i]))}`);
    }
    svg += `<rect class="band" x="${m.l + bw * i}" y="${m.t}" width="${bw}" height="${ph}" data-tip="${esc(tipLines.join("\n"))}"/>`;
  });
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${svg}</svg>`;
}

/* ---------- sales view ---------- */

const RANGES = ["12m", "ytd", "ly", "3y", "all"];
const DEFAULT_GRAN = { "12m": "month", ytd: "month", ly: "month", "3y": "quarter", all: "year", custom: "month" };
const BREAKDOWNS = ["customer", "manager", "region", "industry", "country", "clerk"];

function salesRange(p) {
  const first = S.invoices.reduce((a, i) => (i.date && (!a || i.date < a) ? i.date : a), null) || TODAY;
  if (p.get("from") || p.get("to")) return { from: p.get("from") || first, to: p.get("to") || TODAY, preset: "custom" };
  const r = RANGES.includes(p.get("r")) ? p.get("r") : "12m";
  if (r === "ytd") return { from: PERIOD.ytd, to: TODAY, preset: r };
  if (r === "ly") return { from: `${YEAR - 1}-01-01`, to: `${YEAR - 1}-12-31`, preset: r };
  if (r === "3y") return { from: `${YEAR - 2}-01-01`, to: TODAY, preset: r };
  if (r === "all") return { from: first, to: TODAY, preset: r };
  return { from: isoDate(new Date(YEAR, NOW.getMonth() - 11, 1)), to: TODAY, preset: "12m" };
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

  main.innerHTML = `<div class="sales-view" style="display:contents">
    <section class="card sales-controls">
      <div class="ctl-row">
        <span class="ctl-label">${esc(t("sales.ctl.range"))}</span>
        ${pills("r", RANGES.map((r) => [r, t("range." + r)]), range0.preset)}
        <span class="ctl-dates">${fDate("from", "f.fromDate")}${fDate("to", "f.toDate")}</span>
      </div>
      <div class="ctl-row">
        <span class="ctl-label">${esc(t("sales.gran"))}</span>
        ${pills("g", GRANS.map((g) => [g, t("gran." + g)]), p.get("g") || DEFAULT_GRAN[range0.preset])}
        <span class="ctl-label">${esc(t("sales.ctl.amount"))}</span>
        ${pills("amt", [["net", t("sales.net")], ["gross", t("sales.gross")]], p.get("amt") || "net")}
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
    <div class="results" style="display:contents"></div>
  </div>`;
  const view = main.firstElementChild, host = $(".results", view), controls = $(".sales-controls", view);
  let state = {};
  const draw = () => {
    state = drawSales(host, currencies);
    // reflect the effective choices (defaults, custom dates) on the buttons
    controls.querySelectorAll('.seg[data-param="r"] button').forEach((b) => b.setAttribute("aria-pressed", b.dataset.value === state.preset));
    controls.querySelectorAll('.seg[data-param="g"] button').forEach((b) => b.setAttribute("aria-pressed", b.dataset.value === state.g));
  };
  const set = (updates) => { setParams(updates); tablePage["sales-by"] = 0; draw(); };

  // buttons: range, breakdown, amount, currency, "by"
  view.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg[data-param] button, .cur-switch[data-param] button");
    if (btn) {
      const group = btn.closest("[data-param]"), param = group.dataset.param, value = btn.dataset.value;
      if (param === "r") {
        controls.querySelectorAll('input[data-param="from"], input[data-param="to"]').forEach((i) => { i.value = ""; });
        set({ r: value, from: "", to: "", g: "" }); // a range brings its own default breakdown
      } else set({ [param]: value });
      group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === btn));
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "reset") {
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
  const g = GRANS.includes(p.get("g")) ? p.get("g") : DEFAULT_GRAN[range.preset];
  const cur = currencies.includes(p.get("cur")) ? p.get("cur") : (currencies.includes("HUF") ? "HUF" : currencies[0]);
  const amt = p.get("amt") === "gross" ? "gross" : "net";
  const by = BREAKDOWNS.includes(p.get("by")) ? p.get("by") : "customer";
  const amount = (i) => cents(amt === "gross" ? (i.gross ?? i.net) : i.net);
  const words = (p.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
  const customerOk = (c) =>
    (!p.get("pm") || pmKey(c) === p.get("pm")) && (!p.get("region") || c.regionLabel === p.get("region")) &&
    (!p.get("industry") || c.industryLabel === p.get("industry")) && (!p.get("country") || c.country === p.get("country")) &&
    words.every((w) => c._s.includes(w));
  const pFrom = shiftIsoYear(range.from, -1), pTo = shiftIsoYear(range.to, -1);

  const keys = periodKeys(range.from, range.to, g);
  const per = new Map(keys.map((k) => [k, { key: k, v: 0, prev: 0, n: 0, credits: 0 }]));
  const groups = new Map(), byCur = new Map();
  let total = 0, prevTotal = 0, count = 0, credits = 0, positive = 0;
  for (const i of S.invoices) {
    if (!i.date || !customerOk(i.c)) continue;
    const inRange = i.date >= range.from && i.date <= range.to;
    const inPrev = i.date >= pFrom && i.date <= pTo;
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
      if (i.credit) credits++; else { count++; grp.n++; positive += v; }
    }
    if (inPrev) {
      const row = per.get(shiftKeyYear(periodKey(i.date, g), 1));
      if (row) row.prev += v;
      prevTotal += v; grp.prev += v;
    }
  }
  const periods = [...per.values()];
  const big = (c) => { const x = F.compactParts(c / 100, cur); return `${esc(x.num)}<span class="unit">${esc(x.unit)}</span>`; };
  const tile = (label, value, sub, hl) => `<div class="kpi${hl ? " hl" : ""}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const change = (a, b) => (b ? `<span class="${a >= b ? "delta-up" : "delta-down"}">${esc(F.signedPct((a - b) / Math.abs(b)))}</span>` : "–");
  const rangeText = `${F.date(range.from)} – ${F.date(range.to)}`;
  const prevText = `${F.date(pFrom)} – ${F.date(pTo)}`;

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
          <tbody>${[...periods].reverse().map((r) => `<tr><td>${esc(periodLabel(r.key, g))}</td><td class="num">${esc(F.money(r.v / 100, cur))}</td>
            <td class="num muted">${esc(F.money(r.prev / 100, cur))}</td><td class="num">${change(r.v, r.prev)}</td><td class="num">${esc(F.num(r.n))}${r.credits ? ` <span class="muted">(−${r.credits})</span>` : ""}</td></tr>`).join("")}</tbody>
        </table></div>
      </section>
    </div>
    <section class="card">
      <div class="card-head"><h2>${esc(t("sales.breakdown"))}</h2>${pills("by", BREAKDOWNS.map((b) => [b, t("byShort." + b)]), by)}</div>
      <div id="sales-by"></div>
    </section>`;

  drawPeriodChart($("#sales-chart", host), { keys, g, values: periods.map((r) => r.v / 100), prev: periods.map((r) => r.prev / 100),
    cur, mode: "compare", label: t("sales.chart"), height: 240 });
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
  return { g, cur, periods, preset: range.preset };
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

/* Theme: "auto" follows the OS setting (the default); light/dark override it.
   The colours are CSS variables, so no re-render is needed. */
$("#theme").addEventListener("change", (e) => {
  const v = e.target.value;
  if (v === "light" || v === "dark") document.documentElement.dataset.theme = v;
  else delete document.documentElement.dataset.theme;
  try { if (v === "auto") localStorage.removeItem("theme"); else localStorage.setItem("theme", v); } catch { /* not saved */ }
});

$("#lang").addEventListener("change", (e) => {
  setLang(e.target.value);
  buildFormatters();
  renderChrome();
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
