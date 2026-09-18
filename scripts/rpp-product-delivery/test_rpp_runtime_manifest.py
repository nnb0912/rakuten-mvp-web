#!/usr/bin/env python3
import importlib.util
import datetime as dt
import fcntl
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
AUTO_APPLY_WRAPPER = Path(__file__).with_name('rpp_allowed_auto_apply.sh')
spec = importlib.util.spec_from_file_location('deploy_worker_runtime', DEPLOY)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RuntimeManifestContractTest(unittest.TestCase):
    def test_new_performance_pipeline_and_wrapper_are_attested(self):
        required = {'snapshotSender', 'settingsRefresh', 'settingsRefreshTests', 'dashboardRefreshOrchestrator', 'dashboardRefreshTests', 'recommendationGenerator', 'recommendationCpcAdvisor', 'recommendationAdStatus', 'recommendationPositionData', 'recommendationDisplayNames', 'recommendationNotifyOut', 'recommendationDataGuards', 'recommendationChatwork', 'positionMonitor', 'hourlyDashboardWrapper', 'positionDashboardWrapper', 'productReportDownloader', 'productReportDownloaderTests', 'rmsLoginHelper', 'performanceContract', 'performanceCanonicalVectors', 'snapshotPerformanceCanonicalVectors', 'schedulerWrapper', 'schedulerDispatcher', 'schedulerDispatcherTests', 'schedulerDispatcherHealth', 'schedulerDispatcherHealthTests', 'schedulerDispatcherPlist', 'exclusionAdapter', 'deployVerifier', 'autoApply', 'autoApplyTests', 'autoApplyUploader', 'autoApplyUploaderTests', 'autoApplyWrapper'}
        self.assertTrue(required.issubset(module.ARTIFACTS))
        for name in required:
            self.assertTrue(module.ARTIFACTS[name][0].exists(), name)

    def test_wrapper_verifies_manifest_before_executing_attested_scheduler(self):
        source = WRAPPER.read_text(encoding='utf-8')
        self.assertIn('deploy_worker_runtime.py\" --run-scheduler', source)
        self.assertNotIn('$RPP_PROJECT_DIR/rpp_product_delivery_scheduler.py', source)

    def test_launchd_executes_dispatcher_only_through_manifest_verifier(self):
        plist = Path(__file__).with_name('com.rise.rpp-product-delivery-dispatcher.plist').read_text(encoding='utf-8')
        self.assertIn('/Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py', plist)
        self.assertIn('--run-scheduler-dispatcher', plist)
        self.assertNotIn('/Users/nob/Projects/rpp-8am-notify/rpp_product_delivery_dispatcher.py</string>', plist)

    def test_launchd_status_requires_exact_arguments_running_state_and_pid(self):
        valid = '''program = /usr/bin/python3
arguments = {
    /usr/bin/python3
    -s
    /Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py
    --run-scheduler-dispatcher
}
environment = {
    HOME => /Users/nob
    PATH => /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
    RPP_PROJECT_DIR => /Users/nob/Projects/rpp-8am-notify
    RPP_EVENT_DISPATCHER => 1
    PYTHONNOUSERSITE => 1
    OSLogRateLimit => 64
    XPC_SERVICE_NAME => com.rise.rpp-product-delivery-dispatcher
}
state = running
pid = 123
'''
        self.assertEqual(123, module.validate_loaded_dispatcher(valid))
        with self.assertRaisesRegex(RuntimeError, 'environment'):
            module.validate_loaded_dispatcher(valid.replace('OSLogRateLimit => 64', 'OSLogRateLimit => 64\n    UNEXPECTED => 1'))
        for malformed in ('FOO-BAR => 1', 'FOO.BAR => 1', '1BAD => 1', 'MALFORMED LINE'):
            with self.assertRaisesRegex(RuntimeError, 'malformed'):
                module.validate_loaded_dispatcher(valid.replace('OSLogRateLimit => 64',
                                                                  f'OSLogRateLimit => 64\n    {malformed}'))
        with self.assertRaisesRegex(RuntimeError, 'duplicate'):
            module.validate_loaded_dispatcher(valid.replace('OSLogRateLimit => 64',
                                                              'OSLogRateLimit => 64\n    HOME => /tmp'))
        with self.assertRaisesRegex(RuntimeError, 'environment'):
            module.validate_loaded_dispatcher(valid.replace('com.rise.rpp-product-delivery-dispatcher', 'com.evil.dispatcher'))
        with self.assertRaisesRegex(RuntimeError, 'exactly match'):
            module.validate_loaded_dispatcher(valid.replace('--run-scheduler-dispatcher', '--run-scheduler'))
        with self.assertRaisesRegex(RuntimeError, 'not running'):
            module.validate_loaded_dispatcher(valid.replace('state = running', 'state = exited'))
        with self.assertRaisesRegex(RuntimeError, 'PID'):
            module.validate_loaded_dispatcher(valid.replace('pid = 123', 'pid = 0'))
        with self.assertRaisesRegex(RuntimeError, 'does not match'):
            module.validate_loaded_dispatcher(valid.replace('RPP_EVENT_DISPATCHER => 1',
                                                              'RPP_EVENT_DISPATCHER => 1\n    PYTHONPATH => /tmp/hostile'))
        for hostile in ('RMS_LOGIN_PASS', 'RMS_LOGIN_ID', 'RAKUTEN_EMAIL_PASS',
                        'RPP_SNAPSHOT_SYNC_TOKEN', 'RPP_EXCLUSION_NODE_BIN',
                        'RPP_EXCLUSION_WORKER_LOCK', 'RPP_RMS_PROFILE_DIR'):
            with self.assertRaisesRegex(RuntimeError, 'does not match'):
                module.validate_loaded_dispatcher(valid.replace('RPP_EVENT_DISPATCHER => 1',
                                                                  f'RPP_EVENT_DISPATCHER => 1\n    {hostile} => hostile'))

    def test_dashboard_wrappers_execute_only_through_manifest_verifier(self):
        self.assertIn('--run-dashboard-refresh hourly', HOURLY_WRAPPER.read_text(encoding='utf-8'))
        position_source = POSITION_WRAPPER.read_text(encoding='utf-8')
        self.assertIn('--run-dashboard-refresh positions', position_source)
        self.assertIn('rpp_product_delivery_scheduler_tick.sh', position_source)
        self.assertNotIn('&& /Users/nob/.hermes/scripts/rpp_product_delivery_scheduler_tick.sh', position_source)
        self.assertNotIn('rpp_frequent_dashboard_refresh.py hourly', HOURLY_WRAPPER.read_text(encoding='utf-8'))

    def test_auto_apply_wrapper_and_post_refresh_use_only_attested_runtime(self):
        source = AUTO_APPLY_WRAPPER.read_text(encoding='utf-8')
        self.assertIn('deploy_worker_runtime.py --run-auto-apply', source)
        self.assertNotIn('.hermes', source)
        self.assertEqual(Path('/Users/nob/.hermes/scripts/rpp_allowed_auto_apply.sh'), module.ARTIFACTS['autoApplyWrapper'][1])
        deploy_source = DEPLOY.read_text(encoding='utf-8')
        self.assertIn('"RPP_POST_REFRESH_SCRIPT": str(generation / ARTIFACTS["dashboardRefreshOrchestrator"][1].name)', deploy_source)

    def test_recommendation_dependency_graph_loads_with_external_data_root(self):
        env = os.environ.copy()
        env['RPP_PROJECT_DIR'] = '/Users/nob/Projects/rpp-8am-notify'
        env['NODE_PATH'] = '/Users/nob/Projects/rpp-8am-notify/node_modules'
        result = subprocess.run(['node', str(module.ARTIFACTS['recommendationGenerator'][0]), '--runtime-preflight'], env=env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])

    def test_recommendation_generator_pins_authenticated_target_endpoint(self):
        generator = module.ARTIFACTS['recommendationGenerator'][0]
        env = os.environ.copy()
        env['RPP_PROJECT_DIR'] = '/Users/nob/Projects/rpp-8am-notify'
        env['NODE_PATH'] = '/Users/nob/Projects/rpp-8am-notify/node_modules'
        env['RPP_SNAPSHOT_SYNC_TOKEN'] = 'AUDIT_FAKE_TOKEN'
        malicious_probe = f"""
process.argv.push('--targets-url=https://attacker.invalid/collect');
let called = false;
global.fetch = async () => {{ called = true; throw new Error('fetch must not run'); }};
require({json.dumps(str(generator))}).syncTargetProfiles()
  .then(() => console.log(JSON.stringify({{called, rejected:false}})))
  .catch(error => console.log(JSON.stringify({{called, rejected:/override is forbidden/.test(error.message)}})));
"""
        blocked = subprocess.run(['node', '-e', malicious_probe], env=env, text=True, capture_output=True)
        self.assertEqual(0, blocked.returncode, blocked.stderr)
        self.assertEqual({'called': False, 'rejected': True}, json.loads(blocked.stdout.strip()))
        exact_probe = f"""
const fs = require('fs');
fs.mkdirSync = () => {{}};
fs.writeFileSync = () => {{}};
fs.renameSync = () => {{}};
let observed;
global.fetch = async (url, options) => {{ observed = {{url, redirect:options.redirect, authorization:options.headers.authorization}}; return {{ok:true,status:200,url,json:async()=>({{targets:[{{itemCode:'r1'}}]}})}}; }};
require({json.dumps(str(generator))}).syncTargetProfiles()
  .then(() => console.log(JSON.stringify(observed)))
  .catch(error => {{ console.error(error.stack); process.exitCode=1; }});
"""
        exact = subprocess.run(['node', '-e', exact_probe], env=env, text=True, capture_output=True)
        self.assertEqual(0, exact.returncode, exact.stderr)
        observed = json.loads(exact.stdout.strip())
        self.assertEqual('https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets', observed['url'])
        self.assertEqual('manual', observed['redirect'])
        self.assertEqual('Bearer AUDIT_FAKE_TOKEN', observed['authorization'])

    def test_web_contract_requires_all_v5_capabilities(self):
        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def read(self): return json.dumps({'ok': True, 'snapshotSchemaMax': 5, 'rmsBudget': True, 'canonicalSnapshotReadback': True}).encode()
        with mock.patch.object(module, 'snapshot_token', return_value='redacted'), mock.patch.object(module, 'open_exact_url', return_value=Response()):
            self.assertTrue(module.verify_web_contract()['ok'])
        with mock.patch.dict(os.environ, {'RPP_DASHBOARD_URL': 'https://attacker.invalid'}):
            with self.assertRaisesRegex(RuntimeError, 'override is forbidden'):
                module.verify_web_contract()

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
                with mock.patch.object(module, 'runtime_dependency_contract'):
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

    def test_canary_runs_registered_wrapper_and_persists_only_exact_no_change_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wrapper = root / 'scheduler.sh'
            wrapper.write_text('#!/bin/bash\n', encoding='utf-8')
            receipt_path = root / 'canary.json'
            manifest = {'commit': 'a' * 40, 'artifacts': {}}
            output = json.dumps({'kind': 'rppDeliveryDeploymentPreflight', 'ok': True,
                                 'candidateSafe': True, 'productionChange': False,
                                 'queueDepth': 0, 'plannedChanges': 0}) + '\n'
            old_artifacts, old_canary = module.ARTIFACTS, module.CANARY_RECEIPT
            try:
                setattr(module, 'ARTIFACTS', {'schedulerWrapper': (wrapper, wrapper)})
                setattr(module, 'CANARY_RECEIPT', receipt_path)
                with mock.patch.object(module, 'stable_bytes', return_value=json.dumps(manifest).encode()), \
                     mock.patch.object(module, 'require_fresh_preflight', return_value={'completedAt': '2026-09-17T00:00:00Z'}), \
                     mock.patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=output, stderr='')) as run:
                    result = module.run_dispatcher_canary()
                self.assertTrue(result['ok'])
                self.assertTrue(json.loads(receipt_path.read_text())['noChange'])
                self.assertEqual(run.call_args.args[0], ['/bin/bash', str(wrapper)])
                self.assertEqual(run.call_args.kwargs['env']['RPP_DEPLOYMENT_CANARY'], '1')
            finally:
                setattr(module, 'ARTIFACTS', old_artifacts)
                setattr(module, 'CANARY_RECEIPT', old_canary)

    def test_canary_verified_scheduler_is_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / 'project'
            (project / 'rpp_apply_logs').mkdir(parents=True)
            scheduler = root / 'scheduler.py'
            settings = root / 'settings.py'
            adapter = root / 'adapter.mjs'
            scheduler.write_text('X = 1\n', encoding='utf-8')
            settings.write_text('Y = 1\n', encoding='utf-8')
            adapter.write_text('export {};\n', encoding='utf-8')
            artifacts = {'scheduler': (scheduler, scheduler), 'settingsRefresh': (settings, settings),
                         'exclusionAdapter': (adapter, adapter)}
            manifest = project / 'rpp_apply_logs' / 'manifest.json'
            manifest.write_text(json.dumps({'commit': 'a' * 40, 'artifacts': {
                name: hashlib.sha256(target.read_bytes()).hexdigest() for name, (_, target) in artifacts.items()
            }}), encoding='utf-8')
            old = (module.ARTIFACTS, module.MANIFEST, module.PROJECT)
            observed = {}

            def fake_run(command, **kwargs):
                observed['command'] = command
                return SimpleNamespace(returncode=0, stdout='', stderr='')

            try:
                setattr(module, 'ARTIFACTS', artifacts)
                setattr(module, 'MANIFEST', manifest)
                setattr(module, 'PROJECT', project)
                with mock.patch.dict(os.environ, {'RPP_DEPLOYMENT_CANARY': '1'}), \
                     mock.patch.object(module, 'require_fresh_preflight'), \
                     mock.patch.object(module, 'runtime_dependency_contract', return_value={
                         'nodeRoot': '/tmp/node_modules', 'nodeTreeSha256': '1' * 64,
                         'pythonRoot': '/tmp/python_modules', 'pythonTreeSha256': '3' * 64,
                         'browserRoot': '/tmp/browser.app', 'browserTreeSha256': '2' * 64,
                         'chromiumExecutable': '/tmp/browser.app/chrome'}), \
                     mock.patch.object(module.subprocess, 'run', side_effect=fake_run):
                    self.assertEqual(module.run_verified_scheduler(), 0)
                self.assertIn('--deployment-preflight', observed['command'])
                self.assertNotIn('--execute', observed['command'])
            finally:
                setattr(module, 'ARTIFACTS', old[0])
                setattr(module, 'MANIFEST', old[1])
                setattr(module, 'PROJECT', old[2])

    def test_runtime_dependency_tree_hash_matches_adapter_implementation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'nested').mkdir()
            (root / 'nested' / 'a.txt').write_text('alpha')
            (root / 'b.bin').write_bytes(b'\x00\x01')
            (root / 'link').symlink_to('b.bin')
            script = ("import { treeSha256 } from '" +
                      str(ROOT / 'scripts' / 'rpp_apply_exclusion_upload.mjs') +
                      "'; console.log(treeSha256(process.argv[1]));")
            observed = subprocess.run(['node', '--input-type=module', '-e', script, str(root)],
                                      check=True, capture_output=True, text=True).stdout.strip()
            self.assertEqual(module.tree_sha256(root), observed)

    def test_activation_is_read_only_probe_before_final_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            activation_path = root / 'activation.json'
            canary_path = root / 'canary.json'
            now = dt.datetime.now(dt.timezone.utc)
            preflight = {'completedAt': now.isoformat().replace('+00:00', 'Z')}
            canary_path.write_text(json.dumps({'commit': 'a' * 40, 'noChange': True,
                'preflightCompletedAt': preflight['completedAt'],
                'completedAt': now.isoformat().replace('+00:00', 'Z')}))
            events = []

            def restart():
                receipt = json.loads(activation_path.read_text())
                self.assertFalse(receipt['activated'])
                self.assertTrue(receipt['probe'])
                events.append('probe-healthy')
                return 4321

            def notify(commit):
                receipt = json.loads(activation_path.read_text())
                self.assertFalse(receipt['activated'])
                self.assertTrue(receipt['probe'])
                self.assertEqual(commit, 'a' * 40)
                events.append('probe-notified')

            def wait_probe(*_args):
                self.assertFalse(json.loads(activation_path.read_text())['activated'])
                events.append('probe-verified')

            old = (module.ACTIVATION_RECEIPT, module.CANARY_RECEIPT)
            try:
                setattr(module, 'ACTIVATION_RECEIPT', activation_path)
                setattr(module, 'CANARY_RECEIPT', canary_path)
                with mock.patch.object(module, 'stable_bytes', return_value=json.dumps({'commit': 'a' * 40}).encode()), \
                     mock.patch.object(module, 'require_fresh_preflight', return_value=preflight), \
                     mock.patch.object(module, 'restart_dispatcher_service', side_effect=restart), \
                     mock.patch.object(module, 'notify_dispatcher', side_effect=notify), \
                     mock.patch.object(module, 'wait_probe_heartbeat', side_effect=wait_probe) as wait, \
                     mock.patch.object(module, 'run_verified_scheduler', return_value=0) as circuit:
                    result = module.activate_dispatcher()
                self.assertTrue(result['activated'])
                final_receipt = json.loads(activation_path.read_text())
                self.assertTrue(final_receipt['activated'])
                self.assertEqual(final_receipt['dispatcherPid'], 4321)
                self.assertTrue(final_receipt['circuitProbePassed'])
                self.assertEqual(events, ['probe-healthy', 'probe-notified', 'probe-verified'])
                wait.assert_called_once()
                circuit.assert_called_once_with(circuit_probe=True)
            finally:
                setattr(module, 'ACTIVATION_RECEIPT', old[0])
                setattr(module, 'CANARY_RECEIPT', old[1])

    def test_run_scheduler_uses_private_verified_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / 'project'
            logs = project / 'rpp_apply_logs'
            logs.mkdir(parents=True)
            scheduler = root / 'scheduler.py'
            settings = root / 'settings.py'
            adapter = root / 'adapter.mjs'
            scheduler.write_text('ORIGINAL = True\n', encoding='utf-8')
            settings.write_text('SETTINGS = True\n', encoding='utf-8')
            adapter.write_text('export {};\n', encoding='utf-8')
            manifest = logs / 'manifest.json'
            artifacts = {'scheduler': (scheduler, scheduler), 'settingsRefresh': (settings, settings),
                         'exclusionAdapter': (adapter, adapter)}
            manifest.write_text(json.dumps({'artifacts': {name: hashlib.sha256(target.read_bytes()).hexdigest() for name, (_, target) in artifacts.items()}}), encoding='utf-8')
            old = (getattr(module, 'ARTIFACTS'), getattr(module, 'MANIFEST'), getattr(module, 'PROJECT'))
            executed = {}
            def fake_run(command, **kwargs):
                scheduler.write_text('TAMPERED = True\n', encoding='utf-8')
                executed['bytes'] = Path(command[2]).read_bytes()
                executed['adapterBytes'] = Path(kwargs['env']['RPP_EXCLUSION_ADAPTER_PATH']).read_bytes()
                executed['adapterPath'] = kwargs['env']['RPP_EXCLUSION_ADAPTER_PATH']
                executed['env'] = kwargs['env']
                return SimpleNamespace(returncode=0, stdout='', stderr='')
            try:
                setattr(module, 'ARTIFACTS', artifacts)
                setattr(module, 'MANIFEST', manifest)
                setattr(module, 'PROJECT', project)
                with mock.patch.object(module, 'require_activation'), \
                     mock.patch.object(module, 'runtime_dependency_contract', return_value={
                         'nodeRoot': '/tmp/node_modules', 'nodeTreeSha256': '1' * 64,
                         'pythonRoot': '/tmp/python_modules', 'pythonTreeSha256': '3' * 64,
                         'browserRoot': '/tmp/browser.app', 'browserTreeSha256': '2' * 64,
                         'chromiumExecutable': '/tmp/browser.app/chrome'}), \
                     mock.patch.object(module.subprocess, 'run', side_effect=fake_run):
                    self.assertEqual(module.run_verified_scheduler(), 0)
                self.assertEqual(executed['bytes'], b'ORIGINAL = True\n')
                self.assertEqual(executed['adapterBytes'], b'export {};\n')
                self.assertNotEqual(executed['adapterPath'], str(adapter))
                self.assertEqual(executed['env']['RPP_PYTHON_PLAYWRIGHT_ROOT'], '/tmp/python_modules')
                self.assertEqual(executed['env']['RPP_PYTHON_PLAYWRIGHT_TREE_SHA256'], '3' * 64)
                self.assertEqual(executed['env']['PYTHONPATH'].split(os.pathsep)[-1], '/tmp/python_modules')
                self.assertEqual(executed['env']['PYTHONNOUSERSITE'], '1')
            finally:
                setattr(module, 'ARTIFACTS', old[0])
                setattr(module, 'MANIFEST', old[1])
                setattr(module, 'PROJECT', old[2])

    def test_preflight_pins_attested_adapter_and_browser_contract(self):
        source = DEPLOY.read_text(encoding='utf-8')
        section = source[source.index('def run_dispatcher_preflight'):source.index('def run_dispatcher_canary')]
        for name in ('RPP_EXCLUSION_ADAPTER_PATH', 'RPP_PLAYWRIGHT_NODE_ROOT',
                     'RPP_PLAYWRIGHT_TREE_SHA256', 'RPP_CHROMIUM_EXECUTABLE',
                     'RPP_CHROMIUM_BUNDLE_ROOT', 'RPP_CHROMIUM_TREE_SHA256',
                     'RPP_PYTHON_PLAYWRIGHT_ROOT', 'RPP_PYTHON_PLAYWRIGHT_TREE_SHA256',
                     'dependency["pythonRoot"]'):
            self.assertIn(name, section)

    def test_dependency_permissions_preserve_executable_bits(self):
        source = DEPLOY.read_text(encoding='utf-8')
        self.assertIn('entry.stat().st_mode & 0o111', source)
        self.assertIn('0o500 if entry.is_dir() or executable else 0o400', source)

    def test_deploy_refuses_cutover_while_shared_worker_lock_is_busy(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / 'worker.lock'
            descriptor = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with mock.patch.object(module, 'SHARED_WORKER_LOCK', lock), \
                     mock.patch.object(module, '_deploy_under_lock') as cutover:
                    with self.assertRaisesRegex(RuntimeError, 'lock is busy'):
                        module.deploy()
                    cutover.assert_not_called()
            finally:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
                os.close(descriptor)
    def test_activation_requires_final_circuit_and_live_dispatcher_pid(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'activation.json'
            base = {'commit': 'a' * 40, 'activated': True, 'activationHold': False,
                    'circuitProbePassed': True, 'dispatcherPid': 123}
            receipt.write_text(json.dumps(base))
            loaded = '''program = /usr/bin/python3
arguments = {
 /usr/bin/python3
 -s
 /Users/nob/Projects/rpp-8am-notify/deploy_worker_runtime.py
 --run-scheduler-dispatcher
}
environment = {
 HOME => /Users/nob
 PATH => /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
 RPP_PROJECT_DIR => /Users/nob/Projects/rpp-8am-notify
 RPP_EVENT_DISPATCHER => 1
 PYTHONNOUSERSITE => 1
 OSLogRateLimit => 64
 XPC_SERVICE_NAME => com.rise.rpp-product-delivery-dispatcher
}
state = running
pid = 123
'''
            with mock.patch.object(module, 'ACTIVATION_RECEIPT', receipt), \
                 mock.patch.object(module.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=loaded)):
                self.assertEqual(module.require_activation({'commit': 'a' * 40})['dispatcherPid'], 123)
                receipt.write_text(json.dumps({**base, 'activationHold': True, 'circuitProbePassed': False}))
                with self.assertRaisesRegex(RuntimeError, 'held'):
                    module.require_activation({'commit': 'a' * 40})
                self.assertTrue(module.require_activation({'commit': 'a' * 40}, allow_activation_hold=True)['activationHold'])
                receipt.write_text(json.dumps({**base, 'dispatcherPid': 999}))
                with self.assertRaisesRegex(RuntimeError, 'PID'):
                    module.require_activation({'commit': 'a' * 40})

    def test_runtime_dependencies_and_health_monitor_are_pinned(self):
        self.assertEqual(module.NODE_DEPENDENCY_SOURCES, [module.REPO / 'node_modules'])
        self.assertIn(module.PYTHON_SITE_PACKAGES / 'psycopg2', module.PYTHON_DEPENDENCY_SOURCES)
        self.assertIsNotNone(module.__file__)
        source = Path(str(module.__file__)).read_text(encoding='utf-8')
        self.assertNotIn('"NODE_PATH": str(PROJECT / "node_modules")', source)
        self.assertIn('["/usr/bin/python3", "-s", "-c", code]', source)
        with tempfile.TemporaryDirectory() as directory:
            jobs = Path(directory) / 'jobs.json'
            job = {'id': module.HEALTH_CRON_ID, 'name': 'RPP商品配信dispatcher health監視',
                   'schedule': {'kind': 'cron', 'expr': '*/10 * * * *'},
                   'script': 'rpp_product_delivery_dispatcher_health_tick.sh', 'no_agent': True,
                   'deliver': 'origin', 'enabled': False, 'state': 'paused'}
            jobs.write_text(json.dumps({'jobs': [job]}))
            with mock.patch.object(module, 'HERMES_CRON_JOBS', jobs):
                self.assertFalse(module.verify_health_monitor(expected_enabled=False)['enabled'])
                job.update({'enabled': True, 'state': 'scheduled'})
                jobs.write_text(json.dumps({'jobs': [job]}))
                self.assertTrue(module.verify_health_monitor(expected_enabled=True)['enabled'])

    def test_manifest_dependency_hash_rejects_out_of_tree_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'root'
            root.mkdir()
            external = Path(directory) / 'external'
            external.write_text('mutable')
            (root / 'escape').symlink_to(external)
            with self.assertRaisesRegex(RuntimeError, 'escapes'):
                module.tree_sha256(root)
    def test_privileged_entrypoints_verify_dependency_contents(self):
        source = DEPLOY.read_text(encoding='utf-8')
        self.assertNotIn('runtime_dependency_contract(manifest, verify_hashes=False)', source)
        self.assertGreaterEqual(source.count('runtime_dependency_contract(manifest, verify_hashes=True)'), 6)


if __name__ == '__main__':
    unittest.main()
