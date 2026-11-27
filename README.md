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
| Top bar | Search by customer number or name (suggestions; Enter opens the customer); **period picker**; **Nettó / Bruttó** switch (every amount on every page follows it; the ⚠ control totals stay net); data date, MINTA tag |
| Áttekintés | With invoices: sales this year and last month (vs the previous year), active customers, new customers, customers without Ügyintéző; monthly sales vs the previous year; top customers; sales by Ügyintéző, industry and region (net, HUF invoices); sales per currency; new customers per month and the latest ones. Without invoices: the customer statistics |
| Vevők | All customers (default columns: name, industry, Ügyintéző, tax no., currency, payment terms, sales this year, country, region, city) with filters and CSV export |
| Ügyintéző page | Like the customer page: sales this year and last month vs the previous year, active and new customers, sales chart (year/half/quarter/month), their customers with sales and change, sales per currency and industry, latest new customers |
| Customer page | Header with address and contact, KPI tiles, sales by year, open invoices with due-date status, terms, identifiers, same corporate group, data sources |
| Értékesítés (Sales) | Button groups for range, time breakdown and net/gross; one large button per currency showing its total (currencies are never added). Sales by day / week / month / quarter / half year / year over a range (last 12 months, this year, last year, last 3 years, all, or custom dates), compared with the same period of the previous year. Net or gross, one currency at a time (other currencies are listed separately, never added). Breakdown by customer, Ügyintéző, region, industry, country or invoice issuer; filters for all of these. CSV export of the periods |
| ⚙ Settings | Shared periods and fiscal year start (read from `config/idoszakok.toml`); per browser: custom periods (name + dates, shown in the period picker), the “new customer” window (days), theme, language, reset column layouts / welcome / everything |
| ? tab (next to ⚠) | Help: a short guide to the whole site (search, tabs, sales controls, sorting/moving/resizing columns, filters and links, export, data and figures, settings). On the first visit a welcome message in the corner points to it (closes with ✕ or by itself) |
| ⚠ tab (right end of the tab bar) | Import status: warnings from the last import (searchable), stale-data alert, data sources with row counts, skipped blocked customers. The icon is grey when all is well, amber with a count when there are warnings, red when the export is overdue |

Filters, sorting and the open customer are in the URL: links can be shared and bookmarked.

Tables (Vevők, Ügyintézők): click a header to sort, drag a header to move the column,
drag a header's right edge to resize it (double-click the edge: automatic widths).
The layout is saved per table in the browser; "Oszlopok alaphelyzetbe" resets it.
CSV export uses the displayed column order. The theme switch (Automatikus / Világos /
Sötét) is next to the language switch.

## The invoice export (proALPHA document headers)

One row = one document. The export mixes document types; only the **BF** column
tells them apart (the SzlT column says "Számla" on every row):

| BF | Document | Used as |
|---|---|---|
| R | invoice | **sales** |
| VFP | (as agreed) | **sales** |
| A | offer | **offers**: counted per Ügyintéző (how many, to whom); never sales |
| L | delivery note | skipped – its invoice (R, same amount) is already counted |
| U, others | | skipped |

The lists are `szamla_bf` and `ajanlat_bf` in `[szamlak]` of `config/oszlopok.toml`;
the ⚠ status tab shows how many documents of each type arrived and what was done
with them. Checked against proALPHA's own report for customer 3000146: the R invoices
match it exactly; counting the delivery notes too would have doubled the amounts.

Other columns used (see `[szamlak.oszlopok]`):

| CSV column | Field | Notes |
|---|---|---|
| V_BelegKopf_Obj | `doc_id` | internal document ID: the export repeats some documents on identical rows; they count once |
| BizSz | `id` | document number |
| Vevő | `customer_id` | links the document to the customer (leading zeros don't matter) |
| Bizonylatdátum | `date` | decides the period. For the date of supply use `"Adódátum#3"` |
| Végösszeg / Br. végösszeg | `net` / `gross` | |
| Pn | `currency` | same code list as the customer export |
| SzlT | `kind` | types listed in `negativ_tipusok` (default "Jóváírás") count negative |
| Ügyintéző | `clerk` | the user who issued the document (e.g. `csikos.tamas`). Offers go to this Ügyintéző; pair user names with the customer export's names in `[ugyintezok]` of `config/kodlistak.toml` if they differ |

- Currencies are never added together; every total is per currency.
- The export has no payment data, so open invoices are switched off (the customer
  page shows the latest invoices instead).
- Documents of blocked or unknown customers are skipped and reported.

## The viewed period

Chart bars are clickable: a sales bar (dashboard, Sales tab, customer and Ügyintéző pages) opens the Sales tab on that date range with the same filters (customer, Ügyintéző, currency) and a finer breakdown, with the period's invoices listed at the bottom (sortable, CSV export); a bar of the new-customers chart opens the customers created that month. Rows of the Sales period table link the same way.

The period picker in the top bar sets the period for every "this period" figure on
the site: sales, active and new customers, offers, the Ügyintéző and customer pages,
and the Sales tab (which can still take its own custom dates). Options: this year,
last 12 months, this/last quarter, this/last half year, last year, last 2 or 3 years,
all time, shared periods and custom periods. The choice is remembered per browser.

- **Fiscal year** and **shared periods** (everyone sees them) are set in
  `config/idoszakok.toml`: `uzleti_ev_kezdete` (first month of the fiscal year;
  this/last year, quarters, half years and the 2–3 year periods follow it) and any
  number of `[[idoszak]]` blocks with `nev`, `kezdete`, `vege`. The importer checks the
  file and picks up changes within a minute.
- **Custom periods** for one browser only are added in ⚙ Settings.
- A period reaching past today ends today.

Every figure is compared with the same period one year earlier; for periods longer
than a year with the equally long period before it (so the two never overlap);
"all time" has no comparison.

## How the numbers are verified

1. **Automated tests** for the importer (parsing, matching, duplicates, credit notes,
   blocked customers, document types, offers, exact totals, row accounting):
   ```bash
   docker compose run --rm importer python -m unittest -v
   ```
2. **Control totals.** The importer writes the invoice count and the net sum per currency
   (exact, in cents) to `meta.json`. The page recomputes them on its own: from the
   invoices, via the customers, via the Ügyintézők and period by period (every invoice in
   exactly one week/month/quarter/half/year), and checks that every invoice row is
   accounted for (invoices + offers + skipped types + invalid + blocked customers' + duplicates
   = rows in the file), and that every offer belongs to exactly one Ügyintéző.
   The results are on the ⚠ status tab ("Ellenőrzések"); any mismatch turns the icon red.
3. **Matching rules:** customer numbers match regardless of leading zeros
   (`0003000048` = `3000048`); Ügyintéző names that differ only in case or spacing are one
   person (reported as a warning); sales per Ügyintéző use the customer's *current*
   Ügyintéző, so a customer's whole history moves with it if the Ügyintéző changes.

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
