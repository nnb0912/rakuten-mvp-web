#!/usr/bin/env python3
"""RPP Phase 4: approved CPC CSV upload helper for RMS.

Safe defaults:
- Without --execute: dry-run only, no browser.
- With --execute: login to RMS and select the CSV file on the keyword-CPC bulk upload screen.
- Without --final-submit: do NOT click the RMS upload button.
- Actual final submit also requires RPP_ENABLE_PRODUCTION_UPLOAD=1 and --confirm=RMS_CPC_UPLOAD.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import io
import hashlib
import json
import os
import re
import shutil
import sys
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

PROJECT = Path(os.environ.get('RPP_PROJECT_DIR', str(Path(__file__).resolve().parent))).resolve()
RAKUTEN_MARKETING = Path('/Users/nob/Projects/rakuten-marketing')
SNAPSHOTS = PROJECT / 'rpp_snapshots'
APPLY_LOG_DIR = PROJECT / 'rpp_apply_logs'
APPLY_LOG_PATH = APPLY_LOG_DIR / 'rpp_apply_history.json'
MAX_PRE_SUBMIT_EXPORT_AGE_SECONDS = 115
MAX_DELIVERY_GUARD_AGE_SECONDS = 115
ACTIVE_OPERATION_ID = ''


def wal_transition(operation_id: str, state: str, details: dict[str, object] | None = None) -> None:
    if not operation_id:
        return
    import rpp_allowed_auto_apply as auto_apply
    path = Path(os.environ.get('RPP_AUTO_APPLY_WAL', str(auto_apply.WAL_PATH)))
    auto_apply.transition_wal(operation_id, state, details, path)


def wal_state(operation_id: str) -> str:
    if not operation_id:
        return ''
    import rpp_allowed_auto_apply as auto_apply
    path = Path(os.environ.get('RPP_AUTO_APPLY_WAL', str(auto_apply.WAL_PATH)))
    return auto_apply.wal_state(operation_id, path)


def product_cpc_caps() -> dict[tuple[str, str, str], int]:
    import rpp_allowed_auto_apply as auto_apply
    targets = auto_apply.load_current_targets(PROJECT / 'rpp_targets' / 'rpp_alert_targets.json').values()
    caps: dict[tuple[str, str, str], int] = {}
    mode_fields = {'ROAS': 'roasMaxCpc', 'POSITION': 'positionMaxCpc', 'BALANCED': 'balancedMaxCpc'}
    for target in targets:
        item = str(target.get('itemCode') or '').strip().lower()
        keyword = str(target.get('keyword') or '').strip()
        if not item or not keyword:
            raise RuntimeError('current target key is missing')
        kind = 'item' if keyword == '商品CPC' else 'keyword'
        field = 'fixedCpc' if target.get('optimizationMode') == 'FIXED' else mode_fields.get(target.get('optimizationMode'))
        value = target.get(field) if field else None
        if value in (None, '') and target.get('optimizationMode') != 'FIXED':
            value = target.get('maxCpc')
        try:
            maximum = int(value)
        except (TypeError, ValueError) as error:
            raise RuntimeError(f'invalid CPC maximum in current target: {(item, keyword)!r}') from error
        if maximum > 0:
            caps[(kind, item, '' if kind == 'item' else keyword)] = maximum
    return caps


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(errors='replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def decode_csv_bytes(raw: bytes) -> str:
    for enc in ('shift_jis', 'cp932', 'utf-8-sig', 'utf-8'):
        try:
            return raw.decode(enc)
        except Exception:
            pass
    return raw.decode('utf-8', 'replace')


def parse_upload_csv(csv_path: Path) -> tuple[str, list[dict[str, object]]]:
    if not csv_path.exists():
        raise RuntimeError(f'upload csv not found: {csv_path}')
    text = decode_csv_bytes(csv_path.read_bytes())
    reader = csv.DictReader([line for line in text.splitlines() if line.strip()])
    header_list = list(reader.fieldnames or [])
    if len(header_list) != len(set(header_list)):
        raise RuntimeError('upload CSV headers are duplicated')
    headers = set(header_list)
    keyword_headers = {'コントロールカラム', '商品管理番号', 'キーワード', 'キーワードCPC'}
    item_headers = {'コントロールカラム', '商品管理番号', '商品CPC'}
    if headers == keyword_headers and len(header_list) == len(keyword_headers):
        upload_kind = 'keyword'
        cpc_column = 'キーワードCPC'
    elif headers == item_headers and len(header_list) == len(item_headers):
        upload_kind = 'item'
        cpc_column = '商品CPC'
    else:
        raise RuntimeError(f'unsupported CPC CSV header: {sorted(headers)}')
    rows = list(reader)
    parsed = []
    seen_keys: set[tuple[str, str]] = set()
    caps = product_cpc_caps()
    for row in rows:
        control = str(row.get('コントロールカラム') or '').strip().lower()
        item = str(row.get('商品管理番号') or '').strip()
        keyword = str(row.get('キーワード') or '').strip()
        raw_cpc = row.get(cpc_column)
        try:
            target_cpc = int(str(raw_cpc).strip())
        except (TypeError, ValueError):
            raise RuntimeError(f'invalid {cpc_column}: item={item}; value={raw_cpc!r}') from None
        if control != 'u' or not item or (upload_kind == 'keyword' and not keyword):
            raise RuntimeError(f'invalid upload row: control={control!r}; item={item!r}; keyword={keyword!r}')
        key = row_key(upload_kind, item, keyword)
        if key in seen_keys:
            raise RuntimeError(f'duplicate upload row key: {key!r}')
        seen_keys.add(key)
        minimum = 40 if upload_kind == 'keyword' else 20
        if target_cpc < minimum:
            raise RuntimeError(f'{upload_kind} CPC below minimum {minimum}: item={item}; cpc={target_cpc}')
        maximum = caps.get((upload_kind, item.lower(), '' if upload_kind == 'item' else keyword))
        if maximum is not None and target_cpc > maximum:
            raise RuntimeError(f'{upload_kind} CPC above product maximum {maximum}: item={item}; cpc={target_cpc}')
        parsed.append({
            'control': control,
            'itemCode': item,
            'keyword': keyword,
            'targetCpc': target_cpc,
            f'{upload_kind}Cpc': target_cpc,
        })
    return upload_kind, parsed


def file_freshness(upload_kind: str) -> dict[str, object]:
    thresholds = {
        'rpp_item_settings.csv' if upload_kind == 'item' else 'rpp_keyword_settings.csv': 24,
        'rpp_exclude_items.csv': 24,
        'rpp_keyword_reports.csv': 36,
        'rpp_position_adjustment_log.json': 24,
    }
    files = []
    now = datetime.now(timezone.utc).timestamp()
    for name, max_hours in thresholds.items():
        p = PROJECT / name
        if not p.exists():
            files.append({'fileName': name, 'ok': False, 'status': 'missing', 'mtime': None, 'ageHours': None, 'maxAgeHours': max_hours})
            continue
        st = p.stat()
        age = (now - st.st_mtime) / 3600
        files.append({'fileName': name, 'ok': age <= max_hours, 'status': 'ok' if age <= max_hours else 'stale', 'mtime': datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(), 'ageHours': age, 'maxAgeHours': max_hours})
    return {'readyForProduction': all(f['ok'] for f in files), 'files': files}


def row_key(upload_kind: str, item: str, keyword: str = '') -> tuple[str, str]:
    return item.strip().lower(), keyword.strip() if upload_kind == 'keyword' else ''


def settings_path_for(upload_kind: str) -> Path:
    return PROJECT / ('rpp_item_settings.csv' if upload_kind == 'item' else 'rpp_keyword_settings.csv')


def latest_cpc_map(upload_kind: str) -> dict[tuple[str, str], int]:
    return cpc_map_from_settings(settings_path_for(upload_kind), upload_kind)


def cpc_map_from_settings(path: Path, upload_kind: str) -> dict[tuple[str, str], int]:
    if not path.exists():
        raise RuntimeError(f'{upload_kind} settings file is missing')
    text = decode_csv_bytes(path.read_bytes())
    reader = csv.DictReader([line for line in text.splitlines() if line.strip()])
    headers = list(reader.fieldnames or [])
    required = ['商品管理番号', '商品CPC'] if upload_kind == 'item' else ['商品管理番号', 'キーワード', 'キーワードCPC']
    if len(headers) != len(set(headers)) or any(headers.count(name) != 1 for name in required):
        raise RuntimeError(f'{upload_kind} settings headers are missing or duplicated')
    out: dict[tuple[str, str], int] = {}
    for index, row in enumerate(reader, start=2):
        item = str(row.get('商品管理番号') or '').strip()
        kw = str(row.get('キーワード') or '').strip() if upload_kind == 'keyword' else ''
        if not item or (upload_kind == 'keyword' and not kw):
            raise RuntimeError(f'{upload_kind} settings row {index} has an incomplete key')
        raw = str(row.get('商品CPC') if upload_kind == 'item' else row.get('キーワードCPC') or '').strip()
        if not re.fullmatch(r'[1-9][0-9]*', raw):
            raise RuntimeError(f'{upload_kind} settings row {index} has a non-integer CPC')
        key = row_key(upload_kind, item, kw)
        if key in out:
            raise RuntimeError(f'{upload_kind} settings contain duplicate key: {key!r}')
        out[key] = int(raw)
    return out


def normalize_settings_csv(raw: bytes, suggested_name: str, upload_kind: str) -> tuple[str, str]:
    source = suggested_name
    if zipfile.is_zipfile(io.BytesIO(raw)):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            name = next((n for n in z.namelist() if n.lower().endswith('.csv')), None)
            if not name:
                raise RuntimeError('settings readback ZIP has no CSV')
            raw = z.read(name)
            source = name
    text = decode_csv_bytes(raw)
    lines = [line for line in text.splitlines() if line.strip()]
    required = 'キーワード' if upload_kind == 'keyword' else '商品CPC'
    start = next((i for i, line in enumerate(lines) if '商品管理番号' in line and required in line), None)
    if start is None:
        raise RuntimeError(f'{upload_kind} settings readback header not found')
    return '\r\n'.join(lines[start:]) + '\r\n', source


def replace_settings(raw: bytes, suggested_name: str, upload_kind: str) -> dict[str, object]:
    out = settings_path_for(upload_kind)
    download_dir = PROJECT / 'rpp_downloads'
    download_dir.mkdir(exist_ok=True)
    saved = download_dir / f"{upload_kind}_settings_readback_{datetime.now():%Y%m%d_%H%M%S_%f}_{suggested_name}"
    saved.write_bytes(raw)
    text, source = normalize_settings_csv(raw, suggested_name, upload_kind)
    backup = PROJECT / f"{out.stem}.backup_readback_{datetime.now():%Y%m%d_%H%M%S_%f}.csv"
    if out.exists():
        shutil.copy2(out, backup)
    out.write_bytes(text.encode('cp932', errors='replace'))
    data_rows = max(len([line for line in text.splitlines() if line.strip()]) - 1, 0)
    return {'download': str(saved), 'source': source, 'backup': str(backup), 'output': str(out), 'dataRows': data_rows}


def readback_matches(upload_kind: str, rows: list[dict[str, object]], settings_path: Path) -> list[dict[str, object]]:
    latest = cpc_map_from_settings(settings_path, upload_kind)
    checks = []
    for row in rows:
        item = str(row['itemCode'])
        kw = str(row['keyword'])
        expected = int(str(row['targetCpc']))
        actual = latest.get(row_key(upload_kind, item, kw))
        checks.append({'itemCode': item, 'keyword': kw, 'expectedCpc': expected, 'actualCpc': actual, 'ok': actual == expected})
    return checks


def validate_active_not_excluded(rows: list[dict[str, object]], item_settings_path: Path, exclusion_codes: set[str]) -> list[dict[str, object]]:
    text = decode_csv_bytes(item_settings_path.read_bytes())
    reader = csv.DictReader([line for line in text.splitlines() if line.strip()])
    headers = list(reader.fieldnames or [])
    if headers.count('商品管理番号') != 1 or len(headers) != len(set(headers)):
        raise RuntimeError('fresh RMS item settings headers are missing or ambiguous')
    exclusion_headers = [header for header in headers if '除外' in header]
    if len(exclusion_headers) != 1:
        raise RuntimeError('fresh RMS item settings exclusion column is missing or ambiguous')
    exclusion_header = exclusion_headers[0]
    by_item: dict[str, list[dict[str, str]]] = {}
    for record in reader:
        item = str(record.get('商品管理番号') or '').strip().lower()
        if item:
            by_item.setdefault(item, []).append(record)
    checks: list[dict[str, object]] = []
    allowed_not_excluded = {'no'}
    for row in rows:
        item = str(row['itemCode']).strip().lower()
        matches = by_item.get(item, [])
        raw = str(matches[0].get(exclusion_header) or '').strip().lower() if len(matches) == 1 else ''
        ok = len(matches) == 1 and raw in allowed_not_excluded and item not in exclusion_codes
        checks.append({'itemCode': item, 'settingsRowCount': len(matches), 'itemSettingsExclusion': raw or None, 'inLiveExclusionSet': item in exclusion_codes, 'ok': ok})
        if not ok:
            raise RuntimeError(f'RPP item is not authoritatively active/non-excluded; upload blocked: {json.dumps(checks, ensure_ascii=False)}')
    return checks


def matching_audit_path(csv_path: Path) -> Path | None:
    name = csv_path.name
    prefixes = (
        'approved_keyword_cpc_update_',
        'approved_item_cpc_update_',
        'rollback_keyword_cpc_update_',
        'rollback_item_cpc_update_',
    )
    prefix = next((value for value in prefixes if name.startswith(value)), None)
    if not prefix or not name.endswith('.csv'):
        return None
    stamp = name[len(prefix):-4]
    path = csv_path.with_name(f'approved_cpc_update_{stamp}_audit.csv')
    return path if path.exists() else None


def matching_rollback_path(csv_path: Path) -> Path | None:
    replacements = {
        'approved_keyword_cpc_update_': 'rollback_keyword_cpc_update_',
        'approved_item_cpc_update_': 'rollback_item_cpc_update_',
    }
    for approved_prefix, rollback_prefix in replacements.items():
        if csv_path.name.startswith(approved_prefix):
            candidate = csv_path.with_name(csv_path.name.replace(approved_prefix, rollback_prefix, 1))
            return candidate if candidate.exists() else None
    return None


def validate_auto_apply_authority(
    csv_path: Path,
    upload_kind: str,
    rows: list[dict[str, object]],
    operation_id: str,
    require: bool = False,
) -> dict[str, object]:
    """Recheck current operator intent inside the privileged uploader process."""
    if not operation_id and not require:
        return {'required': False}
    audit = matching_audit_path(csv_path)
    if not audit:
        raise RuntimeError('auto-apply audit CSV is required')
    audit_rows = list(csv.DictReader([line for line in decode_csv_bytes(audit.read_bytes()).splitlines() if line.strip()]))
    relevant = [row for row in audit_rows if (str(row.get('キーワード') or '').strip() == '商品CPC') == (upload_kind == 'item')]
    audit_by_key = {row_key(upload_kind, str(row.get('商品管理番号') or ''), str(row.get('キーワード') or '')): row for row in relevant}
    if len(audit_by_key) != len(relevant) or len(relevant) != len(rows):
        raise RuntimeError('auto-apply audit rows are missing or duplicated')

    import rpp_allowed_auto_apply as auto_apply
    targets = auto_apply.load_current_targets(PROJECT / 'rpp_targets' / 'rpp_alert_targets.json')
    checks: list[dict[str, object]] = []
    for row in rows:
        key = row_key(upload_kind, str(row['itemCode']), str(row['keyword']))
        audit_row = audit_by_key.get(key)
        target = targets.get(key)
        if not audit_row or not target:
            raise RuntimeError(f'current target or audit row missing for {key!r}')
        auto_apply.require_changeable_target(target, key)
        configured_mode = str(target.get('optimizationMode') or '')
        audited_mode = str(audit_row.get('設定モード') or '')
        change_kind = str(audit_row.get('変更種別') or '')
        upload_target = int(str(row['targetCpc']))
        ok = audited_mode == configured_mode
        configured_maximum = None
        if change_kind == 'FIXED_SYNC':
            try:
                configured_fixed = auto_apply.strict_integer(target.get('fixedCpc'), 'configured fixedCpc')
            except RuntimeError:
                configured_fixed = -1
            ok = ok and configured_mode == auto_apply.FIXED_MODE and upload_target == configured_fixed
        elif change_kind == 'AUTOMATIC_ADJUSTMENT':
            max_fields = {'ROAS': 'roasMaxCpc', 'POSITION': 'positionMaxCpc', 'BALANCED': 'balancedMaxCpc'}
            min_fields = {'ROAS': 'roasMinCpc', 'POSITION': 'positionMinCpc', 'BALANCED': 'balancedMinCpc'}
            maximum_raw = target.get(max_fields.get(configured_mode, '')) if configured_mode in max_fields else None
            if maximum_raw in (None, ''):
                maximum_raw = target.get('maxCpc')
            minimum_raw = target.get(min_fields.get(configured_mode, '')) if configured_mode in min_fields else None
            try:
                configured_maximum = auto_apply.strict_integer(maximum_raw, 'configured automatic maximum CPC')
                configured_minimum = auto_apply.strict_integer(minimum_raw, 'configured automatic minimum CPC') if minimum_raw not in (None, '') else (20 if upload_kind == 'item' else 40)
            except RuntimeError:
                configured_maximum, configured_minimum = -1, -1
            ok = ok and configured_mode in auto_apply.AUTOMATIC_MODES and configured_minimum <= upload_target <= configured_maximum
        else:
            ok = False
        checks.append({'itemCode': key[0], 'keyword': key[1], 'changeType': change_kind, 'auditedMode': audited_mode, 'configuredMode': configured_mode, 'uploadTargetCpc': upload_target, 'configuredFixedCpc': target.get('fixedCpc'), 'configuredMaximumCpc': configured_maximum, 'ok': ok})
        if not ok:
            raise RuntimeError(f'current target authority mismatch; upload blocked: {json.dumps(checks, ensure_ascii=False)}')
    return {'required': True, 'checks': checks}


def validate_wal_binding(operation_id: str, csv_path: Path, rows: list[dict[str, object]], expected_state: str = 'PREPARED') -> dict[str, object]:
    if not operation_id:
        raise RuntimeError('operation ID is required for final submit')
    import rpp_allowed_auto_apply as auto_apply
    wal_path = Path(os.environ.get('RPP_AUTO_APPLY_WAL', str(auto_apply.WAL_PATH)))
    matches = [entry for entry in auto_apply.load_wal(wal_path)['entries'] if entry.get('operationId') == operation_id]
    if len(matches) != 1 or len(rows) != 1:
        raise RuntimeError('WAL operation or upload row is not unique')
    entry = matches[0]
    bundle = entry.get('bundle') or {}
    bundle_hashes = entry.get('bundleSha256') or {}
    rollback_path = matching_rollback_path(csv_path)
    audit_path = matching_audit_path(csv_path)
    expected_paths = {
        'upload': csv_path.resolve(),
        'rollback': rollback_path.resolve() if rollback_path is not None else None,
        'audit': audit_path.resolve() if audit_path is not None else None,
    }
    hashes_ok = True
    for name, actual_path in expected_paths.items():
        recorded_path = Path(str(bundle.get(name) or '')).resolve()
        if actual_path is None or recorded_path != actual_path or not actual_path.is_file() or str(bundle_hashes.get(name) or '') != hashlib.sha256(actual_path.read_bytes()).hexdigest():
            hashes_ok = False
            break
    row = rows[0]
    upload_kind = 'keyword' if str(row.get('keyword') or '') else 'item'
    key = row_key(upload_kind, str(row['itemCode']), str(row['keyword']))
    audit_rows = list(csv.DictReader([line for line in decode_csv_bytes(expected_paths['audit'].read_bytes()).splitlines() if line.strip()])) if expected_paths['audit'] else []
    relevant = [record for record in audit_rows if row_key(upload_kind, str(record.get('商品管理番号') or ''), str(record.get('キーワード') or '')) == key]
    audit_before = canonical_audit_cpc(relevant[0].get('変更前CPC'), '変更前CPC') if len(relevant) == 1 else None
    audit_after = canonical_audit_cpc(relevant[0].get('提案CPC'), '提案CPC') if len(relevant) == 1 else None
    actual_hash = hashlib.sha256(csv_path.read_bytes()).hexdigest()
    ok = (
        entry.get('state') == expected_state
        and hashes_ok
        and str(entry.get('itemCode') or '').strip().lower() == key[0]
        and str(entry.get('keyword') or '').strip() == key[1]
        and int(str(entry.get('beforeCpc'))) == audit_before
        and int(str(entry.get('afterCpc'))) == audit_after == int(str(row['targetCpc']))
    )
    if not ok:
        raise RuntimeError('WAL operation is not bound to the exact upload payload')
    return {'ok': True, 'operationId': operation_id, 'uploadSha256': actual_hash}


def canonical_audit_cpc(value: object, label: str) -> int:
    raw = str(value or '').strip()
    if not re.fullmatch(r'[1-9][0-9]*', raw):
        raise RuntimeError(f'{label} must be a canonical positive integer')
    return int(raw)


def validate_safety(
    csv_path: Path,
    upload_kind: str,
    rows: list[dict[str, object]],
    strict: bool,
    *,
    settings_path: Path | None = None,
    enforce_aux_freshness: bool = True,
) -> dict[str, object]:
    freshness = file_freshness(upload_kind)
    warnings: list[str] = []
    matches: list[dict[str, object]] = []
    checks: dict[str, object] = {'uploadKind': upload_kind, 'freshness': freshness, 'cpcMatches': matches, 'warnings': warnings}
    if not rows:
        return checks
    if enforce_aux_freshness and not freshness['readyForProduction']:
        raise RuntimeError(f'RPP data files are stale/missing; upload blocked: {json.dumps(freshness, ensure_ascii=False)}')
    audit = matching_audit_path(csv_path)
    if not audit:
        if strict:
            raise RuntimeError('matching audit CSV is required for final submit safety check')
        warnings.append('matching audit CSV not found; current-CPC check skipped')
        return checks
    latest = cpc_map_from_settings(settings_path or settings_path_for(upload_kind), upload_kind)
    audit_rows = list(csv.DictReader([line for line in decode_csv_bytes(audit.read_bytes()).splitlines() if line.strip()]))
    audit_rows = [
        r for r in audit_rows
        if (str(r.get('キーワード') or '').strip() == '商品CPC') == (upload_kind == 'item')
    ]
    rollback = csv_path.name.startswith('rollback_')
    current_column = '提案CPC' if rollback else '変更前CPC'
    target_column = '変更前CPC' if rollback else '提案CPC'
    audit_by_key = {
        row_key(upload_kind, r.get('商品管理番号', ''), r.get('キーワード', '')): r
        for r in audit_rows
    }
    if len(audit_by_key) != len(audit_rows):
        raise RuntimeError('audit CSV contains duplicate keys')
    for row in rows:
        key = row_key(upload_kind, str(row['itemCode']), str(row['keyword']))
        audit_row = audit_by_key.get(key)
        expected = canonical_audit_cpc(audit_row.get(current_column), current_column) if audit_row else None
        audit_target = canonical_audit_cpc(audit_row.get(target_column), target_column) if audit_row else None
        upload_target = int(str(row['targetCpc']))
        current = latest.get(key)
        ok = expected is not None and current == expected and upload_target == audit_target
        matches.append({'itemCode': key[0], 'keyword': key[1], 'expectedCurrentCpc': expected, 'latestCpc': current, 'uploadTargetCpc': upload_target, 'auditTargetCpc': audit_target, 'ok': ok})
        if not ok:
            raise RuntimeError(f'current CPC mismatch; upload blocked: {json.dumps(matches, ensure_ascii=False)}')
    if strict and not rollback:
        rollback_path = matching_rollback_path(csv_path)
        if not rollback_path:
            raise RuntimeError('matching rollback CSV is required for final submit')
        rollback_kind, rollback_rows = parse_upload_csv(rollback_path)
        if rollback_kind != upload_kind or len(rollback_rows) != len(rows):
            raise RuntimeError('matching rollback CSV shape does not match upload CSV')
        rollback_targets = {row_key(upload_kind, str(r['itemCode']), str(r['keyword'])): int(str(r['targetCpc'])) for r in rollback_rows}
        expected_targets = {key: canonical_audit_cpc(value.get('変更前CPC'), '変更前CPC') for key, value in audit_by_key.items()}
        if rollback_targets != expected_targets:
            raise RuntimeError('matching rollback CSV does not restore audit before-CPC values')
        checks['rollbackCsv'] = str(rollback_path)
    return checks


def latest_approved_csv() -> Path | None:
    upload_dir = PROJECT / 'rpp_uploads'
    files = [*upload_dir.glob('approved_keyword_cpc_update_*.csv'), *upload_dir.glob('approved_item_cpc_update_*.csv')]
    files = sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def emit(obj: dict[str, object]) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def append_apply_log(obj: dict[str, object]) -> str:
    APPLY_LOG_DIR.mkdir(exist_ok=True)
    entry = {
        'loggedAt': datetime.now(timezone.utc).isoformat(),
        'script': Path(__file__).name,
        **obj,
    }
    history: list[dict[str, object]] = []
    if APPLY_LOG_PATH.exists():
        try:
            loaded = json.loads(APPLY_LOG_PATH.read_text(encoding='utf-8'))
            history = loaded if isinstance(loaded, list) else loaded.get('entries', [])
        except Exception:
            history = []
    history.append(entry)
    tmp = APPLY_LOG_PATH.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(history, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(APPLY_LOG_PATH)
    return str(APPLY_LOG_PATH)


def finalize(obj: dict[str, object]) -> None:
    obj['applyLogPath'] = str(APPLY_LOG_PATH)
    append_apply_log(obj)
    emit(obj)


async def download_settings_export(page, upload_kind: str, purpose: str) -> dict[str, object]:
    # Generate a new RMS export first. Reusing an older completed history row can
    # falsely verify a submit against stale settings.
    import scripts_refresh_rpp_settings_csvs as settings_refresh

    menu_label = '登録済み商品全件ダウンロード' if upload_kind == 'item' else '手動登録済みキーワード全件ダウンロード'
    downloaded = await settings_refresh.download_settings_csv(page, menu_label, f'rpp_{upload_kind}_settings_{purpose}')
    replaced = replace_settings(downloaded.read_bytes(), downloaded.name, upload_kind)
    return {
        'uploadKind': upload_kind,
        'freshExportRequested': True,
        'completedMonotonic': time.monotonic(),
        'completedAt': datetime.now(timezone.utc).isoformat(),
        'download': replaced,
        'settingsPath': str(settings_path_for(upload_kind)),
    }


async def download_settings_and_verify(page, upload_kind: str, rows: list[dict[str, object]]) -> dict[str, object]:
    exported = await download_settings_export(page, upload_kind, 'readback')
    settings_path = Path(str(exported['settingsPath']))
    checks = readback_matches(upload_kind, rows, settings_path)
    return {
        'ok': bool(checks) and all(c['ok'] for c in checks),
        **exported,
        'checks': checks,
    }


async def fresh_delivery_guard(page, rows: list[dict[str, object]], item_export: dict[str, object]) -> dict[str, object]:
    import scripts_refresh_rpp_settings_csvs as settings_refresh
    codes, meta = await settings_refresh.collect_exclude_items(page)
    settings_refresh.validate_exclude_collection(codes, meta)
    normalized_codes = {str(code).strip().lower() for code in codes}
    checks = validate_active_not_excluded(rows, Path(str(item_export['settingsPath'])), normalized_codes)
    return {'ok': all(bool(check['ok']) for check in checks), 'checks': checks, 'exclusionObservation': meta, 'observedAt': datetime.now(timezone.utc).isoformat(), 'itemExportCompletedMonotonic': item_export['completedMonotonic'], 'completedMonotonic': time.monotonic()}


def assert_pre_submit_export_fresh(completed_monotonic: float, now_monotonic: float | None = None) -> float:
    elapsed = (time.monotonic() if now_monotonic is None else now_monotonic) - completed_monotonic
    if elapsed < 0 or elapsed > MAX_PRE_SUBMIT_EXPORT_AGE_SECONDS:
        raise RuntimeError(f'fresh RMS CPC export exceeded pre-submit maximum elapsed time: {elapsed:.3f}s')
    return elapsed


def assert_delivery_guard_fresh(completed_monotonic: float, now_monotonic: float | None = None) -> float:
    elapsed = (time.monotonic() if now_monotonic is None else now_monotonic) - completed_monotonic
    if elapsed < 0 or elapsed > MAX_DELIVERY_GUARD_AGE_SECONDS:
        raise RuntimeError(f'fresh RMS delivery guard exceeded maximum elapsed time: {elapsed:.3f}s')
    return elapsed


async def select_file_on_rms(csv_path: Path, upload_kind: str, final_submit: bool, rows: list[dict[str, object]], operation_id: str = '') -> dict[str, object]:
    # Reuse the proven lenient RMS login from the report refresh script.
    import scripts_refresh_rpp_keyword_report as rr

    rr.load_env(PROJECT / '.env')
    rr.load_env(RAKUTEN_MARKETING / '.env')
    p_inst = browser = page = None
    try:
        p_inst, browser, _context, page = await rr._rms_login_lenient()
        pre_submit_export = None
        pre_submit_checks = None
        delivery_guard = None
        if final_submit:
            item_export = await download_settings_export(page, 'item', 'pre_submit_delivery')
            delivery_guard = await fresh_delivery_guard(page, rows, item_export)
            pre_submit_export = item_export if upload_kind == 'item' else await download_settings_export(page, upload_kind, 'pre_submit')
            pre_submit_checks = validate_safety(
                csv_path, upload_kind, rows, strict=True,
                settings_path=Path(str(pre_submit_export['settingsPath'])),
                enforce_aux_freshness=False,
            )

        await page.goto('https://ad.rms.rakuten.co.jp/rpp/items', wait_until='networkidle', timeout=60000)
        await page.wait_for_timeout(2000)

        body = await page.evaluate('() => document.body.innerText.slice(0, 2000)')
        if any(x in body for x in ['ログイン', 'ユーザID', 'パスワード']) and '商品・キーワード設定' not in body:
            raise RuntimeError('RMS login required or not completed; upload aborted')

        await page.locator('text=一括アップロード').first.click(timeout=10000)
        await page.wait_for_timeout(1000)
        upload_label = '商品CPCの登録/更新' if upload_kind == 'item' else 'キーワードCPCの登録/更新'
        panel_link = page.get_by_text(upload_label, exact=True)
        if await panel_link.count() == 0:
            raise RuntimeError(f'RMS {upload_kind} CPC upload panel not found: {upload_label}')
        await panel_link.first.click(timeout=10000)
        await page.wait_for_timeout(1000)

        file_input = page.locator('input[type="file"]').first
        if await file_input.count() == 0:
            raise RuntimeError(f'RMS upload file input not found after opening {upload_kind} CPC upload panel')
        await file_input.set_input_files(str(csv_path))
        await page.wait_for_timeout(1000)

        SNAPSHOTS.mkdir(exist_ok=True)
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')
        screenshot = SNAPSHOTS / f'phase4_python_file_selected_{ts}.png'
        await page.screenshot(path=str(screenshot), full_page=True)

        info = await page.evaluate('''() => ({
          url: location.href,
          title: document.title,
          fileValue: document.querySelector('input[type="file"]')?.value || '',
          filenameInputs: [...document.querySelectorAll('input[name="filename"], input[type="text"]')]
            .map(e => ({value: e.value, visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length)}))
            .slice(0, 5),
          buttons: [...document.querySelectorAll('button,input[type="button"],input[type="submit"],a')]
            .map(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim())
            .filter(Boolean)
            .slice(0, 40)
        })''')

        if not final_submit:
            return {
                'fileSelected': True,
                'uploadKind': upload_kind,
                'uploadPanel': upload_label,
                'finalSubmitSkipped': True,
                'reason': 'missing --final-submit',
                'screenshot': str(screenshot),
                **info,
            }

        if not isinstance(pre_submit_export, dict):
            raise RuntimeError('fresh RMS CPC export is required immediately before submit')
        upload_button = page.locator('#btnUploadFile')
        if await upload_button.count() != 1:
            raise RuntimeError('RMS upload button is missing or ambiguous')
        await upload_button.wait_for(state='visible', timeout=5000)
        if not await upload_button.is_enabled():
            raise RuntimeError('RMS upload button is not enabled')
        import rpp_allowed_auto_apply as auto_apply
        auto_apply.sync_current_targets(PROJECT / 'rpp_targets' / 'rpp_alert_targets.json')
        authority_checks = validate_auto_apply_authority(csv_path, upload_kind, rows, operation_id, require=True)
        wal_binding = validate_wal_binding(operation_id, csv_path, rows)
        elapsed = assert_pre_submit_export_fresh(float(str(pre_submit_export['completedMonotonic'])))
        if not isinstance(delivery_guard, dict) or delivery_guard.get('ok') is not True:
            raise RuntimeError('fresh RMS active/non-excluded delivery guard is required')
        delivery_elapsed = assert_delivery_guard_fresh(float(str(delivery_guard['completedMonotonic'])))
        item_delivery_elapsed = assert_delivery_guard_fresh(float(str(delivery_guard['itemExportCompletedMonotonic'])))
        wal_transition(operation_id, 'SUBMITTING', {'preSubmitExportCompletedAt': pre_submit_export['completedAt'], 'preSubmitElapsedSeconds': elapsed, 'deliveryGuardElapsedSeconds': delivery_elapsed, 'itemDeliveryElapsedSeconds': item_delivery_elapsed, 'deliveryGuard': delivery_guard, 'authorityChecks': authority_checks, 'walBinding': wal_binding})
        validate_wal_binding(operation_id, csv_path, rows, expected_state='SUBMITTING')
        assert_pre_submit_export_fresh(float(str(pre_submit_export['completedMonotonic'])))
        assert_delivery_guard_fresh(float(str(delivery_guard['completedMonotonic'])))
        assert_delivery_guard_fresh(float(str(delivery_guard['itemExportCompletedMonotonic'])))
        try:
            await upload_button.click(timeout=1000)
        except Exception:
            wal_transition(operation_id, 'UNCERTAIN', {'verification': 'UNKNOWN', 'failureStage': 'SUBMIT_CLICK'})
            raise
        wal_transition(operation_id, 'SUBMITTED', {'submittedAt': datetime.now(timezone.utc).isoformat()})
        # From this point onward the external state may have changed. Never raise
        # a post-submit evidence/readback failure as if productionChange were false.
        after = ''
        screenshot_after: Path | None = SNAPSHOTS / f'phase4_python_after_submit_{ts}.png'
        submit_result: dict[str, object] = {'confirmed': False, 'successCount': None, 'failureCount': None}
        readback: dict[str, object] = {'ok': False, 'reason': 'not reached'}
        post_submit_error = None
        try:
            try:
                await page.wait_for_function("() => /件が登録されました|件が失敗しました/.test(document.body.innerText)", timeout=30000)
            except Exception:
                pass
            after = await page.evaluate('() => document.body.innerText.slice(0, 4000)')
            try:
                await page.screenshot(path=str(screenshot_after), full_page=True)
            except Exception as error:
                screenshot_after = None
                post_submit_error = f'screenshot failed: {error}'
            success_match = re.search(r'([0-9,]+)\s*/\s*([0-9,]+)\s*件が登録されました', after)
            failure_match = re.search(r'([0-9,]+)\s*/\s*([0-9,]+)\s*件が失敗しました', after)
            submit_result = {
                'confirmed': bool(success_match or failure_match),
                'successCount': int(success_match.group(1).replace(',', '')) if success_match else None,
                'failureCount': int(failure_match.group(1).replace(',', '')) if failure_match else None,
            }
            try:
                readback = await download_settings_and_verify(page, upload_kind, rows)
            except Exception as error:
                readback = {'ok': False, 'reason': str(error), 'uploadKind': upload_kind}
        except Exception as error:
            post_submit_error = str(error)
        result = {
            'fileSelected': True,
            'uploadKind': upload_kind,
            'uploadPanel': upload_label,
            'finalSubmitClicked': True,
            'screenshot': str(screenshot_after) if screenshot_after else None,
            'pageTextSample': after,
            'submitResult': submit_result,
            'readback': readback,
            'preSubmitExport': pre_submit_export,
            'preSubmitChecks': pre_submit_checks,
            'deliveryGuard': delivery_guard,
            'authorityChecks': authority_checks,
            'postSubmitError': post_submit_error,
            **info,
        }
        if final_submit_verified(result, len(rows)):
            wal_transition(operation_id, 'VERIFIED', {'verifiedAt': datetime.now(timezone.utc).isoformat()})
        else:
            wal_transition(operation_id, 'UNCERTAIN', {'verification': 'UNKNOWN', 'failureStage': 'POST_SUBMIT_VERIFICATION'})
        return result
    finally:
        if browser:
            await browser.close()
        if p_inst:
            await p_inst.stop()


def final_submit_verified(applied: dict[str, object], row_count: int) -> bool:
    submit_result = applied.get('submitResult', {})
    readback = applied.get('readback', {})
    return bool(
        isinstance(submit_result, dict)
        and submit_result.get('confirmed')
        and submit_result.get('successCount') == row_count
        and submit_result.get('failureCount') == 0
        and isinstance(readback, dict)
        and readback.get('ok')
    )


async def main_async() -> int:
    global ACTIVE_OPERATION_ID
    parser = argparse.ArgumentParser()
    parser.add_argument('--csv', dest='csv_path', default='')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--confirm', default='')
    parser.add_argument('--final-submit', action='store_true')
    parser.add_argument('--allow-multiple', action='store_true')
    parser.add_argument('--rollback', action='store_true', help='required for rollback_*.csv and uses separate env/confirm guards')
    parser.add_argument('--operation-id', default='')
    args = parser.parse_args()
    ACTIVE_OPERATION_ID = args.operation_id
    env_operation_id = os.environ.get('RPP_AUTO_APPLY_OPERATION_ID', '')
    if env_operation_id and args.operation_id != env_operation_id:
        raise RuntimeError('auto-apply operation ID does not match environment')
    if args.final_submit and not args.operation_id:
        raise RuntimeError('operation ID is required for every final submit')

    load_env(PROJECT / '.env')
    load_env(RAKUTEN_MARKETING / '.env')

    csv_path = Path(args.csv_path).expanduser() if args.csv_path else latest_approved_csv()
    if not csv_path:
        raise RuntimeError('approved CSV not found')
    if not csv_path.is_absolute():
        csv_path = (PROJECT / csv_path).resolve()

    is_rollback_csv = csv_path.name.startswith('rollback_')
    if is_rollback_csv != args.rollback:
        raise RuntimeError('rollback CSV requires --rollback, and --rollback requires a rollback_*.csv')
    upload_kind, rows = parse_upload_csv(csv_path)
    authority_checks = validate_auto_apply_authority(csv_path, upload_kind, rows, args.operation_id)
    # Static bundle validation here; the authoritative current-CPC check is done
    # from a newly requested RMS export inside select_file_on_rms.
    safety_checks = validate_safety(csv_path, upload_kind, rows, strict=False, enforce_aux_freshness=False)
    base = {
        'ok': True,
        'productionChange': False,
        'uploadCsv': str(csv_path),
        'uploadKind': upload_kind,
        'rollback': args.rollback,
        'rowCount': len(rows),
        'rows': rows,
        'safetyChecks': safety_checks,
        'authorityChecks': authority_checks,
    }

    if len(rows) == 0:
        finalize({**base, 'skipped': True, 'reason': 'approved rows are 0'})
        return 0
    if len(rows) > 1 and not args.allow_multiple:
        raise RuntimeError(f'approved rows {len(rows)} > 1; Phase4 first run allows only one row')
    if not args.execute:
        finalize({**base, 'dryRun': True, 'reason': 'missing --execute'})
        return 0
    required_env = 'RPP_ENABLE_PRODUCTION_ROLLBACK' if args.rollback else 'RPP_ENABLE_PRODUCTION_UPLOAD'
    required_confirm = 'RMS_CPC_ROLLBACK' if args.rollback else 'RMS_CPC_UPLOAD'
    if os.environ.get(required_env) != '1':
        raise RuntimeError(f'{required_env}=1 is required for this RMS path')
    if args.confirm != required_confirm:
        raise RuntimeError(f'--confirm={required_confirm} is required')

    applied = await select_file_on_rms(csv_path, upload_kind=upload_kind, final_submit=args.final_submit, rows=rows, operation_id=args.operation_id)
    verified = final_submit_verified(applied, len(rows)) if args.final_submit else True
    finalize({**base, 'ok': verified, 'productionChange': bool(args.final_submit), 'verified': verified, 'applied': applied})
    return 0 if verified else 2


def main() -> int:
    try:
        return asyncio.run(main_async())
    except Exception as e:
        state = ''
        production_change = False
        if ACTIVE_OPERATION_ID:
            try:
                state = wal_state(ACTIVE_OPERATION_ID)
                production_change = state in {'SUBMITTING', 'SUBMITTED', 'VERIFIED', 'UNCERTAIN', 'UNKNOWN'}
                if state in {'SUBMITTING', 'SUBMITTED'}:
                    wal_transition(ACTIVE_OPERATION_ID, 'UNCERTAIN', {'verification': 'UNKNOWN', 'failureStage': 'UNHANDLED_POST_SUBMIT'})
                    state = 'UNCERTAIN'
            except Exception:
                # A broken/missing WAL is itself uncertain once submit may have begun.
                production_change = production_change or state in {'SUBMITTING', 'SUBMITTED'}
        error_obj = {
            'ok': False,
            'productionChange': production_change,
            'walState': state or None,
            'error': str(e),
        }
        try:
            append_apply_log(error_obj)
        except Exception:
            pass
        print(f'❌ エラー: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
