#!/usr/bin/env python3
import csv
import datetime as dt
import importlib.util
import zipfile
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
            _, rows, extracted, manifest = module.extract_csv(source)
            self.assertEqual(len(rows) - 1, 1)
            self.assertTrue(extracted.exists())
            self.assertEqual(manifest['source_csv_uncompressed_bytes'], source.stat().st_size)

    def test_extract_csv_rejects_truncated_row(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            setattr(module, 'DOWNLOADS', root)
            source = root / 'report.csv'
            self._write(source, [['コントロールカラム', '商品管理番号', 'クリック数', '売上金額', 'ROAS'], ['', 'r0406', '10']])
            with self.assertRaisesRegex(RuntimeError, 'truncated'):
                module.extract_csv(source)

    def test_extract_zip_returns_verified_provider_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            setattr(module, 'DOWNLOADS', root)
            csv_path = root / 'report.csv'
            self._write(csv_path, [['コントロールカラム', '商品管理番号', 'クリック数', '売上金額', 'ROAS'], ['', 'r0406', '10', '900', '300']])
            archive = root / 'report.zip'
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as handle:
                handle.write(csv_path, 'report.csv')
            _, rows, _, manifest = module.extract_csv(archive)
            self.assertEqual(len(rows) - 1, 1)
            self.assertEqual(manifest['source_csv_uncompressed_bytes'], csv_path.stat().st_size)
            self.assertRegex(manifest['source_csv_crc32'], r'^[a-f0-9]{8}$')

    def test_receipt_times_reject_impossible_order(self):
        receipt = {'request_started_at': '2026-09-14T20:00:00+09:00', 'history_created_at': '2000-01-01 00:00:00', 'source_mtime': '2026-09-14T11:00:01Z', 'completed_at': '2026-09-14T20:00:02+09:00'}
        with self.assertRaisesRegex(ValueError, 'timestamp order'):
            module.parse_receipt_times(receipt, dt.datetime(2026, 9, 14, 11, 1, tzinfo=dt.timezone.utc))

    def test_history_selection_requires_new_completed_row_after_boundary(self):
        start_jp, end_jp = '2026年09月13日', '2026年09月13日'
        old = f'2026-09-14 20:00:00 パフォーマンスレポート 商品レポートダウンロード 完了 {start_jp}～{end_jp}'
        fresh = f'2026-09-14 20:00:05 パフォーマンスレポート 商品レポートダウンロード 完了 {start_jp}～{end_jp}'
        rows = [{'index': 1, 'createdAt': '2026-09-14 20:00:00', 'text': old}, {'index': 2, 'createdAt': '2026-09-14 20:00:05', 'text': fresh}]
        self.assertEqual(module.select_history_row(rows, start_jp, end_jp, '2026-09-14 20:00:01', [old]), 2)
        self.assertEqual(module.select_history_row(rows[:1], start_jp, end_jp, '2026-09-14 20:00:01', []), -1)

    def test_refresh_lock_rejects_parallel_and_releases_after_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / 'refresh.lock'
            with module.exclusive_refresh_lock(lock):
                with self.assertRaisesRegex(RuntimeError, 'already running'):
                    with module.exclusive_refresh_lock(lock):
                        pass
            with self.assertRaisesRegex(RuntimeError, 'forced'):
                with module.exclusive_refresh_lock(lock):
                    raise RuntimeError('forced')
            with module.exclusive_refresh_lock(lock):
                pass

    @staticmethod
    def _write(path: Path, rows: list[list[str]]) -> None:
        with path.open('w', encoding='cp932', newline='') as handle:
            csv.writer(handle).writerows(rows)


if __name__ == '__main__':
    unittest.main()
