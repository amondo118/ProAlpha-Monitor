# ProAlpha Monitor

Read-only customer dashboard (vevői irányítópult) for the daily SAP exports: customers now, invoices next,
invoice lines (articles) later. Hungarian by default, English via the language
switch. Everything runs in Docker; the host needs only Docker and Git.

```
daily SAP CSV snapshots ──► importer (Python) ──► data.json + meta.json ──► nginx ──► browser
   ./exports                  │  reads config/*.toml        shared volume
                              │  recognises each export by its columns
   ./config  (hand-edited) ───┘  filters "zárolt", links invoices → customers
```

## Run it (development, Fedora)

```bash
sudo systemctl start docker
docker compose up --build
```

Open http://localhost:8080. With `./exports` empty, the importer generates fake
exports in the real format (customers + invoices) and imports them with the real
code. The page shows a **MINTA** tag and a notice.

- Real exports: copy the CSV files into `./exports/`; they are imported about a minute later.
- Edit `config/*.toml`: the importer notices and re-imports within a minute (no rebuild).
- Frontend files (`web/public/`) are mounted live: edit, refresh the browser.
- Importer code changes: `docker compose up --build importer`
- Log and warnings: `docker compose logs importer`
- Look at the fake exports: `python3 importer/fake_data.py some_folder`

## Deploy (production, AlmaLinux)

```bash
git clone <repo-url> /srv/dashboard
cd /srv/dashboard
cp .env.example .env    # set EXPORTS_DIR to the folder SAP writes the CSV files to
docker compose -f compose.yaml -f compose.prod.yaml up -d --build
```

The `config/` folder is mounted from the checkout, so it can be edited on the server.

## The two hand-edited files

### `config/oszlopok.toml` – which CSV column feeds which field

```toml
[vevok.oszlopok]
id      = "Vevő"
name    = "Kiválasztás"
created = "FelvDátum"      # "FelvDátum#2" = the second column with this title
```

- Left side: the program's field name (do not change). Right side: the SAP column title.
- Repeated titles (the customer export has 4 × FelvDátum, 2 × ISz, …): `#2`, `#3` picks
  that occurrence; without a suffix the first one is used.
- `felismeres`: the columns that identify the export. A CSV that has all of them is that export.
- `[zarolt] jelzok`: customers whose name or search term contains any marker are left
  out, together with their invoices. Case and accents are ignored ("ZÁROLT" also
  matches "zarolt", "*Zárolt*").
- A mistake in the file (syntax, unknown field name) stops the import with a clear
  message in the log; the last good data stays online.

### `config/kodlistak.toml` – code → name lists

`[penznemek]` (Pn → ISO currency), `[agazatok]`, `[regiok]`, `[fizetesi_modok]`.
Leading zeros don't matter ("05" = "5"). An unknown code is shown as the code
(dashed underline) and reported once per code. An empty list (FizM for now) shows
the raw code without warnings.

## What the page shows

| View | Content |
|---|---|
| Top bar | Search by customer number or name (suggestions; Enter opens the customer), data date, MINTA tag |
| Áttekintés | Customers, new customers (30 days / year to date), without Ügyintéző, foreign; new per month; by Ügyintéző, industry, region, country; latest |
| Ügyintézők | Per Ügyintéző: customers, share, new, foreign, last new customer (+ sales / open invoices once invoices exist) |
| Vevők | All customers with filters (Ügyintéző, country, region, industry, created date, search) and CSV export |
| Customer page | Header with address and contact, KPI tiles, sales by year, open invoices with due-date status, terms, identifiers, same corporate group, data sources |
| Értékesítés (Sales) | Sales by day / week / month / quarter / half year / year over a range (last 12 months, this year, last year, last 3 years, all, or custom dates), compared with the same period of the previous year. Net or gross, one currency at a time (other currencies are listed separately, never added). Breakdown by customer, Ügyintéző, region, industry, country or invoice issuer; filters for all of these. CSV export of the periods |
| ⚠ tab (right end of the tab bar) | Import status: warnings from the last import (searchable), stale-data alert, data sources with row counts, skipped blocked customers. The icon is grey when all is well, amber with a count when there are warnings, red when the export is overdue |

Filters, sorting and the open customer are in the URL: links can be shared and bookmarked.

Tables (Vevők, Ügyintézők): click a header to sort, drag a header to move the column,
drag a header's right edge to resize it (double-click the edge: automatic widths).
The layout is saved per table in the browser; "Oszlopok alaphelyzetbe" resets it.
CSV export uses the displayed column order. The theme switch (Automatikus / Világos /
Sötét) is next to the language switch.

## The invoice export (proALPHA invoice headers)

One row = one invoice header. Columns used (see `[szamlak]` in `config/oszlopok.toml`):

| CSV column | Field | Notes |
|---|---|---|
| V_BelegKopf_Obj | `doc_id` | internal document ID. The export repeats some invoices on identical rows; they are merged by this ID (count shown on the ⚠ status tab) |
| BizSz | `id` | invoice number |
| Vevő | `customer_id` | links the invoice to the customer |
| Bizonylatdátum | `date` | decides the period. For the date of supply use `"Adódátum#3"` |
| Végösszeg / Br. végösszeg | `net` / `gross` | net = gross / 1.27 for domestic customers, equal for EU reverse charge |
| Pn | `currency` | same code list as the customer export |
| SzlT | `kind` | invoice type. Types listed in `negativ_tipusok` (default "Jóváírás") count negative |
| Sto | `cancelled` | counted on the status tab |
| BF, Ügyintéző | `origin`, `clerk` | A = from an order, L = from a delivery note; the issuing user |

- The exchange rate column (Valutaárf.) is always 1, so currencies are never converted:
  every total is per currency.
- The export has no payment data, so open invoices are switched off (the customer page
  shows the latest invoices instead). With a payment-date column, add `cleared = "…"`.
- Invoices of blocked or unknown customers are skipped and reported.
- Invoice lines / articles (later): add a `szamlatetelek` entry to `FIELDS` in
  `importer/datasets.py` and a matching section in `oszlopok.toml`.

## Data quality and precision

- IDs stay text (leading zeros survive). Amounts are parsed exactly (Decimal) and
  summed in the browser as integer cents, only within the same currency.
- Rows without a key, duplicates, unreadable dates/amounts and unknown codes are
  reported with file name and line number (⚠ status tab + importer log).
- Each export is a full snapshot; with several files of one kind the newest wins.
- Files changed in the last 60 s are not read yet (`STABLE_SECONDS`), so a file SAP is
  still writing is never imported half-finished.
- The ⚠ status tab turns red when the export is older than 30 hours, not counting weekends.

## Known limitations

- `name` uses Kiválasztás. The export now also has Név / Név 2; if Név is the exact
  company name, change it in `oszlopok.toml`.
- The 4 FelvDátum columns: the first one is used. Check with real data which is the
  customer's creation date.
- No login. Authentication can be added in front of nginx without changing the app.
- CSV export: Excel drops leading zeros when opening a CSV directly. Use
  Data → From Text/CSV and set ID columns to Text.
