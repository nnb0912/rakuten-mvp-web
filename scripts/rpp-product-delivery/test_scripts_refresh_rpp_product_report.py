#!/usr/bin/env python3
import csv
import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('scripts_refresh_rpp_product_report.py')
spec = importlib.util.spec_from_file_location('scripts_refresh_rpp_product_report', SCRIPT)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProductReportRefreshTest(unittest.TestCase):
    def test_extract_csv_accepts_complete_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            setattr(module, 'DOWNLOADS', root)
            source = root / 'report.csv'
            self._write(source, [['コントロールカラム', '商品管理番号', 'クリック数', '売上金額', 'ROAS'], ['', 'r0406', '10', '900', '300']])
            _, rows, extracted = module.extract_csv(source)
            self.assertEqual(len(rows) - 1, 1)
            self.assertTrue(extracted.exists())

    def test_extract_csv_rejects_truncated_row(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            setattr(module, 'DOWNLOADS', root)
            source = root / 'report.csv'
            self._write(source, [['コントロールカラム', '商品管理番号', 'クリック数', '売上金額', 'ROAS'], ['', 'r0406', '10']])
            with self.assertRaisesRegex(RuntimeError, 'truncated'):
                module.extract_csv(source)

    @staticmethod
    def _write(path: Path, rows: list[list[str]]) -> None:
        with path.open('w', encoding='cp932', newline='') as handle:
            csv.writer(handle).writerows(rows)


if __name__ == '__main__':
    unittest.main()
