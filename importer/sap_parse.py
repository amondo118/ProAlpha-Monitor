"""Helpers for typical SAP export quirks.

Rules that keep data exact:
- IDs (customer, supplier, tax number) stay strings: never int(), it drops leading zeros.
- Amounts: parse with Decimal, convert for JSON only at the end.
"""

import csv
import io
import os
import unicodedata
from datetime import date
from decimal import Decimal, InvalidOperation

# Decimal format of the export. "comma" = 1.234.567,89 or 1 234 567,89 (Hungarian SAP default)
#                                "point" = 1,234,567.89
NUMBER_FORMAT = os.environ.get("NUMBER_FORMAT", "comma")
# Force an encoding if auto-detection gets it wrong (e.g. ENCODING=cp1250)
ENCODING = os.environ.get("ENCODING", "")


def parse_number(text):
    """'1.234,50' -> Decimal('1234.50'); SAP trailing minus '12,5-' -> Decimal('-12.5').
    Returns None for empty cells; raises ValueError for anything unparseable."""
    s = (text or "").strip().replace(" ", "").replace(" ", "")
    if not s:
        return None
    negative = s.endswith("-") or s.startswith("-")
    s = s.strip("-")
    if NUMBER_FORMAT == "comma":
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", "")
    try:
        value = Decimal(s)
    except InvalidOperation:
        raise ValueError(f"not a number: {text!r}")
    return -value if negative else value


def parse_date(text):
    """SAP dates in any common layout -> 'YYYY-MM-DD'. Empty or '00000000' -> None.
    Handles 20261124, 2026.11.24, 2026.11.24., 2026. 11. 24., 24.11.2026, 2026-11-24."""
    s = (text or "").strip().rstrip(".").replace(" ", "")
    if not s or s.strip("0.-/") == "":
        return None
    if len(s) == 8 and s.isdigit():
        y, m, d = s[:4], s[4:6], s[6:]
    else:
        parts = s.replace("-", ".").replace("/", ".").split(".")
        if len(parts) != 3:
            raise ValueError(f"not a date: {text!r}")
        y, m, d = parts if len(parts[0]) == 4 else (parts[2], parts[1], parts[0])
    try:
        return date(int(y), int(m), int(d)).isoformat()
    except ValueError:
        raise ValueError(f"not a date: {text!r}")


def clean_text(text):
    """Trim; empty -> None."""
    s = (text or "").strip()
    return s or None


def norm_header(name):
    """Compare headers without worrying about case, spacing or accent encoding forms."""
    return " ".join(unicodedata.normalize("NFC", name or "").split()).casefold()


def read_text(path):
    """Decode an export file. Hungarian Windows exports are usually cp1250
    (ő and ű do not exist in cp1252). UTF-16 and UTF-8 are detected first."""
    raw = path.read_bytes()
    if ENCODING:
        return raw.decode(ENCODING)
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1250")


def read_table(path):
    """Read a delimited export into (headers, rows). Detects tab / ; / , separators.
    Rows are lists in header order; duplicate header names are kept as they are."""
    text = read_text(path)
    first = text.split("\n", 1)[0]
    delimiter = max(["\t", ";", ","], key=first.count)
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = [r for r in reader if any(c.strip() for c in r)]
    if not rows:
        raise ValueError(f"{path.name}: file is empty")
    return [h.strip() for h in rows[0]], rows[1:]
