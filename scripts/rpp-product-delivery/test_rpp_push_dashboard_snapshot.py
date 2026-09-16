#!/usr/bin/env python3
import csv
import datetime as dt
import hashlib
import importlib.util
import json
import hmac
import os
import shutil
import tempfile
import unittest
from unittest import mock
from pathlib import Path

SCRIPT = Path(__file__).with_name('rpp_push_dashboard_snapshot.py')
spec = importlib.util.spec_from_file_location('rpp_push_dashboard_snapshot', SCRIPT)
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


class OperationalDataTest(unittest.TestCase):
    def setUp(self):
        os.environ['RPP_PERFORMANCE_RECEIPT_HMAC_KEY'] = 'test-only-rpp-performance-receipt-key-123456'

    def test_performance_daily_builds_single_day_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'rpp_item_reports.csv'
            date = (dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date() - dt.timedelta(days=1)).isoformat()
            label = dt.date.fromisoformat(date).strftime('%Y年%m月%d日')
            self._write_csv(path, ['日付', '商品管理番号', 'CTR(%)', 'クリック数(合計)', '実績額(合計)', '売上金額(合計12時間)', '売上件数(合計12時間)', '売上金額(合計720時間)', '売上件数(合計720時間)'], [[f'{label}～{label}', 'R0406', '1.5', '10', '300', '500', '1', '900', '2']])
            self._write_performance_receipt(root, path, date, 1)
            old_project = module.PROJECT
            try:
                module.PROJECT = root
                result = module.performance_daily(path)
            finally:
                module.PROJECT = old_project
            self.assertEqual(result['date'], date)
            self.assertEqual(result['rows'][0], {'itemCode': 'r0406', 'ctr': 1.5, 'clicks': 10, 'spend': 300, 'sales12h': 500, 'orders12h': 1, 'sales720h': 900, 'orders720h': 2})
            self.assertTrue(result['receipt']['complete'])

    def test_performance_daily_rejects_forged_receipt_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'rpp_item_reports.csv'
            date = (dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date() - dt.timedelta(days=1)).isoformat()
            label = dt.date.fromisoformat(date).strftime('%Y年%m月%d日')
            self._write_csv(path, ['日付', '商品管理番号', 'CTR(%)', 'クリック数(合計)', '実績額(合計)', '売上金額(合計12時間)', '売上件数(合計12時間)', '売上金額(合計720時間)', '売上件数(合計720時間)'], [[f'{label}～{label}', 'R0406', '1.5', '10', '300', '500', '1', '900', '2']])
            self._write_performance_receipt(root, path, date, 1)
            receipt_path = root / 'rpp_performance_generations' / 'generation-test' / 'receipt.json'
            receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
            receipt['signature'] = '0' * 64
            receipt_path.write_text(json.dumps(receipt), encoding='utf-8')
            old_project = module.PROJECT
            try:
                setattr(module, 'PROJECT', root)
                with self.assertRaisesRegex(RuntimeError, 'verified product report download receipt'):
                    module.performance_daily(path)
            finally:
                setattr(module, 'PROJECT', old_project)

    def test_performance_daily_rejects_ranges_and_duplicate_items(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rpp_item_reports.csv'
            headers = ['日付', '商品管理番号', 'CTR(%)', 'クリック数(合計)', '実績額(合計)', '売上金額(合計12時間)', '売上件数(合計12時間)', '売上金額(合計720時間)', '売上件数(合計720時間)']
            metrics = ['1', '1', '1', '1', '1', '1', '1']
            self._write_csv(path, headers, [['2026年09月01日～2026年09月02日', 'r0406', *metrics]])
            with self.assertRaisesRegex(RuntimeError, 'single-day'):
                module.performance_daily(path)
            self._write_csv(path, headers, [['2026年09月01日～2026年09月01日', 'r0406', *metrics], ['2026年09月01日～2026年09月01日', 'R0406', *metrics]])
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
        posted = json.loads(json.dumps(snapshot))
        changed_owner = json.loads(json.dumps(snapshot))
        changed_owner['rppData']['owners'] = ['別担当']
        with self.assertRaisesRegex(RuntimeError, 'full readback'):
            module.validate_snapshot_readback(payload, changed_owner, 200, posted)

    def test_rms_budget_observation_and_v5_readback_require_exact_totals(self):
        attempted = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=2)
        observed = attempted + dt.timedelta(seconds=41)
        attempted_jst = attempted.astimezone(dt.timezone(dt.timedelta(hours=9))).isoformat()
        observed_jst = observed.astimezone(dt.timezone(dt.timedelta(hours=9))).isoformat()
        observation = {
            'version': 1, 'status': 'COMPLETE', 'attemptedAt': attempted_jst,
            'observedAt': observed_jst, 'asOfDate': '2026-09-15',
            'source': 'RMS_RPP_TOP_AND_CAMPAIGNS', 'currency': 'JPY',
            'campaignCount': 4, 'activeCampaignCount': 1, 'effectiveBudget': 5_000_000,
            'continuingBudget': 8_253_154, 'activeCampaignBudgetTotal': 5_000_000,
            'allCampaignBudgetTotal': 8_253_154, 'complete': True,
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            budget_path = root / 'rpp_budget_observation.json'
            budget_path.write_text(json.dumps(observation), encoding='utf-8')
            old_project = module.PROJECT
            try:
                setattr(module, 'PROJECT', root)
                self.assertEqual(module.rms_budget_observation(), observation)
                broken = {**observation, 'effectiveBudget': 4_999_999}
                budget_path.write_text(json.dumps(broken), encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'totals do not match'):
                    module.rms_budget_observation()
                budget_path.write_text(json.dumps({**observation, 'currency': 'USD'}), encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'observation is invalid'):
                    module.rms_budget_observation()
                future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=1)).isoformat()
                budget_path.write_text(json.dumps({**observation, 'attemptedAt': future, 'observedAt': future}), encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'future'):
                    module.rms_budget_observation()
            finally:
                setattr(module, 'PROJECT', old_project)
        payload = {'syncedAt': '2026-09-16T04:16:12Z', 'rmsBudget': observation, 'rppData': {'configuredTargets': [], 'allConfiguredTargets': [], 'exclusionProducts': [], 'owners': []}}
        normalized_observation = {
            **observation,
            'attemptedAt': attempted.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'observedAt': observed.astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        }
        snapshot = {'schemaVersion': 5, 'syncedAt': payload['syncedAt'], 'rmsBudget': normalized_observation, 'rppData': payload['rppData']}
        module.validate_snapshot_readback(payload, snapshot, 200)
        with self.assertRaisesRegex(RuntimeError, 'RMS budget'):
            module.validate_snapshot_readback(payload, {**snapshot, 'rmsBudget': {**normalized_observation, 'effectiveBudget': 1}}, 200)

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

    def test_stale_performance_retries_snapshot_without_overwriting_newer_facts(self):
        payload = {'syncedAt': '2026-09-16T08:30:00Z', 'performanceDaily': {'date': '2026-09-14', 'rows': []}, 'rppData': {}}
        canonical = {**payload, 'performanceDaily': None}
        with mock.patch.object(module, 'request', side_effect=[
            (400, {'error': 'performance daily date is older than latest persisted date'}),
            (201, {'ok': True, 'snapshot': canonical}),
        ]) as mocked:
            posted_payload, status, posted, skipped = module.post_snapshot('token', payload)
        self.assertEqual(status, 201)
        self.assertTrue(posted['ok'])
        self.assertTrue(skipped)
        self.assertIsNone(posted_payload['performanceDaily'])
        self.assertEqual(mocked.call_count, 2)
        self.assertEqual(mocked.call_args_list[1].args, ('POST', 'token', canonical))

    def test_snapshot_does_not_retry_unrelated_validation_errors(self):
        payload = {'syncedAt': '2026-09-16T08:30:00Z', 'performanceDaily': {'date': '2026-09-14', 'rows': []}}
        with mock.patch.object(module, 'request', return_value=(400, {'error': 'another validation error'})) as mocked:
            posted_payload, status, posted, skipped = module.post_snapshot('token', payload)
        self.assertEqual((posted_payload, status, posted, skipped), (payload, 400, {'error': 'another validation error'}, False))
        self.assertEqual(mocked.call_count, 1)

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
        now = dt.datetime.now(dt.timezone.utc)
        request = now - dt.timedelta(seconds=2)
        history = (now - dt.timedelta(seconds=1)).astimezone(dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d %H:%M:%S')
        verification_request = now - dt.timedelta(seconds=5)
        verification_history = (now - dt.timedelta(seconds=4)).astimezone(dt.timezone(dt.timedelta(hours=9))).strftime('%Y-%m-%d %H:%M:%S')
        verification_source_mtime = (now - dt.timedelta(seconds=3)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        verification_completed_at = (now - dt.timedelta(seconds=2)).isoformat()
        source_mtime = dt.datetime.fromtimestamp(output.stat().st_mtime, dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        normalized_rows = module.parse_performance_csv(output)[1]
        receipt = {
            'version': 1, 'ok': True, 'download_complete': True, 'start_date': date, 'end_date': date,
            'output': str(output), 'expected_count': rows, 'actual_count': rows, 'expected_item_set_sha256': module.item_set_sha256(normalized_rows), 'output_sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'completed_at': now.isoformat(), 'request_started_at': request.isoformat(), 'history_created_at': history,
            'history_row_sha256': 'b' * 64, 'source_archive_sha256': 'c' * 64, 'source_archive_bytes': 1000,
            'source_csv_crc32': 'deadbeef', 'source_csv_compressed_bytes': 800, 'source_csv_uncompressed_bytes': output.stat().st_size,
            'source_csv_name_sha256': 'd' * 64, 'source': output.name, 'source_mtime': source_mtime,
            'verification_request_started_at': verification_request.isoformat(), 'verification_history_created_at': verification_history,
            'verification_history_row_sha256': 'e' * 64, 'verification_archive_sha256': 'f' * 64,
            'verification_source_mtime': verification_source_mtime, 'verification_completed_at': verification_completed_at,
            'rows_sha256': module.rows_sha256(normalized_rows),
        }
        receipt['signature'] = hmac.new(os.environ['RPP_PERFORMANCE_RECEIPT_HMAC_KEY'].encode(), module.performance_receipt_message(receipt), hashlib.sha256).hexdigest()
        generation = root / 'rpp_performance_generations' / 'generation-test'
        generation.mkdir(parents=True)
        report = generation / 'rpp_item_reports.csv'
        shutil.copy2(output, report)
        output.unlink()
        (generation / 'receipt.json').write_text(json.dumps(receipt), encoding='utf-8')
        output.symlink_to(report.relative_to(output.parent))

    @staticmethod
    def _write_csv(path: Path, fieldnames: list[str], rows: list[list[str]]) -> None:
        with path.open('w', encoding='cp932', newline='') as handle:
            writer = csv.writer(handle)
            writer.writerow(fieldnames)
            writer.writerows(rows)


if __name__ == '__main__':
    unittest.main()
