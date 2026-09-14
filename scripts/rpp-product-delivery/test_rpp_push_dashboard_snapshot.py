#!/usr/bin/env python3
import csv
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('rpp_push_dashboard_snapshot.py')
spec = importlib.util.spec_from_file_location('rpp_push_dashboard_snapshot', SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


class OperationalDataTest(unittest.TestCase):
    def test_performance_daily_builds_single_day_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'rpp_item_reports.csv'
            self._write_csv(path, ['日付', '商品管理番号', 'CTR(%)', 'クリック数(合計)', '実績額(合計)', '売上金額(合計12時間)', '売上件数(合計12時間)', '売上金額(合計720時間)', '売上件数(合計720時間)'], [['2026年09月01日～2026年09月01日', 'R0406', '1.5', '10', '300', '500', '1', '900', '2']])
            self._write_performance_receipt(root, path, '2026-09-01', 1)
            old_project = module.PROJECT
            try:
                module.PROJECT = root
                result = module.performance_daily(path)
            finally:
                module.PROJECT = old_project
            self.assertEqual(result['date'], '2026-09-01')
            self.assertEqual(result['rows'][0], {'itemCode': 'r0406', 'ctr': 1.5, 'clicks': 10, 'spend': 300, 'sales12h': 500, 'orders12h': 1, 'sales720h': 900, 'orders720h': 2})
            self.assertTrue(result['receipt']['complete'])

    def test_performance_daily_rejects_ranges_and_duplicate_items(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rpp_item_reports.csv'
            headers = ['日付', '商品管理番号']
            self._write_csv(path, headers, [['2026年09月01日～2026年09月02日', 'r0406']])
            with self.assertRaisesRegex(RuntimeError, 'single-day'):
                module.performance_daily(path)
            self._write_csv(path, headers, [['2026年09月01日～2026年09月01日', 'r0406'], ['2026年09月01日～2026年09月01日', 'R0406']])
            with self.assertRaisesRegex(RuntimeError, 'duplicate item'):
                module.performance_daily(path)

    def test_excluded_product_rows_are_kept_only_in_all_configured_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_csv(root / 'rpp_item_settings.csv', ['商品管理番号', '商品名', '商品CPC', '除外登録済み商品'], [['r0406', 'ゴミ箱', '30', 'yes']])
            self._write_csv(root / 'rpp_keyword_settings.csv', ['商品管理番号', '商品名', '商品CPC', 'キーワード', 'キーワードCPC'], [['r0406', 'ゴミ箱', '30', 'ゴミ カラスよけ', '40']])
            self._write_csv(root / 'rpp_exclude_items.csv', ['商品管理番号'], [['r0406']])
            (root / 'rpp_logs').mkdir()
            (root / 'rpp_logs' / 'rpp_settings_refresh_20300101_000000.json').write_text(json.dumps({
                'exclude': {'output': str(root / 'rpp_exclude_items.csv'), 'rows': 1, 'expected_count': 1}
            }), encoding='utf-8')
            owner_path = root / 'owners.json'
            owner_path.write_text(json.dumps({'owners': {'r0406': '森下'}}, ensure_ascii=False), encoding='utf-8')
            old_project, old_owner = module.PROJECT, module.OWNER_MAP_PATH
            try:
                module.PROJECT, module.OWNER_MAP_PATH = root, owner_path
                result = module.operational_data()
            finally:
                module.PROJECT, module.OWNER_MAP_PATH = old_project, old_owner
            self.assertEqual(result['configuredTargets'], [])
            self.assertEqual([row['keyword'] for row in result['allConfiguredTargets']], ['ゴミ カラスよけ', '商品CPC'])
            self.assertTrue(result['exclusionProducts'][0]['excluded'])
            self.assertEqual(result['exclusionObservation']['expectedCount'], 1)
            self.assertEqual(result['exclusionObservation']['actualCount'], 1)
            self.assertTrue(result['exclusionObservation']['complete'])

    def test_readback_requires_schema_v4_and_exact_all_target_ids(self):
        payload = {
            'syncedAt': '2026-09-11T03:00:00Z',
            'rppData': {
                'configuredTargets': [],
                'allConfiguredTargets': [{'id': 'r0406__item'}, {'id': 'r0406__kw'}],
                'exclusionProducts': [{'itemCode': 'r0406'}],
                'exclusionObservation': {'observedAt': '2026-09-11T02:59:00Z', 'expectedCount': 1, 'actualCount': 1, 'complete': True},
                'owners': ['森下'],
            },
        }
        snapshot = {'schemaVersion': 4, 'syncedAt': payload['syncedAt'], 'rppData': payload['rppData']}
        module.validate_snapshot_readback(payload, snapshot, 200)
        with self.assertRaisesRegex(RuntimeError, 'schemaVersion'):
            module.validate_snapshot_readback(payload, {**snapshot, 'schemaVersion': 3}, 200)
        changed = json.loads(json.dumps(snapshot))
        changed['rppData']['allConfiguredTargets'][1]['id'] = 'different-id'
        with self.assertRaisesRegex(RuntimeError, 'allConfiguredTargets IDs'):
            module.validate_snapshot_readback(payload, changed, 200)
        changed_observation = json.loads(json.dumps(snapshot))
        changed_observation['rppData']['exclusionObservation']['actualCount'] = 0
        with self.assertRaisesRegex(RuntimeError, 'exclusionObservation'):
            module.validate_snapshot_readback(payload, changed_observation, 200)

    def test_readback_requires_performance_daily_date_and_row_count(self):
        payload = {
            'syncedAt': '2026-09-11T03:00:00Z',
            'performanceDaily': {'date': '2026-09-10', 'rows': [{'itemCode': 'r0406'}]},
            'rppData': {'configuredTargets': [], 'allConfiguredTargets': [], 'exclusionProducts': [], 'owners': []},
        }
        snapshot = {'schemaVersion': 4, 'syncedAt': payload['syncedAt'], 'performanceDaily': payload['performanceDaily'], 'rppData': payload['rppData']}
        module.validate_snapshot_readback(payload, snapshot, 200)
        snapshot['performanceDaily'] = {'date': '2026-09-09', 'rows': []}
        with self.assertRaisesRegex(RuntimeError, 'performanceDaily'):
            module.validate_snapshot_readback(payload, snapshot, 200)

    def test_performance_db_readback_requires_exact_items_metrics_and_source(self):
        expected = {
            'date': '2026-09-10', 'source': 'rpp_item_reports.csv', 'sourceMtime': '2026-09-11T01:00:00Z',
            'rows': [{'itemCode': 'r0406', 'ctr': 1.5, 'clicks': 10, 'spend': 300, 'sales12h': 500, 'orders12h': 1, 'sales720h': 900, 'orders720h': 2}],
        }
        actual_row = {**expected['rows'][0], 'source': expected['source'], 'sourceMtime': '2026-09-11T01:00:00.000Z'}
        module.validate_performance_readback(expected, {'date': expected['date'], 'rows': [actual_row]}, 200)
        changed = dict(actual_row)
        changed['sales720h'] = 901
        with self.assertRaisesRegex(RuntimeError, 'sales720h'):
            module.validate_performance_readback(expected, {'date': expected['date'], 'rows': [changed]}, 200)
        with self.assertRaisesRegex(RuntimeError, 'item codes'):
            module.validate_performance_readback(expected, {'date': expected['date'], 'rows': []}, 200)

    @staticmethod
    def _write_performance_receipt(root: Path, output: Path, date: str, rows: int) -> None:
        logs = root / 'rpp_logs'
        logs.mkdir(exist_ok=True)
        (logs / 'rpp_product_report_refresh_20260902_000000.json').write_text(json.dumps({
            'ok': True, 'download_complete': True, 'start_date': date, 'end_date': date,
            'output': str(output), 'expected_count': rows, 'actual_count': rows,
            'output_sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'completed_at': '2026-09-02T00:00:00+09:00',
        }), encoding='utf-8')

    @staticmethod
    def _write_csv(path: Path, fieldnames: list[str], rows: list[list[str]]) -> None:
        with path.open('w', encoding='cp932', newline='') as handle:
            writer = csv.writer(handle)
            writer.writerow(fieldnames)
            writer.writerows(rows)


if __name__ == '__main__':
    unittest.main()
