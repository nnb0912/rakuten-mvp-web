#!/usr/bin/env python3
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path

SCRIPT = Path(__file__).with_name('scripts_refresh_rpp_settings_csvs.py')
spec = importlib.util.spec_from_file_location('scripts_refresh_rpp_settings_csvs', SCRIPT)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakePage:
    def __init__(self, continuing='8,253,154 円', effective='5,000,000 円'):
        self.url = ''
        self.results = [
            {'continuingBudget': continuing, 'effectiveBudget': effective, 'continuingAsOf': '(09/15 時点)', 'effectiveAsOf': '(09/15 時点)'},
            {'expectedCount': 4, 'countMatchCount': 1, 'invalidRows': [], 'duplicateIds': False, 'rows': [
                {'id': '1', 'active': True, 'budget': '5,000,000 円'},
                {'id': '2', 'active': False, 'budget': '1,550,000 円'},
                {'id': '3', 'active': False, 'budget': '5,000 円'},
                {'id': '4', 'active': False, 'budget': '1,698,154 円'},
            ]},
        ]

    async def goto(self, url, **kwargs):
        self.url = url

    async def wait_for_function(self, expression, timeout=None):
        return None

    async def wait_for_timeout(self, value):
        return None

    async def evaluate(self, script):
        return self.results.pop(0)


class BudgetObservationTest(unittest.TestCase):
    def test_history_selection_accepts_only_genuinely_new_exact_row(self):
        label = '登録済み商品全件ダウンロード'
        lower = datetime(2026, 9, 16, 22, 0, tzinfo=module.JST)
        old = {'index': 1, 'id': 'old-1', 'text': f'{label} 完了 ダウンロード', 'cells': ['2026-09-16 21:59:00', '完了', 'ダウンロード', '商品・キーワード設定', label]}
        old_id, old_signature = module.history_row_identity(old)
        rows = [
            old,
            {'index': 2, 'id': 'new-1', 'text': f'{label} 完了 ダウンロード', 'cells': ['2026-09-16 22:00:01', '完了', 'ダウンロード', '商品・キーワード設定', label]},
            {'index': 3, 'id': 'new-2', 'text': '商品全件 完了 ダウンロード', 'cells': ['商品全件', '完了']},
        ]
        selected = module.select_new_completed_history_row(rows, label, {old_id}, {old_signature}, lower)
        self.assertEqual('id:new-1', selected)

    def test_history_selection_rejects_ambiguous_new_rows_and_has_no_broad_fallback(self):
        label = '手動登録済みキーワード全件ダウンロード'
        lower = datetime(2026, 9, 16, 22, 0, tzinfo=module.JST)
        self.assertIsNone(module.select_new_completed_history_row(
            [{'index': 1, 'id': 'new', 'text': 'キーワード全件 完了 ダウンロード', 'cells': ['2026-09-16 22:00:01', '完了', 'ダウンロード', '商品・キーワード設定', 'キーワード全件']}], label, set(), set(), lower
        ))
        with self.assertRaisesRegex(RuntimeError, 'multiple genuinely new'):
            module.select_new_completed_history_row([
                {'index': 1, 'id': 'new-1', 'text': f'{label} 完了', 'cells': [label, '完了']},
                {'index': 2, 'id': 'new-2', 'text': f'{label} 完了', 'cells': [label, '完了']},
            ], label, set(), set(), lower)

    def test_history_selection_rejects_idless_preexisting_row_after_status_change(self):
        label = '登録済み商品全件ダウンロード'
        lower = datetime(2026, 9, 16, 22, 0, tzinfo=module.JST)
        pre = {'index': 4, 'id': '', 'text': f'{label} 処理中', 'cells': ['2026-09-16 22:00:01', '処理中', '', '商品・キーワード設定', label]}
        _, signature = module.history_row_identity(pre)
        completed = {'index': 4, 'id': '', 'text': f'{label} 完了 ダウンロード', 'cells': ['2026-09-16 22:00:01', '完了', 'ダウンロード', '商品・キーワード設定', label]}
        self.assertIsNone(module.select_new_completed_history_row([completed], label, set(), {signature}, lower))

    def test_idless_history_uses_request_bounded_timestamp_selector(self):
        label = '登録済み商品全件ダウンロード'
        lower = datetime(2026, 9, 16, 22, 0, tzinfo=module.JST)
        stale = {'id': '', 'text': f'{label} 完了', 'cells': ['2026-09-16 21:59:59', '完了', 'ダウンロード', '商品・キーワード設定', label]}
        fresh = {'id': '', 'text': f'{label} 完了', 'cells': ['2026-09-16 22:00:01', '完了', 'ダウンロード', '商品・キーワード設定', label]}
        self.assertEqual('timestamp:2026-09-16 22:00:01', module.select_new_completed_history_row([stale, fresh], label, set(), set(), lower))
        deceptive = {'id': '', 'text': f'{label} 完了予定', 'cells': ['2026-09-16 22:00:02', '処理中（完了予定）', '', '商品・キーワード設定', label]}
        self.assertIsNone(module.select_new_completed_history_row([deceptive], label, set(), set(), lower))

    def test_runtime_project_directory_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            env = {**os.environ, 'RPP_PROJECT_DIR': directory}
            command = [
                sys.executable,
                '-c',
                (
                    'import importlib.util; '
                    f's=importlib.util.spec_from_file_location("collector", {str(SCRIPT)!r}); '
                    'm=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.PROJECT)'
                ),
            ]
            result = subprocess.run(command, env=env, text=True, capture_output=True, check=True)
            self.assertEqual(Path(result.stdout.strip()), Path(directory).resolve())
            self.assertTrue((Path(directory) / 'rpp_downloads').is_dir())

    def test_collects_only_fully_reconciled_budget(self):
        result = asyncio.run(module.collect_budget_observation(FakePage(), '2026-09-16T13:15:30+09:00'))
        self.assertEqual(result['status'], 'COMPLETE')
        self.assertEqual(result['effectiveBudget'], 5_000_000)
        self.assertEqual(result['continuingBudget'], 8_253_154)
        self.assertEqual(result['activeCampaignCount'], 1)
        self.assertTrue(result['complete'])

    def test_rejects_top_and_campaign_total_mismatch(self):
        with self.assertRaisesRegex(RuntimeError, 'effective budget mismatch'):
            asyncio.run(module.collect_budget_observation(FakePage(effective='4,999,999 円'), '2026-09-16T13:15:30+09:00'))

    def test_rejects_campaign_rows_with_missing_status_or_budget_controls(self):
        page = FakePage()
        page.results[1]['invalidRows'] = [0]
        with self.assertRaisesRegex(RuntimeError, 'rows or count are incomplete'):
            asyncio.run(module.collect_budget_observation(page, '2026-09-16T13:15:30+09:00'))

    def test_atomic_observation_write_reads_back_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'observation.json'
            value = {'version': 1, 'status': 'UNKNOWN', 'complete': False}
            module.write_budget_observation(value, path)
            self.assertEqual(json.loads(path.read_text(encoding='utf-8')), value)
            self.assertFalse(path.with_suffix('.json.tmp').exists())

    def test_as_of_date_uses_previous_year_for_december_at_new_year(self):
        self.assertEqual(module.infer_as_of_date(12, 31, date(2026, 1, 1)), '2025-12-31')
        self.assertEqual(module.infer_as_of_date(9, 15, date(2026, 9, 16)), '2026-09-15')


if __name__ == '__main__':
    unittest.main()
