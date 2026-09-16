#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('rpp_frequent_dashboard_refresh.py')
spec = importlib.util.spec_from_file_location('rpp_frequent_dashboard_refresh', SCRIPT)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FrequentDashboardRefreshTest(unittest.TestCase):
    def test_authenticated_target_url_is_pinned_and_redirects_are_rejected(self):
        with patch.dict(module.os.environ, {'RPP_DASHBOARD_URL': 'https://attacker.invalid'}):
            with self.assertRaisesRegex(RuntimeError, 'override is forbidden'):
                module.authenticated_api_url('/api/rpp/sync-snapshot?resource=targets')
        self.assertIsNone(module.NoRedirectHandler().redirect_request(None, None, 302, 'Found', {}, 'https://attacker.invalid'))

    def test_initialize_budget_unknown_replaces_previous_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rpp_budget_observation.json'
            path.write_text(json.dumps({'status': 'COMPLETE', 'effectiveBudget': 5_000_000}), encoding='utf-8')
            old_path = module.BUDGET_OBSERVATION
            try:
                setattr(module, 'BUDGET_OBSERVATION', path)
                module.initialize_budget_unknown()
            finally:
                setattr(module, 'BUDGET_OBSERVATION', old_path)
            value = json.loads(path.read_text(encoding='utf-8'))
            self.assertEqual(value['status'], 'UNKNOWN')
            self.assertIsNone(value['effectiveBudget'])
            self.assertFalse(value['complete'])
            self.assertFalse(path.with_suffix('.json.tmp').exists())

    def test_hourly_skips_recommendations_after_settings_failure_but_syncs_unknown(self):
        calls = []

        def fake_run(name, command, timeout, env=None):
            calls.append((name, command))
            return {'name': name, 'ok': name != 'settings', 'code': 1 if name == 'settings' else 0}

        with patch.object(module, 'initialize_budget_unknown') as initialize, patch.object(module, 'run_stage', side_effect=fake_run):
            stages = module.hourly()
        initialize.assert_called_once_with()
        self.assertEqual([stage['name'] for stage in stages], ['settings', 'recommendations', 'dashboard_sync'])
        self.assertEqual(stages[1]['skipped'], 'settings failed')
        self.assertEqual([name for name, _ in calls], ['settings', 'dashboard_sync'])
        self.assertIn('--failure-reason=settings_failed', calls[-1][1])

    def test_hourly_uses_failure_snapshot_when_recommendation_generation_fails(self):
        calls = []

        def fake_run(name, command, timeout, env=None):
            calls.append((name, command))
            return {'name': name, 'ok': name != 'recommendations', 'code': 1 if name == 'recommendations' else 0}

        with patch.object(module, 'initialize_budget_unknown'), patch.object(module, 'run_stage', side_effect=fake_run):
            stages = module.hourly()
        self.assertFalse(stages[1]['ok'])
        self.assertIn('--failure-reason=recommendations_failed', calls[-1][1])


if __name__ == '__main__':
    unittest.main()
