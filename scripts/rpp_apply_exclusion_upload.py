#!/usr/bin/env python3
"""RPP exclusion CSV upload helper for RMS.

Dry-run by default. With --execute it logs into RMS, selects the CSV on the
RPP exclusion bulk-upload screen, and with --final-submit clicks upload.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(errors='replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def parse_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        raise RuntimeError(f'CSV not found: {path}')
    raw = path.read_bytes()
    for enc in ('utf-8-sig', 'cp932', 'shift_jis', 'utf-8'):
        try:
            text = raw.decode(enc)
            break
        except Exception:
            continue
    else:
        text = raw.decode('utf-8', 'replace')
    rows = list(csv.DictReader([line for line in text.splitlines() if line.strip()]))
    out = []
    for row in rows:
        code = (row.get('商品管理番号') or '').strip()
        control = (row.get('コントロールカラム') or '').strip()
        if code:
            out.append({'control': control, 'itemCode': code})
    return out


def emit(obj: dict[str, object]) -> None:
    print(json.dumps(obj, ensure_ascii=False, indent=2))


async def login_and_upload(csv_path: Path, final_submit: bool) -> dict[str, object]:
    try:
        from playwright.async_api import async_playwright
    except Exception as e:
        raise RuntimeError(f'playwright is not installed on server: {e}')

    login_id = os.environ.get('RMS_LOGIN_ID', '')
    login_pass = os.environ.get('RMS_LOGIN_PASS', '')
    email = os.environ.get('RAKUTEN_EMAIL', '')
    email_pass = os.environ.get('RAKUTEN_EMAIL_PASS', '')
    missing = [k for k, v in {
        'RMS_LOGIN_ID': login_id,
        'RMS_LOGIN_PASS': login_pass,
        'RAKUTEN_EMAIL': email,
        'RAKUTEN_EMAIL_PASS': email_pass,
    }.items() if not v]
    if missing:
        raise RuntimeError(f'RMS credentials missing on server: {", ".join(missing)}')

    p = await async_playwright().start()
    browser = await p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = await browser.new_page()
    try:
        login_url = os.environ.get('RMS_LOGIN_URL') or 'https://glogin.rms.rakuten.co.jp/'
        await page.goto(login_url, wait_until='networkidle', timeout=60000)
        # Leniently fill visible login fields when they exist. RMS login flow changes often.
        for selector, value in [
            ('input[name="login_id"]', login_id),
            ('input[name="passwd"]', login_pass),
            ('input[name="u"]', email),
            ('input[name="p"]', email_pass),
            ('input[type="email"]', email),
            ('input[type="password"]', email_pass),
        ]:
            loc = page.locator(selector).first
            try:
                if await loc.count() and await loc.is_visible(timeout=1000):
                    await loc.fill(value)
            except Exception:
                pass
        for text in ['楽天会員ログイン', 'ログイン', '次へ']:
            try:
                btn = page.get_by_text(text, exact=False).first
                if await btn.count() and await btn.is_visible(timeout=1000):
                    await btn.click(timeout=3000)
                    await page.wait_for_timeout(2000)
            except Exception:
                pass

        await page.goto('https://ad.rms.rakuten.co.jp/rpp/exclude', wait_until='networkidle', timeout=60000)
        await page.wait_for_timeout(2000)
        body = await page.evaluate('() => document.body.innerText.slice(0, 2000)')
        if 'ログイン' in body and '除外' not in body:
            raise RuntimeError('RMS login not completed; exclusion upload aborted')

        clicked = False
        for text in ['一括アップロード', 'アップロード']:
            try:
                loc = page.get_by_text(text, exact=False).first
                if await loc.count() and await loc.is_visible(timeout=2000):
                    await loc.click(timeout=5000)
                    clicked = True
                    await page.wait_for_timeout(1500)
                    break
            except Exception:
                pass
        # Some RMS screens show the file input without needing a tab/button.
        file_input = page.locator('input[type="file"]').first
        if await file_input.count() == 0:
            raise RuntimeError('RMS exclusion upload file input not found')
        await file_input.set_input_files(str(csv_path))
        await page.wait_for_timeout(1000)

        info = await page.evaluate('''() => ({
          url: location.href,
          title: document.title,
          fileValue: document.querySelector('input[type="file"]')?.value || '',
          buttons: [...document.querySelectorAll('button,input[type="button"],input[type="submit"],a')]
            .map(e => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim())
            .filter(Boolean)
            .slice(0, 50)
        })''')
        if not final_submit:
            return {'fileSelected': True, 'finalSubmitSkipped': True, 'openedBulkUpload': clicked, **info}

        upload_clicked = False
        for selector in ['#btnUploadFile', 'input[type="submit"]', 'button']:
            candidates = page.locator(selector)
            count = await candidates.count()
            for i in range(min(count, 20)):
                el = candidates.nth(i)
                try:
                    label = ((await el.inner_text(timeout=1000)) or await el.get_attribute('value') or '').strip()
                    if any(s in label for s in ['アップロード', '登録', '反映', '実行']):
                        await el.click(timeout=5000)
                        upload_clicked = True
                        break
                except Exception:
                    pass
            if upload_clicked:
                break
        if not upload_clicked:
            raise RuntimeError('RMS final upload button not found')
        await page.wait_for_timeout(5000)
        after = await page.evaluate('() => document.body.innerText.slice(0, 2000)')
        return {'fileSelected': True, 'finalSubmitClicked': True, 'pageTextSample': after, **info}
    finally:
        await browser.close()
        await p.stop()


async def main_async() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', required=True)
    ap.add_argument('--execute', action='store_true')
    ap.add_argument('--final-submit', action='store_true')
    ap.add_argument('--confirm', default='')
    args = ap.parse_args()

    for env_path in [Path.cwd() / '.env', Path('/Users/nob/Projects/rpp-8am-notify/.env')]:
        load_env(env_path)
    csv_path = Path(args.csv).expanduser().resolve()
    rows = parse_csv(csv_path)
    base = {
        'ok': True,
        'productionChange': False,
        'uploadCsv': str(csv_path),
        'rowCount': len(rows),
        'rows': rows,
    }
    if not rows:
        emit({**base, 'skipped': True, 'reason': 'rows are 0'})
        return 0
    if not args.execute:
        emit({**base, 'dryRun': True, 'reason': 'missing --execute'})
        return 0
    if os.environ.get('RPP_ENABLE_RMS_EXCLUSION_UPLOAD') != '1':
        raise RuntimeError('RPP_ENABLE_RMS_EXCLUSION_UPLOAD=1 is required')
    if args.final_submit and args.confirm != 'RMS_EXCLUSION_UPLOAD':
        raise RuntimeError('--confirm=RMS_EXCLUSION_UPLOAD is required for final submit')
    applied = await login_and_upload(csv_path, final_submit=args.final_submit)
    emit({**base, 'productionChange': bool(args.final_submit), 'applied': applied})
    return 0


def main() -> int:
    try:
        return asyncio.run(main_async())
    except Exception as e:
        print(f'❌ エラー: {e}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
