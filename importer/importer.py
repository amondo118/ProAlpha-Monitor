"""Importer: turns the daily SAP CSV exports into the dashboard's clean data format.

Reads   /exports/*            SAP exports (read-only)
        /app/config/*.toml    column names and code lists (hand-edited)
Writes  /data/data.json and /data/meta.json   (served by nginx at /data/)

Every IMPORT_INTERVAL seconds it checks the exports AND the config files for
changes, and re-imports when anything changed. Each export is a full snapshot,
so the newest file of each kind replaces the previous data. Each file is
recognised by its column headers (see "felismeres" in oszlopok.toml).

If /exports is empty and FAKE_DATA=1, fake exports in the real format are
generated and imported with the same code (development).
"""

import json
import os
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import datasets
import fake_data
from sap_parse import read_table

EXPORTS = Path(os.environ.get("EXPORTS_DIR", "/exports"))
OUT = Path(os.environ.get("DATA_DIR", "/data"))
CONFIG = Path(os.environ.get("CONFIG_DIR", Path(__file__).resolve().parent.parent / "config"))
INTERVAL = int(os.environ.get("IMPORT_INTERVAL", "60"))
# Only import files that have not changed for this long, so a file SAP is
# still writing is never read half-finished.
STABLE_SECONDS = int(os.environ.get("STABLE_SECONDS", "60"))
FAKE = os.environ.get("FAKE_DATA", "0") == "1"
SCHEMA_VERSION = 4


def log(msg):
    print(f"{datetime.now().isoformat(timespec='seconds')} {msg}", flush=True)


def export_files():
    if not EXPORTS.is_dir():
        return []
    return sorted(p for p in EXPORTS.iterdir()
                  if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in (".csv", ".txt", ".tsv"))


def fingerprint(paths):
    """Changes whenever a file is added, removed or modified."""
    return tuple((str(p), p.stat().st_mtime_ns, p.stat().st_size) for p in paths if p.exists())


def stamp(p):
    return datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")


def find_exports(files, cfg):
    """{export name: newest matching file}, plus warnings for unrecognised files."""
    found, warnings = {}, []
    for p in files:
        try:
            headers, _ = read_table(p)
        except Exception as e:
            warnings.append(f"{p.name}: cannot read ({e})")
            continue
        kinds = [n for n in datasets.FIELDS if datasets.matches(headers, n, cfg)]
        if not kinds:
            warnings.append(f"{p.name}: not recognised as any export (check 'felismeres' in oszlopok.toml), ignored")
        for n in kinds:
            if n not in found or p.stat().st_mtime > found[n].stat().st_mtime:
                found[n] = p
    return found, warnings


def id_key(value):
    """Matching key for customer numbers: '0003000048' and '3000048' are the same
    customer (one export may pad numbers with zeros, the other not)."""
    v = (value or "").strip()
    return (v.lstrip("0") or "0") if v.isdigit() else v.casefold()


def name_key(value):
    """Matching key for person names: case and extra spaces don't matter."""
    return " ".join((value or "").split()).casefold()


def build(files, cfg):
    """Parse, filter, link and validate. Returns (data, meta_sources, warnings).

    Matching rules (each one also counted in meta, so nothing disappears silently):
    - blocked customers ("zárolt" marker) are dropped, with all their invoices
    - customer numbers match regardless of leading zeros
    - Ügyintéző names that differ only in case/spacing are one person
      (shown with the most frequent spelling)
    - an invoice repeated on identical rows is counted once
    - credit notes (configured invoice types) count negative
    """
    found, warnings = find_exports(files, cfg)
    if "vevok" not in found:
        raise ValueError("no customer export found (needs the 'felismeres' columns of [vevok])")

    # ---- Customers ----
    rows, w = datasets.parse(found["vevok"], "vevok", cfg)
    warnings += w
    cname = found["vevok"].name
    customers, by_id, blocked = [], {}, set()
    markers = cfg["blocked_markers"]
    for r in rows:
        line = r.pop("_line")
        if not r.get("id"):
            warnings.append(f"{cname} line {line}: no customer number, row skipped")
            continue
        text = datasets.fold(f"{r.get('name') or ''} {r.get('search_term') or ''}")
        if any(m in text for m in markers):
            blocked.add(id_key(r["id"]))
            continue
        if id_key(r["id"]) in by_id:
            warnings.append(f"{cname} line {line}: duplicate customer {r['id']}, row skipped")
            continue
        by_id[id_key(r["id"])] = r
        if not r.get("name"):
            warnings.append(f"Customer {r['id']}: no name")
        customers.append(r)

    # One spelling per Ügyintéző: the most frequent one among the variants
    spellings = {}
    for c in customers:
        if c.get("account_manager"):
            c["account_manager"] = " ".join(c["account_manager"].split())
            variants = spellings.setdefault(name_key(c["account_manager"]), {})
            variants[c["account_manager"]] = variants.get(c["account_manager"], 0) + 1
    merged_names = {}
    for variants in spellings.values():
        best = max(variants.items(), key=lambda kv: (kv[1], kv[0]))[0]
        for v in variants:
            if v != best:
                merged_names[v] = best
    for c in customers:
        if c.get("account_manager") in merged_names:
            c["account_manager"] = merged_names[c["account_manager"]]
    for v, best in sorted(merged_names.items()):
        warnings.append(f"Ügyintéző '{v}' treated as '{best}' (same name, different spelling)")

    data = {"customers": customers}
    sources = {"customers": {"file": cname, "exported_at": stamp(found["vevok"]), "rows": len(customers),
                             "skipped_blocked": len(blocked), "managers": len(spellings)}}

    # ---- Invoice export: invoices and offers, linked to customers by number ----
    if "szamlak" in found:
        rows, w = datasets.parse(found["szamlak"], "szamlak", cfg)
        warnings += w
        name = found["szamlak"].name
        section = cfg["columns"]["szamlak"]
        # Document types (BF): which count as sales, which are offers; the rest is skipped.
        # Without a BF column every row is an invoice (older exports).
        has_type = "origin" in section.get("oszlopok", {})
        invoice_types = {t.strip().upper() for t in section.get("szamla_bf", ["R"])}
        offer_types = {t.strip().upper() for t in section.get("ajanlat_bf", ["A"])}
        # Invoice types counted as negative (credit notes), compared without case/accents
        negative = {datasets.fold(k) for k in section.get("negativ_tipusok", ["Jóváírás"])}
        clerks = {k.casefold(): v for k, v in cfg["codes"].get("ugyintezok", {}).items()}
        invoices, offers, by_key, of_blocked, orphans, merged = [], [], {}, 0, {}, 0
        kinds, types, cancelled, raw_rows, skipped = {}, {}, 0, len(rows), 0
        skipped_types, no_rate = 0, {}
        for r in rows:
            line = r.pop("_line")
            if not r.get("id") or not r.get("customer_id"):
                warnings.append(f"{name} line {line}: no document or customer number, row skipped")
                skipped += 1
                continue
            # One document can appear on several identical rows (a side effect of the
            # export). The internal document ID identifies it; without it, type + number.
            key = r.get("doc_id") or f"{r.get('origin')}:{r['id']}"
            if key in by_key:
                if by_key[key] == r:
                    merged += 1
                else:
                    warnings.append(f"{name} line {line}: document {r['id']} appears again with different values, row skipped")
                    skipped += 1
                continue
            by_key[key] = dict(r)
            bf = (r.get("origin") or "").strip().upper()
            types[bf or "–"] = types.get(bf or "–", 0) + 1
            if has_type and bf not in invoice_types and bf not in offer_types:
                skipped_types += 1  # e.g. delivery notes: their invoice is already counted
                continue
            if id_key(r["customer_id"]) in blocked:
                of_blocked += 1
                continue
            customer = by_id.get(id_key(r["customer_id"]))
            if customer:
                r["customer_id"] = customer["id"]  # the customer export's spelling of the number
            else:
                orphans[r["customer_id"]] = orphans.get(r["customer_id"], 0) + 1
            if r.get("clerk"):  # user name on the document -> Ügyintéző name, if paired
                r["clerk"] = clerks.get(r["clerk"].strip().casefold(), r["clerk"].strip())
            if has_type and bf in offer_types:
                offers.append({f: r.get(f) for f in ("id", "customer_id", "date", "net", "gross", "currency", "currency_code", "clerk")})
                continue
            to_huf(r, no_rate)
            kind = r.get("kind") or ""
            kinds[kind] = kinds.get(kind, 0) + 1
            if datasets.fold(kind) in negative:
                for f in ("net", "gross", "net_local", "gross_local"):
                    if r.get(f) is not None:
                        r[f] = -abs(r[f])
                r["credit"] = True
            if (r.get("cancelled") or "").strip().lower() in ("igen", "i", "yes", "x"):
                cancelled += 1
            # Keep the page's data small: drop what was only needed here
            for f in ("doc_id", "kind", "cancelled", "rate"):
                r.pop(f, None)
            if r.get("currency"):
                r.pop("currency_code", None)
            if r.get("tax_date") == r.get("date"):
                r["tax_date"] = None
            invoices.append(r)
        for o in offers:
            if o.get("currency"):
                o.pop("currency_code", None)
        for cur, n in sorted(no_rate.items()):
            warnings.append(f"{n} {cur} invoices have no exchange rate: left out of the HUF totals")
        for cid, n in sorted(orphans.items()):
            warnings.append(f"Documents for unknown customer {cid}: {n} (not in the customer export)")
        data["invoices"] = invoices
        data["offers"] = offers
        sources["invoices"] = {"file": name, "exported_at": stamp(found["szamlak"]), "rows": len(invoices),
                               "offers": len(offers), "raw_rows": raw_rows, "skipped_rows": skipped,
                               "skipped_types": skipped_types, "skipped_blocked": of_blocked, "duplicates_merged": merged,
                               "unmatched": sum(orphans.values()), "types": types, "invoice_types": sorted(invoice_types),
                               "offer_types": sorted(offer_types), "kinds": kinds, "cancelled_flagged": cancelled,
                               "has_payments": "cleared" in section.get("oszlopok", {}),
                               "no_rate": no_rate}
    return data, sources, warnings


def to_huf(r, no_rate):
    """Forint value of an invoice: from the export's own HUF column if mapped,
    else amount x the invoice's exchange rate (Valutaárf.), exact to the fillér.
    HUF invoices need nothing (their amount is the forint value)."""
    from decimal import Decimal, ROUND_HALF_UP
    cur = (r.get("currency") or r.get("currency_code") or "").upper()
    if cur == "HUF":
        r["net_local"] = r["gross_local"] = None
        return
    rate = r.get("rate")
    for src, dst in (("net", "net_local"), ("gross", "gross_local")):
        if r.get(dst) is not None or r.get(src) is None:
            continue
        if rate and rate > 0 and not (rate == 1 and cur):
            v = (Decimal(str(r[src])) * Decimal(str(rate))).quantize(Decimal("0.01"), ROUND_HALF_UP)
            r[dst] = int(v) if v == v.to_integral_value() else float(v)
    if r.get("net_local") is None:
        no_rate[cur or "?"] = no_rate.get(cur or "?", 0) + 1


def control_totals(data):
    """Figures the page recomputes on its own and compares (⚠ status tab).
    Only invoices linked to a known customer and with a date count, as on the
    page. Amounts in integer cents, summed exactly with Decimal."""
    from decimal import Decimal
    ids = {c["id"] for c in data["customers"]}
    out = {"customers": len(data["customers"])}
    if "invoices" in data:
        net, count, huf = {}, {}, 0
        cents = lambda v: int((Decimal(str(v or 0)) * 100).to_integral_value())
        for i in data["invoices"]:
            if i["customer_id"] not in ids or not i.get("date"):
                continue
            cur = i.get("currency") or i.get("currency_code") or ""
            net[cur] = net.get(cur, 0) + cents(i["net"])
            count[cur] = count.get(cur, 0) + 1
            huf += cents(i["net"] if cur == "HUF" else i.get("net_local"))
        out["invoices_by_currency"] = count
        out["net_cents_by_currency"] = net
        out["net_huf_cents"] = huf
    if "offers" in data:
        out["offers"] = sum(1 for o in data["offers"] if o["customer_id"] in ids and o.get("date"))
    return out


def compact(data):
    """Large lists are written as {"fields": [...], "rows": [[...], ...]}: the field
    names appear once instead of on every row (a fraction of the size). Fields
    that are empty in every row are left out. The page expands them on load."""
    out = {}
    for key, rows in data.items():
        if key == "customers" or not rows:
            out[key] = rows
            continue
        # every field that appears in any row (not just the first), unless always empty
        fields = list(dict.fromkeys(f for r in rows for f in r))
        fields = [f for f in fields if any(r.get(f) is not None for r in rows)]
        out[key] = {"fields": fields, "rows": [[r.get(f) for f in fields] for r in rows]}
    return out


def write_atomic(path, obj):
    """Write to a temp file, then rename, so nginx never serves half a file."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)


def run_import(files):
    cfg = datasets.load_config(CONFIG)
    if files:
        data, sources, warnings = build(files, cfg)
        fake = False
    else:
        with tempfile.TemporaryDirectory() as tmp:
            fake_files = fake_data.write_all(Path(tmp), cfg)
            data, sources, warnings = build(fake_files, cfg)
        for s in sources.values():
            s["file"] = "FAKE: " + s["file"]
        fake = True
    meta = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "exported_at": sources["customers"]["exported_at"],
        "fake": fake,
        "sources": sources,
        "checks": control_totals(data),
        "periods": cfg["periods"],   # fiscal year start + shared periods (config/idoszakok.toml)
        "warnings": warnings[:500],
        "warning_count": len(warnings),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    write_atomic(OUT / "data.json", compact(data))
    write_atomic(OUT / "meta.json", meta)  # written last: its timestamp signals "new data ready"
    def describe(kind, v):
        offers = f" + {v['offers']} offers" if "offers" in v else ""
        return f"{kind}: {v['rows']}{offers} ({v['skipped_blocked']} blocked skipped) from {v['file']}"
    summary = ", ".join(describe(k, v) for k, v in sources.items())
    log(f"Imported {summary}; {len(warnings)} warnings")
    for w in warnings[:10]:
        log(f"  warning: {w}")


def drop_fake_data():
    """Production without exports yet: remove sample data a development run may have
    left in the data volume, so fake numbers never show up as real ones."""
    try:
        if json.loads((OUT / "meta.json").read_text(encoding="utf-8")).get("fake"):
            for name in ("meta.json", "data.json"):
                (OUT / name).unlink(missing_ok=True)
            log("Removed sample data left from a development run")
    except (FileNotFoundError, ValueError):
        pass


def main():
    log(f"Importer started: exports={EXPORTS} config={CONFIG} out={OUT} interval={INTERVAL}s fake={FAKE}")
    last = None
    while True:
        try:
            files = export_files()
            fp = fingerprint(files + sorted(CONFIG.glob("*.toml")))
            settling = [p.name for p in files if time.time() - p.stat().st_mtime < STABLE_SECONDS]
            if fp != last and settling:
                log(f"Waiting for files to finish writing: {', '.join(settling)}")
            elif fp != last:
                if files or FAKE:
                    run_import(files)
                else:
                    drop_fake_data()
                    log(f"Waiting: no export files in {EXPORTS}")
                last = fp
        except Exception as e:  # keep running; the last good data stays online
            log(f"IMPORT FAILED, keeping previous data: {e}")
            last = fp
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
