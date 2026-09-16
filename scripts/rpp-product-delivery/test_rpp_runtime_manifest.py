#!/usr/bin/env python3
import importlib.util
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = Path(__file__).with_name('deploy_worker_runtime.py')
WRAPPER = Path(__file__).with_name('rpp_product_delivery_scheduler_tick.sh')
HOURLY_WRAPPER = Path(__file__).with_name('rpp_hourly_dashboard_refresh.sh')
POSITION_WRAPPER = Path(__file__).with_name('rpp_position_dashboard_refresh.sh')
spec = importlib.util.spec_from_file_location('deploy_worker_runtime', DEPLOY)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeManifestContractTest(unittest.TestCase):
    def test_new_performance_pipeline_and_wrapper_are_attested(self):
        required = {'snapshotSender', 'settingsRefresh', 'settingsRefreshTests', 'dashboardRefreshOrchestrator', 'dashboardRefreshTests', 'recommendationGenerator', 'recommendationCpcAdvisor', 'recommendationAdStatus', 'recommendationPositionData', 'recommendationDisplayNames', 'recommendationNotifyOut', 'recommendationDataGuards', 'recommendationChatwork', 'positionMonitor', 'hourlyDashboardWrapper', 'positionDashboardWrapper', 'productReportDownloader', 'productReportDownloaderTests', 'rmsLoginHelper', 'performanceContract', 'performanceCanonicalVectors', 'snapshotPerformanceCanonicalVectors', 'schedulerWrapper', 'deployVerifier'}
        self.assertTrue(required.issubset(module.ARTIFACTS))
        for name in required:
            self.assertTrue(module.ARTIFACTS[name][0].exists(), name)

    def test_wrapper_verifies_manifest_before_executing_attested_scheduler(self):
        source = WRAPPER.read_text(encoding='utf-8')
        self.assertIn('deploy_worker_runtime.py\" --run-scheduler', source)
        self.assertNotIn('$RPP_PROJECT_DIR/rpp_product_delivery_scheduler.py', source)

    def test_dashboard_wrappers_execute_only_through_manifest_verifier(self):
        self.assertIn('--run-dashboard-refresh hourly', HOURLY_WRAPPER.read_text(encoding='utf-8'))
        self.assertIn('--run-dashboard-refresh positions', POSITION_WRAPPER.read_text(encoding='utf-8'))
        self.assertNotIn('rpp_frequent_dashboard_refresh.py hourly', HOURLY_WRAPPER.read_text(encoding='utf-8'))

    def test_recommendation_dependency_graph_loads_with_external_data_root(self):
        env = os.environ.copy()
        env['RPP_PROJECT_DIR'] = '/Users/nob/Projects/rpp-8am-notify'
        env['NODE_PATH'] = '/Users/nob/Projects/rpp-8am-notify/node_modules'
        result = subprocess.run(['node', str(module.ARTIFACTS['recommendationGenerator'][0]), '--runtime-preflight'], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])

    def test_web_contract_requires_all_v5_capabilities(self):
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def read(self): return json.dumps({'ok': True, 'snapshotSchemaMax': 5, 'rmsBudget': True, 'canonicalSnapshotReadback': True}).encode()
        with mock.patch.object(module, 'snapshot_token', return_value='redacted'), mock.patch.object(module.urllib.request, 'urlopen', return_value=Response()):
            self.assertTrue(module.verify_web_contract()['ok'])

    def test_verify_runtime_fails_on_tampered_sha_and_missing_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'artifact.py'
            target.write_text('print(1)\n', encoding='utf-8')
            manifest = root / 'manifest.json'
            old_artifacts, old_manifest = getattr(module, 'ARTIFACTS'), getattr(module, 'MANIFEST')
            try:
                setattr(module, 'ARTIFACTS', {'artifact': (target, target)})
                setattr(module, 'MANIFEST', manifest)
                manifest.write_text(json.dumps({'commit': 'test', 'artifacts': {'artifact': '0' * 64}}), encoding='utf-8')
                with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
                    module.verify_runtime()
                manifest.write_text(json.dumps({'commit': 'test', 'artifacts': {'artifact': hashlib.sha256(target.read_bytes()).hexdigest()}}), encoding='utf-8')
                self.assertTrue(module.verify_runtime()['ok'])
                target.unlink()
                with self.assertRaisesRegex(RuntimeError, 'artifact is missing'):
                    module.verify_runtime()
                real = root / 'real.py'
                real.write_text('print(1)\n', encoding='utf-8')
                target.symlink_to(real)
                with self.assertRaisesRegex(RuntimeError, 'symlink'):
                    module.verify_runtime()
            finally:
                setattr(module, 'ARTIFACTS', old_artifacts)
                setattr(module, 'MANIFEST', old_manifest)

    def test_run_scheduler_uses_private_verified_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / 'project'
            logs = project / 'rpp_apply_logs'
            logs.mkdir(parents=True)
            scheduler = root / 'scheduler.py'
            settings = root / 'settings.py'
            scheduler.write_text('ORIGINAL = True\n', encoding='utf-8')
            settings.write_text('SETTINGS = True\n', encoding='utf-8')
            manifest = logs / 'manifest.json'
            artifacts = {'scheduler': (scheduler, scheduler), 'settingsRefresh': (settings, settings)}
            manifest.write_text(json.dumps({'artifacts': {name: hashlib.sha256(target.read_bytes()).hexdigest() for name, (_, target) in artifacts.items()}}), encoding='utf-8')
            old = (getattr(module, 'ARTIFACTS'), getattr(module, 'MANIFEST'), getattr(module, 'PROJECT'))
            executed = {}
            def fake_run(command, **kwargs):
                scheduler.write_text('TAMPERED = True\n', encoding='utf-8')
                executed['bytes'] = Path(command[1]).read_bytes()
                return SimpleNamespace(returncode=0, stdout='', stderr='')
            try:
                setattr(module, 'ARTIFACTS', artifacts)
                setattr(module, 'MANIFEST', manifest)
                setattr(module, 'PROJECT', project)
                with mock.patch.object(module.subprocess, 'run', side_effect=fake_run):
                    self.assertEqual(module.run_verified_scheduler(), 0)
                self.assertEqual(executed['bytes'], b'ORIGINAL = True\n')
            finally:
                setattr(module, 'ARTIFACTS', old[0])
                setattr(module, 'MANIFEST', old[1])
                setattr(module, 'PROJECT', old[2])


if __name__ == '__main__':
    unittest.main()
