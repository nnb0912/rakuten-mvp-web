#!/usr/bin/env python3
import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = Path(__file__).with_name('deploy_worker_runtime.py')
WRAPPER = Path(__file__).with_name('rpp_product_delivery_scheduler_tick.sh')
spec = importlib.util.spec_from_file_location('deploy_worker_runtime', DEPLOY)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeManifestContractTest(unittest.TestCase):
    def test_new_performance_pipeline_and_wrapper_are_attested(self):
        required = {'snapshotSender', 'productReportDownloader', 'productReportDownloaderTests', 'rmsLoginHelper', 'performanceContract', 'performanceCanonicalVectors', 'snapshotPerformanceCanonicalVectors', 'schedulerWrapper', 'deployVerifier'}
        self.assertTrue(required.issubset(module.ARTIFACTS))
        for name in required:
            self.assertTrue(module.ARTIFACTS[name][0].exists(), name)

    def test_wrapper_verifies_manifest_before_executing_attested_scheduler(self):
        source = WRAPPER.read_text(encoding='utf-8')
        verify = source.index('deploy_worker_runtime.py\" --verify-only')
        execute = source.index('$RPP_PROJECT_DIR/rpp_product_delivery_scheduler.py')
        self.assertLess(verify, execute)
        self.assertIn('exit 1', source[verify:execute])

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
            finally:
                setattr(module, 'ARTIFACTS', old_artifacts)
                setattr(module, 'MANIFEST', old_manifest)


if __name__ == '__main__':
    unittest.main()
