#!/usr/bin/env python3
"""Refresh rpp_keyword_reports.csv from RMS RPP keyword report.

Read-only: logs in to RMS, downloads yesterday's keyword report, extracts the CSV,
and replaces ./rpp_keyword_reports.csv only after a valid header is found.
Secrets are read from .env and never printed.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import shutil
import sys
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path

PROJECT = Path(__file__).resolve().parent
RAKUTEN_MARKETING = Path('/Users/nob/Projects/rakuten-marketing')
OUT = PROJECT / 'rpp_keyword_reports.csv'
DOWNLOADS = PROJECT / 'rpp_downloads'
DOWNLOADS.mkdir(exist_ok=True)


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
        raise RuntimeError('RPP keyword CSV header not found')
    body = [line for line in lines[header_idx:] if line.strip()]
    rows = list(csv.reader(body))
    header = rows[0] if rows else []
    required = ['商品管理番号', 'キーワード', 'クリック数', '売上金額', 'ROAS']
    missing = [x for x in required if not any(x in h for h in header)]
    if missing:
        raise RuntimeError(f'RPP keyword CSV missing columns: {missing}')
    normalized = '\r\n'.join(body) + '\r\n'
    tmp = DOWNLOADS / f'keyword_report_extracted_{datetime.now():%Y%m%d_%H%M%S}.csv'
    tmp.write_bytes(normalized.encode('cp932', errors='replace'))
    return source_name, rows, tmp


async def _download_keyword_report_with_page(page, target: date) -> Path:
    import asyncio

    async def click_radio(radio_id: str, label_text: str) -> None:
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

    await page.goto('https://ad.rms.rakuten.co.jp/rpp/reports', timeout=60000)
    await page.wait_for_load_state('networkidle', timeout=60000)
    await asyncio.sleep(3)

    # レポート単位: キーワード。value依存だとRMS画面変更時に壊れるためID/ラベル優先。
    await click_radio('rdReportTypeKeyword', 'キーワード別')
    await asyncio.sleep(1)

    # 全期間 + 単日指定（前日）
    await click_radio('rdPeriodAll', '全期間で表示')
    await asyncio.sleep(1)

    ds = target.strftime('%Y-%m-%d')
    start_input = page.locator('input[placeholder="Select start"]').first
    end_input = page.locator('input[placeholder="Select end"]').first
    await start_input.click()
    await start_input.fill(ds)
    await end_input.click()
    await end_input.fill(ds)
    await page.locator('body').click(position={'x': 10, 'y': 10})
    await asyncio.sleep(1)

    await page.locator('#btnReportSearch, button:has-text("この条件で検索")').first.click()
    await page.wait_for_function('''() => {
      const btn = document.querySelector('#btnAllKeywordReport');
      return btn && !btn.disabled;
    }''', timeout=30000)

    btn = page.locator('#btnAllKeywordReport')
    await btn.click()
    await asyncio.sleep(10)

    await page.goto('https://ad.rms.rakuten.co.jp/rpp/download', timeout=60000)
    await page.wait_for_load_state('networkidle', timeout=60000)
    await asyncio.sleep(3)

    target_jp = f'{target.year}年{target.month:02d}月{target.day:02d}日'
    row_index = await page.evaluate('''targetJp => {
      const rows = [...document.querySelectorAll('tr')];
      return rows.findIndex(r => r.innerText.includes('パフォーマンスレポート')
        && r.innerText.includes('全キーワードレポートダウンロード')
        && r.innerText.includes('完了')
        && r.innerText.includes(targetJp));
    }''', target_jp)
    if row_index < 0:
        # 生成直後の反映が遅れることがあるので更新ボタンを数回試す。
        for _ in range(6):
            refresh = page.locator('#btnDownloadHistoryRefresh')
            if await refresh.count() > 0:
                await refresh.first.click()
            await asyncio.sleep(5)
            row_index = await page.evaluate('''targetJp => {
              const rows = [...document.querySelectorAll('tr')];
              return rows.findIndex(r => r.innerText.includes('パフォーマンスレポート')
                && r.innerText.includes('全キーワードレポートダウンロード')
                && r.innerText.includes('完了')
                && r.innerText.includes(targetJp));
            }''', target_jp)
            if row_index >= 0:
                break
    if row_index < 0:
        sample = await page.evaluate('''() => document.body.innerText.slice(0, 1800)''')
        raise RuntimeError(f'keyword report download history row not found for {target_jp}; sample={sample}')

    async with page.expect_download(timeout=60000) as dl_info:
        ok = await page.evaluate('''idx => {
          const row = [...document.querySelectorAll('tr')][idx];
          const el = [...row.querySelectorAll('a,button')].find(e => (e.innerText || e.value || '').includes('ダウンロード'));
          if (el) { el.click(); return true; }
          return false;
        }''', row_index)
        if not ok:
            raise RuntimeError('download button not found in matched keyword report row')
    download = await dl_info.value
    out = DOWNLOADS / f'rpp_keyword_{datetime.now():%Y%m%d_%H%M%S}_{download.suggested_filename}'
    await download.save_as(str(out))
    return out


async def _rms_login_lenient():
    from playwright.async_api import async_playwright
    import asyncio

    login_id = os.getenv('RMS_LOGIN_ID', '')
    login_pass = os.getenv('RMS_LOGIN_PASS', '')
    email = os.getenv('RAKUTEN_EMAIL', '')
    email_pass = os.getenv('RAKUTEN_EMAIL_PASS', '')
    if not all([login_id, login_pass, email, email_pass]):
        raise RuntimeError('RMS login credentials are missing')

    p = await async_playwright().start()
    browser = await p.chromium.launch(headless=True)
    context = await browser.new_context(accept_downloads=True, locale='ja-JP')
    page = await context.new_page()

    await page.goto(os.getenv('RMS_LOGIN_URL') or 'https://glogin.rms.rakuten.co.jp/?sp_id=1', wait_until='domcontentloaded', timeout=60000)
    await page.wait_for_timeout(2000)

    if await page.locator('input[name="login_id"]').count() > 0:
        await page.fill('input[name="login_id"]', login_id)
        await page.fill('input[name="passwd"]', login_pass)
        btn = page.locator('button:has-text("楽天会員ログイン"), button:has-text("楽天会員ログインへ"), input[value*="楽天会員ログイン"]')
        if await btn.count() > 0:
            await btn.first.click()
        await page.wait_for_timeout(3000)

    if await page.locator('#user_id').count() > 0:
        await page.fill('#user_id', email)
        await page.locator('#cta001').click()
        await page.wait_for_timeout(4000)

    if await page.locator('#password_current').count() > 0:
        await page.fill('#password_current', email_pass)
        await page.locator('#cta011').click()
        await page.wait_for_timeout(6000)

    for _ in range(4):
        next_btn = page.locator('a:has-text("次へ"), button:has-text("次へ"), input[value="次へ"]')
        if await next_btn.count() > 0:
            await next_btn.first.click()
            await page.wait_for_timeout(3000)
        else:
            break

    compliance = page.locator('a:has-text("遵守"), button:has-text("遵守"), input[value*="遵守"]')
    if await compliance.count() > 0:
        await compliance.first.click()
        await page.wait_for_timeout(5000)

    await page.goto('https://mainmenu.rms.rakuten.co.jp/?act=login&sp_id=1', wait_until='domcontentloaded', timeout=60000)
    await page.wait_for_timeout(3000)
    return p, browser, context, page


async def download_keyword_report(target: date) -> Path:
    p_inst = browser = None
    try:
        p_inst, browser, context, page = await _rms_login_lenient()
        return await _download_keyword_report_with_page(page, target)
    finally:
        if browser:
            await browser.close()
        if p_inst:
            await p_inst.stop()


def main() -> int:
    ap = argparse.ArgumentParser()
    default_date = os.getenv('RPP_REPORT_DATE') or (date.today() - timedelta(days=1)).isoformat()
    ap.add_argument('--date', default=default_date, help='target date YYYY-MM-DD; default yesterday or RPP_REPORT_DATE env')
    args = ap.parse_args()
    target = date.fromisoformat(args.date)

    load_env(PROJECT / '.env')
    load_env(RAKUTEN_MARKETING / '.env')

    before_mtime = OUT.stat().st_mtime if OUT.exists() else None
    downloaded = asyncio.run(download_keyword_report(target))
    source_name, rows, extracted = extract_csv(downloaded)

    backup = None
    if OUT.exists():
        backup = PROJECT / 'rpp_downloads' / f'rpp_keyword_reports_backup_{datetime.now():%Y%m%d_%H%M%S}.csv'
        shutil.copy2(OUT, backup)
    shutil.copy2(extracted, OUT)

    after_mtime = OUT.stat().st_mtime
    print(json.dumps({
        'ok': True,
        'target_date': target.isoformat(),
        'downloaded': str(downloaded),
        'source_csv': source_name,
        'output': str(OUT),
        'backup': str(backup) if backup else None,
        'rows_including_header': len(rows),
        'data_rows': max(0, len(rows) - 1),
        'mtime_changed': before_mtime != after_mtime,
        'header_sample': rows[0][:8] if rows else [],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
