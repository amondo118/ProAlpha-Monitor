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


def build(files, cfg):
    """Parse, filter, link and validate. Returns (data, meta_sources, warnings)."""
    found, warnings = find_exports(files, cfg)
    if "vevok" not in found:
        raise ValueError("no customer export found (needs the 'felismeres' columns of [vevok])")

    # Customers: drop blocked ones (marker in name or search term), skip bad rows
    rows, w = datasets.parse(found["vevok"], "vevok", cfg)
    warnings += w
    customers, seen, blocked = [], set(), set()
    markers = cfg["blocked_markers"]
    for r in rows:
        line = r.pop("_line")
        if not r.get("id"):
            warnings.append(f"{found['vevok'].name} line {line}: no customer number, row skipped")
            continue
        text = datasets.fold(f"{r.get('name') or ''} {r.get('search_term') or ''}")
        if any(m in text for m in markers):
            blocked.add(r["id"])
            continue
        if r["id"] in seen:
            warnings.append(f"{found['vevok'].name} line {line}: duplicate customer {r['id']}, row skipped")
            continue
        seen.add(r["id"])
        if not r.get("name"):
            warnings.append(f"Customer {r['id']}: no name")
        customers.append(r)
    data = {"customers": customers}
    sources = {"customers": {"file": found["vevok"].name, "exported_at": stamp(found["vevok"]),
                             "rows": len(customers), "skipped_blocked": len(blocked)}}

    # Invoices: linked to customers by customer number
    if "szamlak" in found:
        rows, w = datasets.parse(found["szamlak"], "szamlak", cfg)
        warnings += w
        invoices, seen, of_blocked, orphans = [], set(), 0, {}
        customer_ids = {c["id"] for c in customers}
        for r in rows:
            line = r.pop("_line")
            if not r.get("id") or not r.get("customer_id"):
                warnings.append(f"{found['szamlak'].name} line {line}: no invoice or customer number, row skipped")
                continue
            if r["customer_id"] in blocked:
                of_blocked += 1
                continue
            if r["id"] in seen:
                warnings.append(f"{found['szamlak'].name} line {line}: duplicate invoice {r['id']}, row skipped")
                continue
            seen.add(r["id"])
            if r["customer_id"] not in customer_ids:
                orphans[r["customer_id"]] = orphans.get(r["customer_id"], 0) + 1
            invoices.append(r)
        for cid, n in sorted(orphans.items()):
            warnings.append(f"Invoices for unknown customer {cid}: {n} (not in the customer export)")
        data["invoices"] = invoices
        sources["invoices"] = {"file": found["szamlak"].name, "exported_at": stamp(found["szamlak"]),
                               "rows": len(invoices), "skipped_blocked": of_blocked}
    return data, sources, warnings


def compact(data):
    """Large lists are written as {"fields": [...], "rows": [[...], ...]}: the field
    names appear once instead of on every row (a fraction of the size). Fields
    that are empty in every row are left out. The page expands them on load."""
    out = {}
    for key, rows in data.items():
        if key == "customers" or not rows:
            out[key] = rows
            continue
        fields = [f for f in rows[0] if any(r.get(f) is not None for r in rows)]
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
        "warnings": warnings[:50],
        "warning_count": len(warnings),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    write_atomic(OUT / "data.json", compact(data))
    write_atomic(OUT / "meta.json", meta)  # written last: its timestamp signals "new data ready"
    summary = ", ".join(f"{k}: {v['rows']} ({v['skipped_blocked']} blocked skipped) from {v['file']}" for k, v in sources.items())
    log(f"Imported {summary}; {len(warnings)} warnings")
    for w in warnings[:10]:
        log(f"  warning: {w}")


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
                    log(f"Waiting: no export files in {EXPORTS}")
                last = fp
        except Exception as e:  # keep running; the last good data stays online
            log(f"IMPORT FAILED, keeping previous data: {e}")
            last = fp
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
