#!/usr/bin/env python3
import importlib.util
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
        required = {'snapshotSender', 'productReportDownloader', 'productReportDownloaderTests', 'rmsLoginHelper', 'performanceContract', 'schedulerWrapper', 'deployVerifier'}
        self.assertTrue(required.issubset(module.ARTIFACTS))
        for name in required:
            self.assertTrue(module.ARTIFACTS[name][0].exists(), name)

    def test_wrapper_verifies_manifest_before_executing_attested_scheduler(self):
        source = WRAPPER.read_text(encoding='utf-8')
        verify = source.index('deploy_worker_runtime.py\" --verify-only')
        execute = source.index('$RPP_PROJECT_DIR/rpp_product_delivery_scheduler.py')
        self.assertLess(verify, execute)
        self.assertIn('exit 1', source[verify:execute])


if __name__ == '__main__':
    unittest.main()
