import asyncio
import csv
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import rpp_apply_approved_cpc_upload as apply


def write_cp932(path: Path, rows: list[list[str]]) -> None:
    with path.open('w', encoding='cp932', newline='') as handle:
        csv.writer(handle, lineterminator='\r\n').writerows(rows)


def write_audit(path: Path, rows: list[list[str]]) -> None:
    with path.open('w', encoding='utf-8-sig', newline='') as handle:
        csv.writer(handle, lineterminator='\r\n').writerows(rows)


class ItemCpcUploadSafetyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name)
        for name in ('rpp_exclude_items.csv', 'rpp_keyword_reports.csv', 'rpp_position_adjustment_log.json'):
            (self.project / name).write_text('{}\n', encoding='utf-8')
        write_cp932(
            self.project / 'rpp_item_settings.csv',
            [
                ['コントロールカラム', '商品管理番号', '商品名', '商品CPC', '除外登録済み商品'],
                ['', 'r0001', 'fixture', '50', 'No'],
            ],
        )
        (self.project / 'rpp_targets').mkdir()
        (self.project / 'rpp_targets' / 'rpp_alert_targets.json').write_text(json.dumps({
            'source': 'https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets',
            'targets': [{'itemCode': 'r0001', 'keyword': '商品CPC', 'optimizationMode': 'POSITION', 'positionMaxCpc': 300, 'changeLocked': False, 'protectionType': 'NORMAL'}],
        }), encoding='utf-8')
        self.patch = patch.object(apply, 'PROJECT', self.project)
        self.patch.start()

    def tearDown(self) -> None:
        self.patch.stop()
        self.tmp.cleanup()

    def make_bundle(self) -> tuple[Path, Path, Path]:
        upload = self.project / 'approved_item_cpc_update_20260831_1200.csv'
        rollback = self.project / 'rollback_item_cpc_update_20260831_1200.csv'
        audit = self.project / 'approved_cpc_update_20260831_1200_audit.csv'
        write_cp932(upload, [['コントロールカラム', '商品管理番号', '商品CPC'], ['u', 'r0001', '60']])
        write_cp932(rollback, [['コントロールカラム', '商品管理番号', '商品CPC'], ['u', 'r0001', '50']])
        write_audit(
            audit,
            [
                ['商品管理番号', '商品名', 'キーワード', '判定', '変更前CPC', '提案CPC', '変更種別', '設定モード'],
                ['r0001', 'fixture', '商品CPC', 'RAISE', '50', '60', 'FIXED_SYNC', 'FIXED'],
                ['r0002', 'keyword fixture', '収納', 'RAISE', '40', '50', 'AUTOMATIC_ADJUSTMENT', 'ROAS'],
            ],
        )
        return upload, rollback, audit

    def test_item_csv_is_detected_and_parsed(self) -> None:
        upload, _, _ = self.make_bundle()
        kind, rows = apply.parse_upload_csv(upload)
        self.assertEqual('item', kind)
        self.assertEqual(60, rows[0]['targetCpc'])
        self.assertEqual(60, rows[0]['itemCpc'])
        self.assertEqual('', rows[0]['keyword'])

    def test_upload_csv_rejects_duplicate_headers_and_keys(self) -> None:
        duplicate_headers = self.project / 'approved_item_cpc_update_dup_headers.csv'
        write_cp932(duplicate_headers, [['コントロールカラム', '商品管理番号', '商品CPC', '商品CPC'], ['u', 'r0001', '60', '250']])
        with self.assertRaisesRegex(RuntimeError, 'headers are duplicated'):
            apply.parse_upload_csv(duplicate_headers)
        duplicate_keys = self.project / 'approved_item_cpc_update_dup_keys.csv'
        write_cp932(duplicate_keys, [['コントロールカラム', '商品管理番号', '商品CPC'], ['u', 'r0001', '60'], ['u', 'r0001', '60']])
        with self.assertRaisesRegex(RuntimeError, 'duplicate upload row key'):
            apply.parse_upload_csv(duplicate_keys)

    def test_item_csv_uses_product_specific_maximum_instead_of_120(self) -> None:
        targets = self.project / 'rpp_targets'
        targets.mkdir(exist_ok=True)
        (targets / 'rpp_alert_targets.json').write_text(
            '{"source":"https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets","targets":[{"itemCode":"r0001","keyword":"商品CPC","optimizationMode":"POSITION","positionMaxCpc":300}]}',
            encoding='utf-8',
        )
        upload = self.project / 'approved_item_cpc_update_20260831_1202.csv'
        write_cp932(upload, [['コントロールカラム', '商品管理番号', '商品CPC'], ['u', 'r0001', '250']])
        _, rows = apply.parse_upload_csv(upload)
        self.assertEqual(250, rows[0]['targetCpc'])
        write_cp932(upload, [['コントロールカラム', '商品管理番号', '商品CPC'], ['u', 'r0001', '301']])
        with self.assertRaisesRegex(RuntimeError, 'above product maximum 300'):
            apply.parse_upload_csv(upload)

    def test_forward_submit_requires_valid_rollback_and_current_cpc(self) -> None:
        upload, rollback, _ = self.make_bundle()
        kind, rows = apply.parse_upload_csv(upload)
        checks = apply.validate_safety(upload, kind, rows, strict=True)
        self.assertEqual(str(rollback), checks['rollbackCsv'])
        self.assertTrue(checks['cpcMatches'][0]['ok'])

    def test_forward_submit_blocks_current_cpc_mismatch(self) -> None:
        upload, _, _ = self.make_bundle()
        write_cp932(
            self.project / 'rpp_item_settings.csv',
            [['コントロールカラム', '商品管理番号', '商品CPC'], ['', 'r0001', '55']],
        )
        kind, rows = apply.parse_upload_csv(upload)
        with self.assertRaisesRegex(RuntimeError, 'current CPC mismatch'):
            apply.validate_safety(upload, kind, rows, strict=True)

    def test_rollback_guard_requires_proposed_cpc_as_current(self) -> None:
        _, rollback, _ = self.make_bundle()
        write_cp932(
            self.project / 'rpp_item_settings.csv',
            [['コントロールカラム', '商品管理番号', '商品CPC'], ['', 'r0001', '60']],
        )
        kind, rows = apply.parse_upload_csv(rollback)
        checks = apply.validate_safety(rollback, kind, rows, strict=True)
        self.assertTrue(checks['cpcMatches'][0]['ok'])
        self.assertEqual(50, checks['cpcMatches'][0]['uploadTargetCpc'])

    def test_item_readback_uses_item_settings(self) -> None:
        upload, _, _ = self.make_bundle()
        kind, rows = apply.parse_upload_csv(upload)
        write_cp932(
            self.project / 'readback.csv',
            [['コントロールカラム', '商品管理番号', '商品CPC'], ['', 'r0001', '60']],
        )
        checks = apply.readback_matches(kind, rows, self.project / 'readback.csv')
        self.assertEqual([True], [row['ok'] for row in checks])

    def test_fresh_item_delivery_guard_rejects_excluded_or_ambiguous_rows(self) -> None:
        rows = [{'itemCode': 'r0001', 'keyword': '', 'targetCpc': 60}]
        settings = self.project / 'fresh-items.csv'
        write_cp932(settings, [['商品管理番号', '商品CPC', '除外登録済み商品'], ['r0001', '50', 'No']])
        self.assertTrue(apply.validate_active_not_excluded(rows, settings, set())[0]['ok'])
        write_cp932(settings, [['商品管理番号', '商品CPC', '除外登録済み商品'], ['r0001', '50', 'Yes']])
        with self.assertRaisesRegex(RuntimeError, 'not authoritatively active'):
            apply.validate_active_not_excluded(rows, settings, set())
        write_cp932(settings, [['商品管理番号', '商品CPC', '除外登録済み商品'], ['r0001', '50', 'false']])
        with self.assertRaisesRegex(RuntimeError, 'not authoritatively active'):
            apply.validate_active_not_excluded(rows, settings, set())
        write_cp932(settings, [['商品管理番号', '商品CPC', '除外登録済み商品'], ['r0001', '50', 'No'], ['r0001', '50', 'No']])
        with self.assertRaisesRegex(RuntimeError, 'not authoritatively active'):
            apply.validate_active_not_excluded(rows, settings, set())
        write_cp932(settings, [['商品管理番号', '商品CPC', '除外登録済み商品'], ['r0001', '50', 'No']])
        with self.assertRaisesRegex(RuntimeError, 'not authoritatively active'):
            apply.validate_active_not_excluded(rows, settings, {'r0001'})
        write_cp932(settings, [['商品管理番号', '商品管理番号', '除外登録済み商品'], ['r0001', 'victim', 'No']])
        with self.assertRaisesRegex(RuntimeError, 'headers are missing or ambiguous'):
            apply.validate_active_not_excluded(rows, settings, set())

    def test_keyword_csv_regression(self) -> None:
        keyword = self.project / 'approved_keyword_cpc_update_20260831_1201.csv'
        write_cp932(
            keyword,
            [['コントロールカラム', '商品管理番号', 'キーワード', 'キーワードCPC'], ['u', 'r0001', '収納', '40']],
        )
        kind, rows = apply.parse_upload_csv(keyword)
        self.assertEqual('keyword', kind)
        self.assertEqual(40, rows[0]['keywordCpc'])

    def test_keyword_settings_reject_duplicate_or_fractional_cpc(self) -> None:
        settings = self.project / 'keyword-settings.csv'
        write_cp932(settings, [['商品管理番号', 'キーワード', 'キーワードCPC'], ['r0001', '収納', '41'], ['r0001', '収納', '50']])
        with self.assertRaisesRegex(RuntimeError, 'duplicate key'):
            apply.cpc_map_from_settings(settings, 'keyword')
        write_cp932(settings, [['商品管理番号', 'キーワード', 'キーワードCPC'], ['r0001', '収納', '50.9']])
        with self.assertRaisesRegex(RuntimeError, 'non-integer CPC'):
            apply.cpc_map_from_settings(settings, 'keyword')

    def test_auto_apply_uploader_rechecks_exact_current_fixed_value(self) -> None:
        upload, _, _ = self.make_bundle()
        targets = self.project / 'rpp_targets'
        targets.mkdir(exist_ok=True)
        payload = {
            'source': 'https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets',
            'targets': [{'itemCode': 'r0001', 'keyword': '商品CPC', 'optimizationMode': 'FIXED', 'fixedCpc': 60, 'changeLocked': False, 'protectionType': 'NORMAL'}],
        }
        (targets / 'rpp_alert_targets.json').write_text(__import__('json').dumps(payload), encoding='utf-8')
        checks = apply.validate_auto_apply_authority(upload, 'item', apply.parse_upload_csv(upload)[1], 'op-1')
        self.assertTrue(checks['required'])
        direct_checks = apply.validate_auto_apply_authority(upload, 'item', apply.parse_upload_csv(upload)[1], '', require=True)
        self.assertTrue(direct_checks['required'])
        payload['targets'][0]['fixedCpc'] = 61
        (targets / 'rpp_alert_targets.json').write_text(__import__('json').dumps(payload), encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'current target authority mismatch'):
            apply.validate_auto_apply_authority(upload, 'item', apply.parse_upload_csv(upload)[1], 'op-1')

    def test_fresh_operator_lock_blocks_before_browser_work(self) -> None:
        upload, _, _ = self.make_bundle()
        payload = {
            'source': 'https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets',
            'targets': [{'itemCode': 'r0001', 'keyword': '商品CPC', 'optimizationMode': 'FIXED', 'fixedCpc': 60, 'changeLocked': True, 'protectionType': 'LOCKED'}],
        }
        (self.project / 'rpp_targets' / 'rpp_alert_targets.json').write_text(json.dumps(payload), encoding='utf-8')
        selector = AsyncMock()
        argv = ['uploader', '--csv', str(upload), '--execute', '--final-submit', '--operation-id', 'op-1', '--confirm=RMS_CPC_UPLOAD']
        with patch.object(sys, 'argv', argv), patch.dict(os.environ, {'RPP_ENABLE_PRODUCTION_UPLOAD': '1'}, clear=False), patch.object(apply, 'select_file_on_rms', selector):
            with self.assertRaisesRegex(RuntimeError, 'change-locked'):
                asyncio.run(apply.main_async())
        selector.assert_not_awaited()

    def test_auto_apply_uploader_rejects_mode_change(self) -> None:
        upload, _, _ = self.make_bundle()
        targets = self.project / 'rpp_targets'
        targets.mkdir(exist_ok=True)
        payload = {
            'source': 'https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets',
            'targets': [{'itemCode': 'r0001', 'keyword': '商品CPC', 'optimizationMode': 'ROAS', 'roasMaxCpc': 120, 'changeLocked': False, 'protectionType': 'NORMAL'}],
        }
        (targets / 'rpp_alert_targets.json').write_text(__import__('json').dumps(payload), encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'current target authority mismatch'):
            apply.validate_auto_apply_authority(upload, 'item', apply.parse_upload_csv(upload)[1], 'op-1')

    def test_auto_apply_uploader_rechecks_latest_automatic_cap(self) -> None:
        upload, _, audit = self.make_bundle()
        write_audit(audit, [
            ['商品管理番号', '商品名', 'キーワード', '判定', '変更前CPC', '提案CPC', '変更種別', '設定モード'],
            ['r0001', 'fixture', '商品CPC', 'RAISE', '50', '60', 'AUTOMATIC_ADJUSTMENT', 'ROAS'],
        ])
        payload = {
            'source': 'https://rakuten-mvp-web.onrender.com/api/rpp/sync-snapshot?resource=targets',
            'targets': [{'itemCode': 'r0001', 'keyword': '商品CPC', 'optimizationMode': 'ROAS', 'roasMinCpc': 20, 'roasMaxCpc': 50, 'changeLocked': False, 'protectionType': 'NORMAL'}],
        }
        parsed_rows = apply.parse_upload_csv(upload)[1]
        (self.project / 'rpp_targets' / 'rpp_alert_targets.json').write_text(json.dumps(payload), encoding='utf-8')
        with self.assertRaisesRegex(RuntimeError, 'current target authority mismatch'):
            apply.validate_auto_apply_authority(upload, 'item', parsed_rows, 'op-1')

    def test_audit_cpc_rejects_fractional_values(self) -> None:
        upload, _, audit = self.make_bundle()
        write_audit(audit, [
            ['商品管理番号', '商品名', 'キーワード', '判定', '変更前CPC', '提案CPC', '変更種別', '設定モード'],
            ['r0001', 'fixture', '商品CPC', 'RAISE', '50.9', '60.9', 'FIXED_SYNC', 'FIXED'],
        ])
        kind, rows = apply.parse_upload_csv(upload)
        with self.assertRaisesRegex(RuntimeError, 'canonical positive integer'):
            apply.validate_safety(upload, kind, rows, strict=True)

    def test_final_submit_is_verified_only_with_result_and_readback(self) -> None:
        complete = {
            'submitResult': {'confirmed': True, 'successCount': 1, 'failureCount': 0},
            'readback': {'ok': True},
        }
        self.assertTrue(apply.final_submit_verified(complete, 1))
        self.assertFalse(apply.final_submit_verified({**complete, 'readback': {'ok': False}}, 1))
        self.assertFalse(apply.final_submit_verified({**complete, 'submitResult': {'confirmed': True, 'successCount': 0, 'failureCount': 1}}, 1))

    def test_every_final_submit_requires_operation_id_before_browser_work(self) -> None:
        with patch.object(apply.sys, 'argv', ['uploader', '--final-submit']):
            with self.assertRaisesRegex(RuntimeError, 'operation ID is required'):
                asyncio.run(apply.main_async())

    def test_fresh_export_elapsed_time_is_hard_bounded(self) -> None:
        self.assertEqual(115, apply.assert_pre_submit_export_fresh(1.0, 116.0))
        with self.assertRaisesRegex(RuntimeError, 'maximum elapsed time'):
            apply.assert_pre_submit_export_fresh(100.0, 216.0)

    def test_delivery_guard_elapsed_time_is_hard_bounded(self) -> None:
        self.assertEqual(115.0, apply.assert_delivery_guard_fresh(100.0, 215.0))
        with self.assertRaisesRegex(RuntimeError, 'delivery guard exceeded'):
            apply.assert_delivery_guard_fresh(100.0, 216.0)

    def test_wal_binding_covers_exact_payload_and_all_bundle_hashes(self) -> None:
        upload, rollback, audit = self.make_bundle()
        rows = apply.parse_upload_csv(upload)[1]
        wal = self.project / 'binding-wal.json'
        entry = {
            'operationId': 'op-bind', 'state': 'PREPARED', 'itemCode': 'r0001', 'keyword': '',
            'beforeCpc': 50, 'afterCpc': 60,
            'bundle': {'upload': str(upload), 'rollback': str(rollback), 'audit': str(audit)},
            'bundleSha256': {name: apply.hashlib.sha256(path.read_bytes()).hexdigest() for name, path in {'upload': upload, 'rollback': rollback, 'audit': audit}.items()},
        }
        wal.write_text(json.dumps({'version': 1, 'entries': [entry]}), encoding='utf-8')
        with patch.dict(os.environ, {'RPP_AUTO_APPLY_WAL': str(wal)}):
            self.assertTrue(apply.validate_wal_binding('op-bind', upload, rows)['ok'])
            rollback.write_bytes(rollback.read_bytes() + b' ')
            with self.assertRaisesRegex(RuntimeError, 'not bound to the exact upload payload'):
                apply.validate_wal_binding('op-bind', upload, rows)

    def test_authoritative_fresh_settings_path_must_exactly_match_current_cpc(self) -> None:
        upload, _, _ = self.make_bundle()
        kind, rows = apply.parse_upload_csv(upload)
        fresh = self.project / 'fresh-export.csv'
        write_cp932(fresh, [['コントロールカラム', '商品管理番号', '商品CPC'], ['', 'r0001', '50']])
        checks = apply.validate_safety(upload, kind, rows, strict=True, settings_path=fresh, enforce_aux_freshness=False)
        self.assertTrue(checks['cpcMatches'][0]['ok'])
        write_cp932(fresh, [['コントロールカラム', '商品管理番号', '商品CPC'], ['', 'r0001', '51']])
        with self.assertRaisesRegex(RuntimeError, 'current CPC mismatch'):
            apply.validate_safety(upload, kind, rows, strict=True, settings_path=fresh, enforce_aux_freshness=False)

    def test_generic_post_submit_error_is_never_logged_as_no_production_change(self) -> None:
        logged = []
        apply.ACTIVE_OPERATION_ID = 'op-1'

        async def fail_after_submit():
            raise RuntimeError('post-submit failure')

        with patch.object(apply, 'main_async', new=fail_after_submit), \
             patch.object(apply, 'wal_state', return_value='SUBMITTED'), \
             patch.object(apply, 'wal_transition') as transition, \
             patch.object(apply, 'append_apply_log', side_effect=lambda value: logged.append(value)), \
             patch('builtins.print'):
            self.assertEqual(1, apply.main())
        self.assertTrue(logged[0]['productionChange'])
        self.assertEqual('UNCERTAIN', logged[0]['walState'])
        transition.assert_called_once()
        apply.ACTIVE_OPERATION_ID = ''


if __name__ == '__main__':
    unittest.main()
