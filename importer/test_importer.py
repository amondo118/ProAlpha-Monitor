"""Tests for the importer: parsing, matching and the numbers.

Run (from the project folder):
    docker compose run --rm importer python -m unittest -v
or without Docker:
    cd importer && python3 -m unittest -v

The tests use their own small config and invented sample files, so they don't
depend on config/*.toml or on real data.
"""

import csv
import os
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

import datasets
import fake_data
import importer
import sap_parse

COLUMNS = """
[zarolt]
jelzok = ["ZÁROLT"]

[vevok]
felismeres = ["id", "name"]
[vevok.oszlopok]
id = "Vevő"
name = "Név"
search_term = "Keresőfogalom"
account_manager = "Ügyintéző"
currency = "Pn"

[szamlak]
felismeres = ["id", "customer_id", "date", "net"]
negativ_tipusok = ["Jóváírás"]
[szamlak.oszlopok]
doc_id = "V_BelegKopf_Obj"
id = "BizSz"
customer_id = "Vevő"
date = "Bizonylatdátum"
net = "Végösszeg"
gross = "Br. végösszeg"
currency = "Pn"
kind = "SzlT"
"""
CODES = """
[penznemek]
"0" = "HUF"
"1" = "EUR"
"""


class ImporterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        (self.dir / "oszlopok.toml").write_text(COLUMNS, encoding="utf-8")
        (self.dir / "kodlistak.toml").write_text(CODES, encoding="utf-8")
        self.cfg = datasets.load_config(self.dir)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, header, rows, delimiter="\t", encoding="cp1250"):
        path = self.dir / name
        with open(path, "w", encoding=encoding, newline="") as f:
            w = csv.writer(f, delimiter=delimiter)
            w.writerow(header)
            w.writerows(rows)
        return path

    def customers(self, rows):
        return self.write("vevok.csv", ["Vevő", "Név", "Keresőfogalom", "Ügyintéző", "Pn"], rows)

    def invoices(self, rows):
        # the real invoice export is comma-separated UTF-8
        return self.write("szamlak.csv", ["V_BelegKopf_Obj", "BizSz", "Vevő", "Bizonylatdátum", "Végösszeg", "Br. végösszeg", "Pn", "SzlT"],
                          rows, delimiter=",", encoding="utf-8")

    def build(self, *paths):
        return importer.build(list(paths), self.cfg)

    # ---- parsing ----

    def test_hungarian_numbers_and_dates(self):
        self.assertEqual(sap_parse.parse_number("1.234.567,89"), Decimal("1234567.89"))
        self.assertEqual(sap_parse.parse_number("1 234 567,89"), Decimal("1234567.89"))
        self.assertEqual(sap_parse.parse_number("12,5-"), Decimal("-12.5"))
        self.assertIsNone(sap_parse.parse_number(""))
        self.assertEqual(sap_parse.parse_date("2026.06.08"), "2026-06-08")
        self.assertEqual(sap_parse.parse_date("2026. 06. 08."), "2026-06-08")
        self.assertEqual(sap_parse.parse_date("20260608"), "2026-06-08")
        self.assertEqual(sap_parse.parse_date("08.06.2026"), "2026-06-08")
        self.assertIsNone(sap_parse.parse_date("00000000"))
        with self.assertRaises(ValueError):
            sap_parse.parse_date("2026.13.45")

    # ---- matching ----

    def test_customer_numbers_match_regardless_of_leading_zeros(self):
        c = self.customers([["0003000048", "Alfa Kft.", "ALFA", "Kiss Zoltán", "0"]])
        i = self.invoices([["d1", "5", "3000048", "2026.06.08", "1.000,00", "1.270,00", "0", "Számla"]])
        data, sources, warnings = self.build(c, i)
        self.assertEqual(len(data["invoices"]), 1)
        self.assertEqual(data["invoices"][0]["customer_id"], "0003000048")  # the customer export's spelling
        self.assertEqual(sources["invoices"]["unmatched"], 0)
        self.assertEqual(warnings, [])

    def test_unknown_customer_is_reported(self):
        c = self.customers([["3000001", "Alfa Kft.", "ALFA", "", "0"]])
        i = self.invoices([["d1", "5", "3999999", "2026.06.08", "100,00", "127,00", "0", "Számla"]])
        data, sources, warnings = self.build(c, i)
        self.assertEqual(sources["invoices"]["unmatched"], 1)
        self.assertTrue(any("unknown customer 3999999" in w for w in warnings))
        # not counted in the control totals the page compares against
        self.assertEqual(importer.control_totals(data)["invoices_by_currency"], {})

    def test_manager_spellings_are_one_person(self):
        c = self.customers([
            ["1", "A Kft.", "A", "Kovács Péter", "0"],
            ["2", "B Kft.", "B", "Kovács Péter", "0"],
            ["3", "C Kft.", "C", "KOVÁCS  PÉTER ", "0"],
            ["4", "D Kft.", "D", "Nagy Eszter", "0"],
        ])
        data, sources, warnings = self.build(c)
        self.assertEqual({x["account_manager"] for x in data["customers"]}, {"Kovács Péter", "Nagy Eszter"})
        self.assertEqual(sources["customers"]["managers"], 2)
        self.assertTrue(any("treated as 'Kovács Péter'" in w for w in warnings))

    def test_blocked_customers_and_their_invoices_are_dropped(self):
        c = self.customers([
            ["1", "Alfa Kft.", "ALFA", "", "0"],
            ["2", "Zárolt - Beta Kft.", "BETA", "", "0"],   # marker in the name
            ["3", "Gamma Kft.", "*ZAROLT*", "", "0"],       # marker in the search term, no accent
        ])
        i = self.invoices([
            ["d1", "5", "1", "2026.06.08", "100,00", "127,00", "0", "Számla"],
            ["d2", "6", "2", "2026.06.08", "200,00", "254,00", "0", "Számla"],
            ["d3", "7", "3", "2026.06.08", "300,00", "381,00", "0", "Számla"],
        ])
        data, sources, _ = self.build(c, i)
        self.assertEqual([x["id"] for x in data["customers"]], ["1"])
        self.assertEqual([x["id"] for x in data["invoices"]], ["5"])
        self.assertEqual(sources["customers"]["skipped_blocked"], 2)
        self.assertEqual(sources["invoices"]["skipped_blocked"], 2)

    # ---- invoices and numbers ----

    def test_duplicate_rows_count_once_and_conflicts_are_reported(self):
        c = self.customers([["1", "Alfa Kft.", "ALFA", "", "0"]])
        row = ["d1", "5", "1", "2026.06.08", "795.600,00", "1.010.412,00", "0", "Számla"]
        conflict = ["d2", "7", "1", "2026.06.08", "100,00", "127,00", "0", "Számla"]
        i = self.invoices([row, row, row, conflict, conflict[:4] + ["999,00", "999,00", "0", "Számla"]])
        data, sources, warnings = self.build(c, i)
        self.assertEqual(len(data["invoices"]), 2)
        self.assertEqual(sources["invoices"]["duplicates_merged"], 2)
        self.assertTrue(any("appears again with different values" in w for w in warnings))
        # the first copy of a conflicting invoice is kept
        self.assertEqual(sorted(x["net"] for x in data["invoices"]), [100, 795600])

    def test_credit_notes_count_negative(self):
        c = self.customers([["1", "Alfa Kft.", "ALFA", "", "0"]])
        i = self.invoices([
            ["d1", "5", "1", "2026.06.08", "1.000,00", "1.270,00", "0", "Számla"],
            ["d2", "6", "1", "2026.06.09", "200,00", "254,00", "0", "Jóváírás"],   # positive in the export
            ["d3", "7", "1", "2026.06.10", "50,00-", "63,50-", "0", "jóváírás"],   # already negative, other case
        ])
        data, sources, _ = self.build(c, i)
        nets = {x["id"]: x["net"] for x in data["invoices"]}
        self.assertEqual(nets, {"5": 1000, "6": -200, "7": -50})
        self.assertTrue(all(x.get("credit") for x in data["invoices"] if x["id"] in ("6", "7")))
        self.assertEqual(sources["invoices"]["kinds"], {"Számla": 1, "Jóváírás": 1, "jóváírás": 1})

    def test_control_totals_are_exact_and_per_currency(self):
        c = self.customers([["1", "Alfa Kft.", "ALFA", "", "0"], ["2", "Beta GmbH", "BETA", "", "1"]])
        i = self.invoices([
            ["d1", "1", "1", "2026.01.02", "0,10", "0,13", "0", "Számla"],
            ["d2", "2", "1", "2026.01.03", "0,20", "0,25", "0", "Számla"],
            ["d3", "3", "1", "2026.01.04", "1.234.567,89", "1.567.901,22", "0", "Számla"],
            ["d4", "4", "2", "2026.01.05", "2.414,16", "2.414,16", "1", "Számla"],
            ["d5", "5", "2", "2026.01.06", "14,16", "14,16", "1", "Jóváírás"],
        ])
        data, _, _ = self.build(c, i)
        checks = importer.control_totals(data)
        # 0,10 + 0,20 + 1 234 567,89 = 1 234 568,19 exactly (no float error), EUR 2 414,16 − 14,16
        self.assertEqual(checks["net_cents_by_currency"], {"HUF": 123456819, "EUR": 240000})
        self.assertEqual(checks["invoices_by_currency"], {"HUF": 3, "EUR": 2})

    def test_every_invoice_row_is_accounted_for(self):
        c = self.customers([["1", "Alfa Kft.", "ALFA", "", "0"], ["2", "ZÁROLT Beta", "BETA", "", "0"]])
        i = self.invoices([
            ["d1", "1", "1", "2026.01.02", "100,00", "127,00", "0", "Számla"],
            ["d1", "1", "1", "2026.01.02", "100,00", "127,00", "0", "Számla"],   # duplicate
            ["d2", "2", "2", "2026.01.02", "100,00", "127,00", "0", "Számla"],   # blocked customer
            ["d3", "", "1", "2026.01.02", "100,00", "127,00", "0", "Számla"],    # no invoice number
            ["d4", "4", "9", "2026.01.02", "100,00", "127,00", "0", "Számla"],   # unknown customer (kept, reported)
        ])
        _, sources, _ = self.build(c, i)
        s = sources["invoices"]
        self.assertEqual(s["raw_rows"], s["rows"] + s["skipped_rows"] + s["skipped_blocked"] + s["duplicates_merged"])
        self.assertEqual((s["rows"], s["skipped_rows"], s["skipped_blocked"], s["duplicates_merged"], s["unmatched"]), (2, 1, 1, 1, 1))

    def test_fake_exports_import_cleanly(self):
        cfg = datasets.load_config(Path(os.environ.get("CONFIG_DIR", Path(__file__).resolve().parent.parent / "config")))
        files = fake_data.write_all(self.dir, cfg)
        data, sources, warnings = importer.build(files, cfg)
        self.assertEqual(warnings, [])
        s = sources["invoices"]
        self.assertEqual(s["raw_rows"], s["rows"] + s["skipped_rows"] + s["skipped_blocked"] + s["duplicates_merged"])
        self.assertGreater(s["duplicates_merged"], 0)
        self.assertTrue(all(x["net"] < 0 for x in data["invoices"] if x.get("credit")))


if __name__ == "__main__":
    unittest.main()
