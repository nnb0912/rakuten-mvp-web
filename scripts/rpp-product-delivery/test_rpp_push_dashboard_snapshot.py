#!/usr/bin/env python3
import csv
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
    def test_excluded_product_rows_are_kept_only_in_all_configured_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._write_csv(root / 'rpp_item_settings.csv', ['商品管理番号', '商品名', '商品CPC', '除外登録済み商品'], [['r0406', 'ゴミ箱', '30', 'yes']])
            self._write_csv(root / 'rpp_keyword_settings.csv', ['商品管理番号', '商品名', '商品CPC', 'キーワード', 'キーワードCPC'], [['r0406', 'ゴミ箱', '30', 'ゴミ カラスよけ', '40']])
            self._write_csv(root / 'rpp_exclude_items.csv', ['商品管理番号'], [['r0406']])
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

    def test_readback_requires_schema_v4_and_exact_all_target_ids(self):
        payload = {
            'syncedAt': '2026-09-11T03:00:00Z',
            'rppData': {
                'configuredTargets': [],
                'allConfiguredTargets': [{'id': 'r0406__item'}, {'id': 'r0406__kw'}],
                'exclusionProducts': [{'itemCode': 'r0406'}],
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

    @staticmethod
    def _write_csv(path: Path, fieldnames: list[str], rows: list[list[str]]) -> None:
        with path.open('w', encoding='cp932', newline='') as handle:
            writer = csv.writer(handle)
            writer.writerow(fieldnames)
            writer.writerows(rows)


if __name__ == '__main__':
    unittest.main()
