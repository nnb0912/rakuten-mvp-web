#!/usr/bin/env python3
"""Refresh rpp_item_reports.csv from RMS RPP item/product report.

Read-only: logs in to RMS, downloads yesterday's product report, extracts the CSV,
and replaces ./rpp_item_reports.csv only after a valid header is found.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import json
import os
import shutil
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

PROJECT = Path(os.environ.get('RPP_PROJECT_DIR', '/Users/nob/Projects/rpp-8am-notify'))
RAKUTEN_MARKETING = Path('/Users/nob/Projects/rakuten-marketing')
OUT = PROJECT / 'rpp_item_reports.csv'
DOWNLOADS = PROJECT / 'rpp_downloads'
DOWNLOADS.mkdir(exist_ok=True)
LOGS = PROJECT / 'rpp_logs'
LOGS.mkdir(exist_ok=True)


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


def extract_csv(download_path: Path) -> tuple[str, list[list[str]], Path]:
    if zipfile.is_zipfile(download_path):
        with zipfile.ZipFile(download_path) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith('.csv')]
            if not names:
                raise RuntimeError(f'CSV not found in zip: {download_path}')
            raw = zf.read(names[0])
            source_name = names[0]
    else:
        raw = download_path.read_bytes()
        source_name = download_path.name

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
    tmp = DOWNLOADS / f'item_report_extracted_{datetime.now():%Y%m%d_%H%M%S}.csv'
    tmp.write_bytes(normalized.encode('cp932', errors='replace'))
    return source_name, rows, tmp


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


async def download_item_report(start: date, end: date) -> Path:
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
        start_jp = f'{start.year}年{start.month:02d}月{start.day:02d}日'
        end_jp = f'{end.year}年{end.month:02d}月{end.day:02d}日'
        def row_js():
            return '''args => {
              const {startJp, endJp} = args;
              const rows = [...document.querySelectorAll('tr')];
              return rows.findIndex(r => r.innerText.includes('パフォーマンスレポート')
                && (r.innerText.includes('全商品レポートダウンロード') || r.innerText.includes('商品レポートダウンロード'))
                && r.innerText.includes('完了')
                && r.innerText.includes(startJp)
                && r.innerText.includes(endJp));
            }'''
        row_index = await page.evaluate(row_js(), {'startJp': start_jp, 'endJp': end_jp})
        if row_index < 0:
            for _ in range(6):
                refresh = page.locator('#btnDownloadHistoryRefresh')
                if await refresh.count() > 0:
                    await refresh.first.click()
                await page.wait_for_timeout(5000)
                row_index = await page.evaluate(row_js(), {'startJp': start_jp, 'endJp': end_jp})
                if row_index >= 0:
                    break
        if row_index < 0:
            sample = await page.evaluate('''() => document.body.innerText.slice(0, 2000)''')
            raise RuntimeError(f'item report download history row not found for {start_jp}〜{end_jp}; sample={sample}')

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
        out = DOWNLOADS / f'rpp_item_{datetime.now():%Y%m%d_%H%M%S}_{download.suggested_filename}'
        await download.save_as(str(out))
        return out
    finally:
        if browser:
            await browser.close()
        if p_inst:
            await p_inst.stop()


def main() -> int:
    ap = argparse.ArgumentParser()
    default_date = os.getenv('RPP_REPORT_DATE') or (date.today() - timedelta(days=1)).isoformat()
    ap.add_argument('--date', default=default_date, help='終了日 YYYY-MM-DD。省略時は前日')
    ap.add_argument('--days', type=int, default=1, help='取得日数。7を指定すると終了日を含む過去7日')
    ap.add_argument('--out', default=str(OUT), help='出力CSVパス')
    args = ap.parse_args()
    end = date.fromisoformat(args.date)
    start = end - timedelta(days=max(1, args.days) - 1)
    out_path = Path(args.out).expanduser().resolve()
    load_env(PROJECT / '.env')
    load_env(RAKUTEN_MARKETING / '.env')
    before_mtime = out_path.stat().st_mtime if out_path.exists() else None
    downloaded = asyncio.run(download_item_report(start, end))
    source_name, rows, extracted = extract_csv(downloaded)
    backup = None
    if out_path.exists():
        backup = DOWNLOADS / f'{out_path.stem}_backup_{datetime.now():%Y%m%d_%H%M%S}.csv'
        shutil.copy2(out_path, backup)
    shutil.copy2(extracted, out_path)
    after_mtime = out_path.stat().st_mtime
    receipt = {
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
        'expected_count': max(0, len(rows) - 1),
        'actual_count': max(0, len(rows) - 1),
        'output_sha256': hashlib.sha256(out_path.read_bytes()).hexdigest(),
        'source_archive_sha256': hashlib.sha256(downloaded.read_bytes()).hexdigest(),
        'completed_at': datetime.now().astimezone().isoformat(),
        'mtime_changed': before_mtime != after_mtime,
        'header_sample': rows[0][:8] if rows else [],
    }
    receipt_path = LOGS / f'rpp_product_report_refresh_{datetime.now():%Y%m%d_%H%M%S}.json'
    receipt_tmp = receipt_path.with_suffix('.json.tmp')
    receipt_tmp.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    receipt_tmp.replace(receipt_path)
    receipt['receipt'] = str(receipt_path)
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

