#!/usr/bin/env python3
"""Refresh rpp_item_reports.csv from RMS RPP item/product report.

Read-only: logs in to RMS, downloads yesterday's product report, extracts the CSV,
and replaces ./rpp_item_reports.csv only after a valid header is found.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile
import zlib
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
from rpp_performance_contract import JST, item_set_sha256, parse_performance_csv, parse_receipt_times, receipt_message, rows_sha256, validate_batch_quorum, validate_batch_sequence

PROJECT = Path(os.environ.get('RPP_PROJECT_DIR', '/Users/nob/Projects/rpp-8am-notify'))
RAKUTEN_MARKETING = Path('/Users/nob/Projects/rakuten-marketing')
OUT = PROJECT / 'rpp_item_reports.csv'
DOWNLOADS = PROJECT / 'rpp_downloads'
DOWNLOADS.mkdir(exist_ok=True)
LOGS = PROJECT / 'rpp_logs'
LOGS.mkdir(exist_ok=True)
LOCK = PROJECT / '.rpp_product_report_refresh.lock'


def receipt_key() -> bytes:
    value = os.environ.get('RPP_PERFORMANCE_RECEIPT_HMAC_KEY', '').strip()
    if not value:
        result = subprocess.run(['security', 'find-generic-password', '-s', 'hermes.rpp.performance-receipt-hmac', '-w'], text=True, capture_output=True, check=False)
        value = result.stdout.strip() if result.returncode == 0 else ''
    if len(value) < 32:
        raise RuntimeError('RPP performance receipt HMAC key is not configured')
    return value.encode()


def _fsync_file(path: Path) -> None:
    with path.open('rb') as handle:
        os.fsync(handle.fileno())


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _crash_point(name: str) -> None:
    if os.environ.get('RPP_TEST_CRASH_AT') == name:
        os._exit(93)


def publish_validated_report(extracted: Path, out_path: Path, receipt_path: Path, receipt: dict, backup: Path | None) -> Path:
    generations = out_path.parent / 'rpp_performance_generations'
    generations.mkdir(parents=True, exist_ok=True)
    for stale in generations.glob('.tmp-*'):
        if stale.is_dir():
            shutil.rmtree(stale)
    generation_id = f'generation-{time.time_ns()}'
    temporary = generations / f'.tmp-{generation_id}'
    final = generations / generation_id
    temporary.mkdir()
    report_target = temporary / 'rpp_item_reports.csv'
    generation_receipt = temporary / 'receipt.json'
    link_tmp = out_path.with_name(f'.{out_path.name}.{generation_id}.tmp')
    try:
        shutil.copy2(extracted, report_target)
        generation_receipt.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        if hashlib.sha256(report_target.read_bytes()).hexdigest() != receipt['output_sha256']:
            raise RuntimeError('RPP item report generation readback mismatch')
        _fsync_file(report_target)
        _fsync_file(generation_receipt)
        _fsync_directory(temporary)
        _crash_point('before_generation_commit')
        os.replace(temporary, final)
        _fsync_directory(generations)
        _crash_point('after_generation_commit')
        if backup and out_path.exists():
            shutil.copy2(out_path, backup)
            _fsync_file(backup)
        target = os.path.relpath(final / 'rpp_item_reports.csv', out_path.parent)
        os.symlink(target, link_tmp)
        os.replace(link_tmp, out_path)
        _fsync_directory(out_path.parent)
        _crash_point('after_pointer_switch')
        resolved = out_path.resolve(strict=True)
        final_receipt = resolved.parent / 'receipt.json'
        if resolved != (final / 'rpp_item_reports.csv').resolve() or not final_receipt.is_file() or final_receipt.is_symlink():
            raise RuntimeError('RPP item report generation pointer readback mismatch')
        if hashlib.sha256(resolved.read_bytes()).hexdigest() != receipt['output_sha256']:
            raise RuntimeError('RPP item report generation hash mismatch')
        receipt_log_tmp = receipt_path.with_suffix('.json.tmp')
        shutil.copy2(final_receipt, receipt_log_tmp)
        os.replace(receipt_log_tmp, receipt_path)
        _fsync_directory(receipt_path.parent)
        return final_receipt
    except Exception:
        link_tmp.unlink(missing_ok=True)
        if temporary.exists():
            shutil.rmtree(temporary)
        raise


@contextmanager
def exclusive_refresh_lock(path: Path):
    handle = path.open('a+')
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as exc:
        handle.close()
        raise RuntimeError('RPP product report refresh is already running') from exc
    try:
        yield
    finally:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def select_history_row(rows: list[dict], start_jp: str, end_jp: str, not_before: str, existing_rows: list[str]) -> int:
    for row in rows:
        text = str(row.get('text') or '').strip()
        created_at = str(row.get('createdAt') or '').strip()
        if 'パフォーマンスレポート' in text and ('全商品レポートダウンロード' in text or '商品レポートダウンロード' in text) and '完了' in text and start_jp in text and end_jp in text and created_at >= not_before and text not in existing_rows:
            return int(row['index'])
    return -1


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(errors='replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def decode_text(raw: bytes) -> str:
    for enc in ('shift_jis', 'cp932', 'utf-8-sig', 'utf-8'):
        try:
            return raw.decode(enc)
        except Exception:
            pass
    return raw.decode('utf-8', 'replace')


def extract_csv(download_path: Path) -> tuple[str, list[list[str]], Path, dict]:
    if zipfile.is_zipfile(download_path):
        with zipfile.ZipFile(download_path) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith('.csv')]
            if len(names) != 1:
                raise RuntimeError(f'CSV not found in zip: {download_path}')
            if zf.testzip() is not None:
                raise RuntimeError('RPP item report zip CRC validation failed')
            info = zf.getinfo(names[0])
            raw = zf.read(names[0])
            source_name = names[0]
            manifest = {'source_csv_crc32': f'{info.CRC:08x}', 'source_csv_compressed_bytes': info.compress_size, 'source_csv_uncompressed_bytes': info.file_size, 'source_csv_name_sha256': hashlib.sha256(source_name.encode()).hexdigest()}
    else:
        raw = download_path.read_bytes()
        source_name = download_path.name
        manifest = {'source_csv_crc32': f'{zlib.crc32(raw) & 0xffffffff:08x}', 'source_csv_compressed_bytes': len(raw), 'source_csv_uncompressed_bytes': len(raw), 'source_csv_name_sha256': hashlib.sha256(source_name.encode()).hexdigest()}

    text = decode_text(raw)
    lines = text.splitlines()
    header_idx = next((i for i, line in enumerate(lines) if 'コントロールカラム' in line and '商品管理番号' in line), None)
    if header_idx is None:
        raise RuntimeError('RPP item CSV header not found')
    body = [line for line in lines[header_idx:] if line.strip()]
    rows = list(csv.reader(body))
    header = rows[0] if rows else []
    required = ['商品管理番号', 'クリック数', '売上金額', 'ROAS']
    missing = [x for x in required if not any(x in h for h in header)]
    if missing:
        raise RuntimeError(f'RPP item CSV missing columns: {missing}')
    if len(rows) < 2 or any(len(row) != len(header) for row in rows[1:]):
        raise RuntimeError('RPP item CSV is empty or contains a truncated row')
    normalized = '\r\n'.join(body) + '\r\n'
    tmp = DOWNLOADS / f'item_report_extracted_{time.time_ns()}.csv'
    tmp.write_bytes(normalized.encode('cp932', errors='replace'))
    if len(raw) != manifest['source_csv_uncompressed_bytes']:
        raise RuntimeError('RPP item report provider manifest size mismatch')
    return source_name, rows, tmp, manifest


async def click_radio(page, radio_id: str, label_text: str) -> None:
    loc = page.locator(f'#{radio_id}')
    if await loc.count() > 0:
        await loc.first.click()
        return
    ok = await page.evaluate('''label => {
      const radios = [...document.querySelectorAll('input[type="radio"]')];
      const target = radios.find(e => ((e.closest('label')?.innerText || e.parentElement?.innerText || '').includes(label)));
      if (target) { target.click(); return true; }
      return false;
    }''', label_text)
    if not ok:
        snapshot = await page.evaluate('''() => [...document.querySelectorAll('input[type="radio"]')]
          .map(e => ({id:e.id, value:e.value, text:(e.closest('label')?.innerText || e.parentElement?.innerText || '').trim()}))''')
        raise RuntimeError(f'radio not found: {radio_id}/{label_text}; radios={snapshot}')


async def download_item_report(start: date, end: date) -> tuple[Path, dict]:
    from scripts_refresh_rpp_keyword_report import _rms_login_lenient
    p_inst = browser = None
    try:
        p_inst, browser, context, page = await _rms_login_lenient()
        await page.goto('https://ad.rms.rakuten.co.jp/rpp/reports', timeout=60000)
        await page.wait_for_load_state('networkidle', timeout=60000)
        await page.wait_for_timeout(3000)

        await click_radio(page, 'rdReportTypeItem', '商品別')
        await page.wait_for_timeout(1000)
        await click_radio(page, 'rdPeriodAll', '全期間で表示')
        await page.wait_for_timeout(1000)

        start_ds = start.strftime('%Y-%m-%d')
        end_ds = end.strftime('%Y-%m-%d')
        start_input = page.locator('input[placeholder="Select start"]').first
        end_input = page.locator('input[placeholder="Select end"]').first
        await start_input.click(); await start_input.fill(start_ds)
        await end_input.click(); await end_input.fill(end_ds)
        await page.locator('body').click(position={'x': 10, 'y': 10})
        await page.wait_for_timeout(1000)

        start_jp = f'{start.year}年{start.month:02d}月{start.day:02d}日'
        end_jp = f'{end.year}年{end.month:02d}月{end.day:02d}日'
        history_probe = await context.new_page()
        await history_probe.goto('https://ad.rms.rakuten.co.jp/rpp/download', timeout=60000)
        await history_probe.wait_for_load_state('networkidle', timeout=60000)
        existing_rows = await history_probe.evaluate('''args => [...document.querySelectorAll('tr')]
          .filter(r => r.innerText.includes('パフォーマンスレポート')
            && (r.innerText.includes('全商品レポートダウンロード') || r.innerText.includes('商品レポートダウンロード'))
            && r.innerText.includes(args.startJp) && r.innerText.includes(args.endJp))
          .map(r => r.innerText.trim())''', {'startJp': start_jp, 'endJp': end_jp})
        await history_probe.close()
        request_started = datetime.now(JST)
        not_before = (request_started - timedelta(seconds=5)).strftime('%Y-%m-%d %H:%M:%S')
        await page.locator('#btnReportSearch, button:has-text("この条件で検索")').first.click()
        await page.wait_for_timeout(3000)
        # 商品別全件ダウンロードボタンをID優先、なければ文言で押す
        clicked = False
        for selector in ['#btnAllItemReport', '#btnItemReport', 'button:has-text("全商品レポート")', 'button:has-text("商品レポート")', 'a:has-text("全商品レポート")']:
            loc = page.locator(selector)
            if await loc.count() > 0:
                await loc.first.click(timeout=10000)
                clicked = True
                break
        if not clicked:
            sample = await page.evaluate('''() => [...document.querySelectorAll('button,a')].map(e => ({id:e.id, text:(e.innerText||e.value||'').trim(), disabled:e.disabled})).filter(x=>x.text||x.id).slice(0,80)''')
            raise RuntimeError(f'item report download button not found; controls={sample}')
        await page.wait_for_timeout(10_000)

        await page.goto('https://ad.rms.rakuten.co.jp/rpp/download', timeout=60000)
        await page.wait_for_load_state('networkidle', timeout=60000)
        await page.wait_for_timeout(3000)
        async def current_row_index() -> int:
            rows = await page.evaluate('''() => [...document.querySelectorAll('tr')].map((r, index) => ({index, text:r.innerText.trim(), createdAt:(r.querySelector('td:first-child')?.innerText || '').trim()}))''')
            return select_history_row(rows, start_jp, end_jp, not_before, existing_rows)
        row_index = await current_row_index()
        if row_index < 0:
            for _ in range(6):
                refresh = page.locator('#btnDownloadHistoryRefresh')
                if await refresh.count() > 0:
                    await refresh.first.click()
                await page.wait_for_timeout(5000)
                row_index = await current_row_index()
                if row_index >= 0:
                    break
        if row_index < 0:
            sample = await page.evaluate('''() => document.body.innerText.slice(0, 2000)''')
            raise RuntimeError(f'item report download history row not found for {start_jp}〜{end_jp}; sample={sample}')
        history_row = await page.evaluate("idx => [...document.querySelectorAll('tr')][idx].innerText.trim()", row_index)
        history_created_at = await page.evaluate("idx => ([...document.querySelectorAll('tr')][idx].querySelector('td:first-child')?.innerText || '').trim()", row_index)

        async with page.expect_download(timeout=60000) as dl_info:
            ok = await page.evaluate('''idx => {
              const row = [...document.querySelectorAll('tr')][idx];
              const el = [...row.querySelectorAll('a,button')].find(e => (e.innerText || e.value || '').includes('ダウンロード'));
              if (el) { el.click(); return true; }
              return false;
            }''', row_index)
            if not ok:
                raise RuntimeError('download button not found in matched item report row')
        download = await dl_info.value
        out = DOWNLOADS / f'rpp_item_{time.time_ns()}_{download.suggested_filename}'
        await download.save_as(str(out))
        return out, {'request_started_at': request_started.isoformat(), 'history_created_at': history_created_at, 'history_row_sha256': hashlib.sha256(history_row.encode()).hexdigest(), 'download_completed_at': datetime.now(JST).isoformat()}
    finally:
        if browser:
            await browser.close()
        if p_inst:
            await p_inst.stop()


def default_report_date(now: datetime | None = None) -> str:
    current = (now or datetime.now(JST)).astimezone(JST)
    return (current.date() - timedelta(days=1)).isoformat()


def main() -> int:
    ap = argparse.ArgumentParser()
    default_date = os.getenv('RPP_REPORT_DATE') or default_report_date()
    ap.add_argument('--date', default=default_date, help='終了日 YYYY-MM-DD。省略時は前日')
    ap.add_argument('--days', type=int, default=1, help='取得日数。7を指定すると終了日を含む過去7日')
    ap.add_argument('--out', default=str(OUT), help='出力CSVパス')
    args = ap.parse_args()
    end = date.fromisoformat(args.date)
    start = end - timedelta(days=max(1, args.days) - 1)
    out_path = Path(args.out).expanduser().absolute()
    load_env(PROJECT / '.env')
    load_env(RAKUTEN_MARKETING / '.env')
    before_mtime = out_path.stat().st_mtime if out_path.exists() else None
    lock_context = exclusive_refresh_lock(LOCK)
    lock_context.__enter__()
    try:
        verification_download, verification_evidence = asyncio.run(download_item_report(start, end))
        _, verification_raw_rows, verification_extracted, _ = extract_csv(verification_download)
        verification_date, verification_rows = parse_performance_csv(verification_extracted, expected_start=start, expected_end=end)
        downloaded, request_evidence = asyncio.run(download_item_report(start, end))
        source_name, rows, extracted, provider_manifest = extract_csv(downloaded)
        report_date, normalized_rows = parse_performance_csv(extracted, expected_start=start, expected_end=end)
        if report_date != end.isoformat() or len(normalized_rows) != len(rows) - 1:
            raise RuntimeError('RPP item report normalized row manifest mismatch')
        if verification_date != end.isoformat() or verification_date != report_date or len(verification_rows) != len(verification_raw_rows) - 1:
            raise RuntimeError('RPP item report verification batch date mismatch')
        expected_count, expected_item_set_sha256 = validate_batch_quorum(verification_rows, normalized_rows)
        if verification_evidence['history_row_sha256'] == request_evidence['history_row_sha256']:
            raise RuntimeError('RPP item report verification did not use an independent history row')
        completed_at = datetime.now(JST).isoformat()
        source_mtime = datetime.fromtimestamp(extracted.stat().st_mtime, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        verification_source_mtime = datetime.fromtimestamp(verification_extracted.stat().st_mtime, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        backup = DOWNLOADS / f'{out_path.stem}_backup_{time.time_ns()}.csv' if out_path.exists() else None
        receipt = {
            'version': 1,
            'ok': True,
            'download_complete': True,
            'start_date': start.isoformat(),
            'end_date': end.isoformat(),
            'days': max(1, args.days),
            'downloaded': str(downloaded),
            'source_csv': source_name,
            'output': str(out_path),
            'backup': str(backup) if backup else None,
            'rows_including_header': len(rows),
            'data_rows': max(0, len(rows) - 1),
            'expected_count': expected_count,
            'actual_count': len(normalized_rows),
            'expected_item_set_sha256': expected_item_set_sha256,
            'output_sha256': hashlib.sha256(extracted.read_bytes()).hexdigest(),
            'source_archive_sha256': hashlib.sha256(downloaded.read_bytes()).hexdigest(),
            'source_archive_bytes': downloaded.stat().st_size,
            **provider_manifest,
            'verification_request_started_at': verification_evidence['request_started_at'],
            'verification_history_created_at': verification_evidence['history_created_at'],
            'verification_history_row_sha256': verification_evidence['history_row_sha256'],
            'verification_archive_sha256': hashlib.sha256(verification_download.read_bytes()).hexdigest(),
            'verification_source_mtime': verification_source_mtime,
            'verification_completed_at': verification_evidence['download_completed_at'],
            'source': out_path.name,
            'source_mtime': source_mtime,
            'rows_sha256': rows_sha256(normalized_rows),
            'completed_at': completed_at,
            **request_evidence,
            'mtime_changed': before_mtime != extracted.stat().st_mtime,
            'header_sample': rows[0][:8] if rows else [],
        }
        verification_receipt = {'request_started_at': receipt['verification_request_started_at'], 'history_created_at': receipt['verification_history_created_at'], 'source_mtime': receipt['verification_source_mtime'], 'completed_at': receipt['verification_completed_at']}
        validate_batch_sequence(verification_receipt, receipt, report_date=report_date)
        key = receipt_key()
        receipt['signature'] = hmac.new(key, receipt_message(receipt), hashlib.sha256).hexdigest()
        receipt_path = LOGS / f'rpp_product_report_refresh_{time.time_ns()}.json'
        authoritative_receipt = publish_validated_report(extracted, out_path, receipt_path, receipt, backup)
        receipt['receipt'] = str(authoritative_receipt)
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
        return 0
    finally:
        lock_context.__exit__(*sys.exc_info())


if __name__ == '__main__':
    raise SystemExit(main())
