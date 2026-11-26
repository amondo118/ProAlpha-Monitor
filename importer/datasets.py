"""Export definitions and the generic, config-driven parser.

The hand-edited config (config/oszlopok.toml) says which CSV column feeds each
field. This file says what TYPE each field is, which the user never needs to
change. To support a new export (e.g. invoice lines / articles):
  1. add its fields and types to FIELDS below,
  2. add a section with the same name to config/oszlopok.toml,
  3. use the rows in importer.py (link them, validate them).
"""

import tomllib
import unicodedata
from pathlib import Path

from sap_parse import clean_text, norm_header, parse_date, parse_number, read_table

# Field types:
#   text      trimmed text, empty -> null (IDs stay text: leading zeros survive)
#   date      SAP date in any common layout -> "YYYY-MM-DD"
#   amount    number in SAP format (1.234,50 / 12,5-) -> exact JSON number
#   days      whole number of days (FizE: "1" -> 1)
#   currency  ISO code as is ("HUF"), or a Pn number code -> ISO via [penznemek]
#   code:X    code -> name via code list X in config/kodlistak.toml;
#             the row keeps both: field = name, field_code = code
FIELDS = {
    "vevok": {
        "id": "text", "name": "text", "search_term": "text", "account_manager": "text",
        "created": "date", "country": "text", "region": "code:regiok", "industry": "code:agazatok",
        "currency": "currency", "payment_terms": "days", "payment_method": "code:fizetesi_modok",
        "association": "text", "group": "text", "tax_number": "text", "eu_vat_number": "text",
        "supplier_id": "text", "email": "text", "phone": "text",
        "street": "text", "house_number": "text", "city": "text", "postal_code": "text",
    },
    "szamlak": {
        "doc_id": "text",        # internal document ID: merges duplicate rows of one invoice
        "id": "text",            # invoice number (shown)
        "customer_id": "text", "date": "date", "tax_date": "date", "due": "date",
        "net": "amount", "gross": "amount", "currency": "currency",
        "kind": "text",          # invoice type (SzlT): "Számla", "Jóváírás", …
        "cancelled": "text",     # storno flag (Sto)
        "origin": "text",        # created from: order / delivery note (BF)
        "clerk": "text",         # who issued it (user name)
        "cleared": "date",       # payment date; without it there is no open-invoice view
        "net_local": "amount",   # optional: net in HUF, for totals across currencies
    },
}
# The data.json key for each export
OUTPUT_KEY = {"vevok": "customers", "szamlak": "invoices"}


class ConfigError(Exception):
    pass


def load_config(config_dir):
    """Read and check the config files. Raises ConfigError with a readable message."""
    config_dir = Path(config_dir)
    try:
        cols = tomllib.loads((config_dir / "oszlopok.toml").read_text(encoding="utf-8"))
        codes = tomllib.loads((config_dir / "kodlistak.toml").read_text(encoding="utf-8"))
    except FileNotFoundError as e:
        raise ConfigError(f"config file missing: {e.filename}")
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"config file syntax error: {e}")
    for name, fields in FIELDS.items():
        section = cols.get(name)
        if section is None:
            continue
        for field in section.get("oszlopok", {}):
            if field not in fields:
                raise ConfigError(f"oszlopok.toml [{name}.oszlopok]: unknown field '{field}' "
                                  f"(known: {', '.join(fields)})")
        for field in section.get("felismeres", []):
            if field not in section.get("oszlopok", {}):
                raise ConfigError(f"oszlopok.toml [{name}]: 'felismeres' field '{field}' has no column")
    # Code lists: normalise keys once ("05" -> "5")
    lists = {k: {norm_code(c): str(v) for c, v in table.items()} for k, table in codes.items()}
    markers = [fold(m) for m in cols.get("zarolt", {}).get("jelzok", []) if str(m).strip()]
    periods = load_periods(config_dir / "idoszakok.toml")
    return {"columns": cols, "codes": lists, "blocked_markers": markers, "periods": periods}


def load_periods(path):
    """config/idoszakok.toml (optional): the fiscal year's first month and the
    periods shared by everyone. -> {"fiscal_start": 1..12, "shared": [{id, name, from, to}]}"""
    from datetime import date
    from sap_parse import parse_date
    if not path.is_file():
        return {"fiscal_start": 1, "shared": []}
    try:
        cfg = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path.name}: syntax error: {e}")
    start = cfg.get("uzleti_ev_kezdete", 1)
    if not isinstance(start, int) or isinstance(start, bool) or not 1 <= start <= 12:
        raise ConfigError(f"{path.name}: uzleti_ev_kezdete must be a month number 1–12, got {start!r}")

    def as_date(value, what):
        if isinstance(value, date):
            return value.isoformat()
        try:
            d = parse_date(str(value))
        except ValueError:
            d = None
        if not d:
            raise ConfigError(f"{path.name}: '{what}' is not a date: {value!r} (use 2026-03-01)")
        return d

    shared, seen = [], set()
    for n, p in enumerate(cfg.get("idoszak", []), start=1):
        name = str(p.get("nev", "")).strip()
        if not name or "kezdete" not in p or "vege" not in p:
            raise ConfigError(f"{path.name}: period #{n} needs nev, kezdete and vege")
        start_d, end_d = as_date(p["kezdete"], f"{name} kezdete"), as_date(p["vege"], f"{name} vege")
        if start_d > end_d:
            raise ConfigError(f"{path.name}: period '{name}' starts after it ends")
        pid = f"{n}-" + "".join(ch for ch in fold(name).lower() if ch.isalnum())[:24]
        if pid in seen:
            raise ConfigError(f"{path.name}: period '{name}' appears twice")
        seen.add(pid)
        shared.append({"id": pid, "name": name, "from": start_d, "to": end_d})
    return {"fiscal_start": start, "shared": shared}


def norm_code(code):
    """'05' and '5' are the same code; '0' and '00' stay '0'."""
    s = str(code or "").strip()
    return s.lstrip("0") or ("0" if s else "")


def fold(text):
    """Uppercase without accents, for marker matching: 'Zárolt' -> 'ZAROLT'."""
    s = unicodedata.normalize("NFKD", str(text or ""))
    return "".join(c for c in s if not unicodedata.combining(c)).upper()


def split_header(spec):
    """'FelvDátum#2' -> ('FelvDátum', 2); 'Vevő' -> ('Vevő', 1)."""
    if "#" in spec:
        name, _, n = spec.rpartition("#")
        if n.isdigit() and int(n) >= 1:
            return name, int(n)
    return spec, 1


def column_positions(headers):
    """Normalised header -> list of positions (duplicates kept in order)."""
    pos = {}
    for i, h in enumerate(headers):
        pos.setdefault(norm_header(h), []).append(i)
    return pos


def matches(headers, name, cfg):
    """True if a file with these headers is export `name` (all 'felismeres' columns present)."""
    section = cfg["columns"].get(name)
    if not section:
        return False
    pos = column_positions(headers)
    for field in section.get("felismeres", []):
        header, n = split_header(section["oszlopok"][field])
        if len(pos.get(norm_header(header), [])) < n:
            return False
    return True


def parse(path, name, cfg):
    """Parse export `name` from `path`. Returns (rows, warnings)."""
    section = cfg["columns"][name]
    types = FIELDS[name]
    headers, raw_rows = read_table(path)
    pos = column_positions(headers)

    index, warnings = {}, []
    for field, spec in section.get("oszlopok", {}).items():
        header, n = split_header(spec)
        found = pos.get(norm_header(header), [])
        if len(found) >= n:
            index[field] = found[n - 1]
        elif field in section.get("felismeres", []):
            raise ValueError(f"{path.name}: required column missing: {spec}")
        else:
            warnings.append(f"{path.name}: column not found, left empty: {spec}")

    codes = cfg["codes"]
    unknown = {}  # (column, code) -> rows; reported once per code
    rows = []
    for line_no, raw in enumerate(raw_rows, start=2):
        rec = {}
        for field, kind in types.items():
            if field not in section.get("oszlopok", {}):
                continue
            i = index.get(field)
            value = raw[i] if i is not None and i < len(raw) else ""
            try:
                rec.update(convert(field, kind, value, codes, unknown, section["oszlopok"][field]))
            except ValueError as e:
                rec[field] = None
                warnings.append(f"{path.name} line {line_no}, {section['oszlopok'][field]}: {e}")
        rec["_line"] = line_no
        rows.append(rec)
    for (column, code), count in sorted(unknown.items()):
        warnings.append(f"{column}: code {code} is not in kodlistak.toml ({count} rows), shown as code")
    return rows, warnings


def convert(field, kind, value, codes, unknown, column):
    """One cell -> {field: value, ...}."""
    if kind == "text":
        return {field: clean_text(value)}
    if kind == "date":
        return {field: parse_date(value)}
    if kind == "amount":
        d = parse_number(value)
        return {field: None if d is None else (int(d) if d == d.to_integral_value() else float(d))}
    if kind == "days":
        s = (value or "").strip()
        if not s:
            return {field: None}
        if not s.isdigit():
            raise ValueError(f"not a number of days: {value!r}")
        return {field: int(s)}
    if kind == "currency":
        s = (value or "").strip()
        if not s:
            return {field: None, f"{field}_code": None}
        if s.isalpha() and len(s) == 3:
            return {field: s.upper(), f"{field}_code": None}
        return lookup(field, s, codes.get("penznemek", {}), unknown, column)
    if kind.startswith("code:"):
        s = (value or "").strip()
        if not s:
            return {field: None, f"{field}_code": None}
        return lookup(field, s, codes.get(kind[5:], {}), unknown, column)
    raise ValueError(f"unknown field type {kind}")


def lookup(field, raw, table, unknown, column):
    code = norm_code(raw)
    if not table:
        # An empty list means "not filled in yet": show the raw value as the name, no warning
        return {field: raw.strip(), f"{field}_code": code}
    name = table.get(code)
    if name is None:
        unknown[(column, code)] = unknown.get((column, code), 0) + 1
    return {field: name, f"{field}_code": code}
