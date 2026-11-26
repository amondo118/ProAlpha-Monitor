"""Writes fake SAP exports in the same format as the real ones, for development.

- Customers: every column of the real header (including empty and repeated
  ones), tab-separated, cp1250 encoding, Hungarian date format, number codes.
  About 2% are marked "ZÁROLT" to exercise the blocked-customer filter.
- Invoices: column names taken from config/oszlopok.toml [szamlak], so the fake
  file follows whatever headers are configured there.

The importer runs the real parser on these files, so development data always
goes through the same code path as production data.

Write sample files to look at:   python fake_data.py <folder>
All names, addresses and numbers are invented.
"""

import random
import sys
from datetime import date, timedelta
from pathlib import Path

# The real customer export header, in order. "" = column without a title.
HEADER = [
    "ABC", "Módosító", "Címszám", "FuvardíjFVevőSz e", "MódDátum", "Módosító", "Címszám", "MódIdő",
    "MódDátum", "Módosító", "Adatrögzítő", "MódIdő", "MódDátum", "FelvDátum", "Adatrögzítő", "MódIdő",
    "FelvIdő", "FelvDátum", "Adatrögzítő", "VIg", "FelvIdő", "FelvDátum", "Cég", "Megszólítás",
    "FelvIdő", "AÉrt", "Autótelefon", "Cikkstat.", "SzlT", "Levélbeni megsz.", "BBN", "Ve/Száll", "M",
    "KészlTény", "S_UStID_Obj", "", "Ágazat", "Közösségi adószám", "", "Imp/exp igazolás", "", "CIN",
    "", "GST azonosító szám", "", "PAN", "", "TAN", "", "Azonosító dokumentum száma", "", "RegDátum",
    "", "Regisztrációs szám", "", "Külföldi adóazonosító szám", "Postfix város", "IEC-osztály",
    "Prefix város", "RegDát ElsSt", "E-mail", "Regisztrációs sz. elsődl. st.", "Cég", "RU-besorolás",
    "Mobiltelefon", "AmMe", "Házszám", "AkMe", "Honlap", "Dunning_S_Adresse_Obj", "Szélességi fok",
    "EurK", "Hosszúsági fok", "Gazdasági ág", "Név", "Törzstőke", "Név 2", "Környezetvéd. díj", "Név 3",
    "ŰrSzSP", "Város", "ŰrSzIP", "ISz", "SzlaÁt", "Pf ISz", "VáltEl", "Postafiók", "ŰSz",
    "S_Adresse_Obj", "SIRET-szám", "Kiválasztás", "FizJ", "Soundex", "KerNyilv Szám", "Orsz", "Cég",
    "Utca", "FvSk", "Postfix utca", "CsopAdóA BelfAdóSz", "Prefix utca", "ORel", "Keresőfogalom",
    "TSze", "Telefax", "ESzl", "Telefax 2", "MérF", "Telefon", "IVL", "Telefon 2", "ÜzVe", "TelK",
    "Szállítmányozó", "Titulus", "Szerz.", "Utónév", "Hitelkeret 2", "TSze", "PEC-cím", "FogPAKód",
    "Jelentésfajta", "RIöf", "I_S_BankVerb_Obj", "AdóK", "Belföldi adószám", "Konszern", "Hitelkeret",
    "HKFü", "ÁHB HitelK", "Vevő", "Vevő (óta)", "UtInfó", "Szállítói szám", "SzF", "Raktár", "SzK",
    "Tfsz", "FSzE", "Társulás tagszáma", "TEPr", "Preferencia figy.v", "MegérkIg NyomtF",
    "Javasolt adószám", "AdóNyilv", "AdóÁ", "ISz", "ÁrLi", "ÁrenLáth", "VÁrECs", "Minős.", "SzlaCímz",
    "SzGy", "GySz", "Régió", "Ért.fiz.", "Kockázatszám", "S_BankVerb_Obj", "S_Kunde_Obj", "Ügyintéző",
    "SBM_Cession_Obj", "SBM_DunningParameter_Obj", "Kiválasztás", "Nylv", "Orsz", "AkBe", "AmBe",
    "Ak3O", "Am3O", "AkÁK", "AmÁK", "Keresőfogalom", "M", "ElkNapt", "VMI-horizont", "VMI-MaxK",
    "VMI-MinK", "VMI variáns", "Alapmennyiség", "Készletek figy.vét", "VMI nulla menny.", "Fo", "GySz",
    "ÜNaptár", "Szla AzNy", "Hátralévő futásidő", "ÉrtLista", "Csomagol. előírás", "Fémfelárak",
    "Társulás", "ElkM", "EloCs", "Szerződésszám", "Pn", "WS", "ÁHBA", "FizM", "FizE", "KamR",
    "Vámpap. nyomt", "FSk",
]

MANAGERS = ["Kovács Péter", "Nagy Eszter", "Szabó Gábor", "Tóth Anna", "Horváth Balázs",
            "Varga Judit", "Kiss Zoltán", "Molnár Réka", "Németh Ádám", "Farkas Zsófia",
            "Balogh Tamás", "Papp Krisztina"]
CLERKS = ["KOVACSP", "NAGYE", "SZABOG", "TOTHA", "ADMIN01"]
INDUSTRIES = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "80", "90"]
# Hungarian city -> (postal code, Régió code)
CITIES = [("Budapest", "1117", "23"), ("Budapest", "1097", "24"), ("Budapest", "1138", "24"),
          ("Gyál", "2360", "13"), ("Debrecen", "4031", "8"), ("Szeged", "6728", "5"),
          ("Győr", "9027", "7"), ("Kecskemét", "6000", "1"), ("Pécs", "7630", "2"),
          ("Miskolc", "3527", "4"), ("Székesfehérvár", "8000", "6"), ("Eger", "3300", "9"),
          ("Nyíregyháza", "4400", "15"), ("Veszprém", "8200", "18"), ("Szolnok", "5000", "10"),
          ("Tatabánya", "2800", "11"), ("Zalaegerszeg", "8900", "19"), ("Békéscsaba", "5600", "3")]
# (country, Pn code, Régió code, city, postal code)
FOREIGN = [("AT", "1", "25", "Wien", "1100"), ("DE", "1", "25", "München", "80331"),
           ("SK", "1", "29", "Bratislava", "82101"), ("RO", "5", "31", "Oradea", "410001"),
           ("CZ", "7", "29", "Brno", "60200"), ("IT", "1", "30", "Verona", "37135"),
           ("SE", "13", "32", "Malmö", "21120"), ("NL", "1", "22", "Eindhoven", "5611")]
STREETS = ["Ipartelep utca", "Fő utca", "Gyár utca", "Kossuth Lajos utca", "Petőfi Sándor utca",
           "Ipari park", "Raktár utca", "Szent István út", "Vasút utca", "Logisztikai park"]
STREETS_EU = ["Industriestraße", "Hauptstraße", "Gewerbepark", "Via Roma", "Strada Industriei"]
NAME_A = ["Alföld", "Bakony", "Duna", "Tisza", "Mátra", "Kőrös", "Rába", "Zala", "Hegyalja",
          "Balaton", "Sajó", "Ipoly", "Kárpát", "Pannon", "Vértes", "Bükk", "Mecsek", "Szamos",
          "Hortobágy", "Őrség", "Zemplén", "Cserhát", "Pilis", "Börzsöny", "Hanság", "Nyírség", "Mintakert"]
NAME_B = ["Gépészeti", "Fémipari", "Műanyag", "Logisztikai", "Építőipari", "Elektro", "Ipari",
          "Kereskedelmi", "Technika", "Szerelő", "Automatika", "Csomagoló", "Energia", "Gyártó",
          "Élelmiszer", "Hűtéstechnikai"]
NAME_C = ["", "", " Plusz", " Pro", " Hungária", " Team", " Invest", " Partner"]
FORMS = ["Kft.", "Kft.", "Kft.", "Zrt.", "Bt."]
NAME_EU = ["Alpen", "Donau", "Nordwerk", "Steiner", "Brenner", "Ostmark", "Morava", "Sava", "Karpaten"]
FORMS_EU = ["GmbH", "GmbH", "s.r.o.", "S.R.L.", "B.V."]
ASSOCIATIONS = ["", "", "", "", "BEVÁS1", "BEVÁS2", "KERESK"]
PAYMENT_METHODS = ["U", "U", "U", "K", "B"]
# Rough EUR rate for fake amounts; RON/CZK/SEK amounts are generated in their own range
RATE = {"HUF": 1, "EUR": 395, "RON": 79, "CZK": 16, "SEK": 36}
PN_TO_ISO = {"0": "HUF", "1": "EUR", "5": "RON", "7": "CZK", "13": "SEK"}


def hu_amount(value):
    """1234567.5 -> '1.234.567,50' (SAP Hungarian number format, trailing minus)."""
    s = f"{abs(value):,.2f}".replace(",", " ").replace(".", ",").replace(" ", ".")
    return s + ("-" if value < 0 else "")


def write_customers(path, count=1800, seed=11):
    """Returns the fake customers [(id, created, currency ISO, payment days)] for invoices."""
    r = random.Random(seed)
    today = date.today()
    used = set()
    groups = [f"K{r.randint(100000, 999999)}" for _ in range(40)]
    first = {}
    for i, h in enumerate(HEADER):
        first.setdefault(h, i)
    lines, out = ["\t".join(HEADER)], []
    for n in range(count):
        foreign = r.random() < 0.12
        for attempt in range(1000):
            if foreign:
                name = f"{r.choice(NAME_EU)} {r.choice(['Industrie', 'Technik', 'Handel', 'Komponenten', 'Systems'])} {r.choice(FORMS_EU)}"
            else:
                name = f"{r.choice(NAME_A)} {r.choice(NAME_B)}{r.choice(NAME_C)} {r.choice(FORMS)}"
            if attempt == 999:
                name = f"{name} {n}"
            if name not in used:
                used.add(name)
                break
        created = today - timedelta(days=int(min(r.expovariate(1 / 1500), 365 * 20)))
        row = [""] * len(HEADER)

        def put(header, value, every=False):
            """Write a value to the first column with this title (or to all of them)."""
            for i, h in enumerate(HEADER):
                if h == header:
                    row[i] = value
                    if not every:
                        break

        if foreign:
            country, pn, region, city, postal = r.choice(FOREIGN)
            street = r.choice(STREETS_EU)
        else:
            city, postal, region = r.choice(CITIES)
            country, pn, street = "HU", "0", r.choice(STREETS)
        cid = str(3000000 + n * 7)
        search = name.split()[0].upper()[:10]
        if r.random() < 0.02:  # blocked customers, to test the filter
            if r.random() < 0.5:
                name = f"ZÁROLT - {name}"
            else:
                search = "ZAROLT"
        terms = r.choice([0, 8, 15, 15, 30, 30, 45, 60])
        slug = name.split()[0].lower().replace("á", "a").replace("é", "e").replace("ő", "o").replace("ö", "o").replace("ü", "u").replace("ű", "u").replace("ó", "o").replace("í", "i").replace("ú", "u")
        put("Vevő", cid)
        put("Kiválasztás", name, every=True)
        put("Név", name)
        put("Keresőfogalom", search, every=True)
        put("Ügyintéző", "" if r.random() < 0.04 else r.choices(MANAGERS, weights=range(12, 0, -1))[0])
        put("FelvDátum", created.strftime("%Y.%m.%d"), every=True)
        put("Adatrögzítő", r.choice(CLERKS), every=True)
        put("Orsz", country, every=True)
        put("Régió", region)
        put("Ágazat", r.choice(INDUSTRIES))
        put("Pn", pn)
        put("FizE", str(terms))
        put("FizM", r.choice(PAYMENT_METHODS))
        put("Társulás", r.choice(ASSOCIATIONS))
        put("Konszern", r.choice(groups) if r.random() < 0.15 else "")
        put("Belföldi adószám", "" if foreign else f"{r.randint(10000000, 29999999)}-{r.choice('1235')}-{r.randint(2, 44):02d}")
        put("Közösségi adószám", f"{country}{r.randint(10000000, 99999999)}" if (foreign or r.random() < 0.6) else "")
        put("Szállítói szám", str(300000 + n) if r.random() < 0.05 else "")
        put("E-mail", f"beszerzes@{slug}.example" if r.random() < 0.85 else "")
        put("Telefon", f"+36 {r.choice(['1', '20', '30', '29', '52', '62'])} {r.randint(100, 999)} {r.randint(1000, 9999)}" if not foreign else f"+{r.randint(30, 49)} {r.randint(100, 999)} {r.randint(10000, 99999)}")
        put("Utca", street)
        put("Házszám", str(r.randint(1, 120)))
        put("Város", city)
        put("ISz", postal, every=True)
        put("MódDátum", today.strftime("%Y.%m.%d"), every=True)
        lines.append("\t".join(row))
        out.append((cid, created, PN_TO_ISO[pn], terms))
    Path(path).write_bytes(("\r\n".join(lines) + "\r\n").encode("cp1250"))
    return out


def write_invoices(path, customers, columns, seed=12):
    """Fake invoice header export in the real proALPHA format: comma-separated,
    quoted Hungarian amounts, UTF-8, the column titles configured in
    [szamlak.oszlopok] (a "#3" title gets 3 columns of that name, only the 3rd
    filled). About 10% of the invoices appear twice (identical rows), as in the
    real export, and ~3% are credit notes (SzlT = "Jóváírás", positive amounts)."""
    import csv
    r = random.Random(seed)
    today = date.today()
    start = date(today.year - 4, 1, 1)
    iso_to_pn = {"HUF": "0", "EUR": "1", "RON": "5", "CZK": "7", "SEK": "13"}
    # header: configured columns (+ repeats for "#n"), plus a few unused ones
    header, slot = [], {}
    for field, spec in columns.items():
        name, _, n = spec.partition("#")
        n = int(n) if n.isdigit() else 1
        for k in range(1, n + 1):
            header.append(name)
        slot[field] = len(header) - 1
    header += ["Címzett", "Nettó összeg 1", "Valutaárf."]
    rows = []
    number = {"A": 0, "L": 0}
    for cid, created, cur, terms in customers:
        if r.random() < 0.45:
            continue  # customers without invoices
        first = max(created, start)
        yearly = r.lognormvariate(16.2, 1.1)  # yearly net sales in HUF; a few large customers
        growth = r.uniform(0.9, 1.25)
        per_year = r.randint(3, 24)
        d = first
        while d <= today:
            years = (d - start).days / 365
            season = 1 + 0.25 * __import__("math").sin((d.timetuple().tm_yday / 365) * 6.283)
            net = yearly * growth ** years * season / per_year * r.uniform(0.5, 1.5) / RATE[cur]
            net = round(net, 0 if cur == "HUF" else 2)
            domestic = cur == "HUF" or r.random() < 0.3
            gross = round(net * (1.27 if domestic else 1), 0 if cur == "HUF" else 2)
            origin = "L" if r.random() < 0.2 else "A"
            number[origin] += 1
            kind = "Jóváírás" if r.random() < 0.03 else "Számla"
            values = {
                "doc_id": f"PA1106:z:{r.getrandbits(128):032x}", "id": str(number[origin]), "customer_id": cid,
                "date": d.strftime("%Y.%m.%d"), "tax_date": d.strftime("%Y.%m.%d"),
                "net": hu_amount(net), "gross": hu_amount(gross), "currency": iso_to_pn[cur],
                "kind": kind, "cancelled": "Nem", "origin": origin, "clerk": r.choice(CLERKS).lower(),
                "due": (d + timedelta(days=terms)).strftime("%Y.%m.%d"), "cleared": "",
            }
            row = [""] * len(header)
            for field, i in slot.items():
                row[i] = values.get(field, "")
            row[-3:] = ["", "0", "1"]
            rows.append(row)
            if r.random() < 0.10:
                rows.append(list(row))  # the same invoice twice, as in the real export
            d += timedelta(days=max(1, int(r.expovariate(per_year / 365))))
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        w.writerow(header)
        w.writerows(rows)


def write_all(folder, cfg):
    folder = Path(folder)
    customers = write_customers(folder / "vevok_minta.csv")
    files = [folder / "vevok_minta.csv"]
    inv = cfg["columns"].get("szamlak", {}).get("oszlopok")
    if inv:
        write_invoices(folder / "szamlak_minta.csv", customers, inv)
        files.append(folder / "szamlak_minta.csv")
    return files


if __name__ == "__main__":
    import datasets
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out.mkdir(parents=True, exist_ok=True)
    config = Path(__file__).resolve().parent.parent / "config"
    for f in write_all(out, datasets.load_config(config)):
        print(f)
