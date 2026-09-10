#!/usr/bin/env python3
"""Refresh RPP settings CSVs from RMS.

Read-only browser automation:
- rpp_item_settings.csv: 登録済み商品全件ダウンロード
- rpp_keyword_settings.csv: 登録済みキーワード全件ダウンロード
- rpp_exclude_items.csv: 除外商品画面から全ページ収集（downloadイベントが不安定なためDOM収集）

Secrets are read from existing .env files and never printed.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import os
import re
import shutil
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Iterable

PROJECT = Path(__file__).resolve().parent
RAKUTEN_MARKETING = Path('/Users/nob/Projects/rakuten-marketing')
DOWNLOADS = PROJECT / 'rpp_downloads'
DOWNLOADS.mkdir(exist_ok=True)

ITEMS_OUT = PROJECT / 'rpp_item_settings.csv'
KEYWORDS_OUT = PROJECT / 'rpp_keyword_settings.csv'
EXCLUDE_OUT = PROJECT / 'rpp_exclude_items.csv'


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


def normalize_csv(download_path: Path, required: list[str], kind: str) -> tuple[str, list[list[str]], Path]:
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
        raise RuntimeError(f'{kind} CSV header not found')
    body = [line for line in lines[header_idx:] if line.strip()]
    rows = list(csv.reader(body))
    header = rows[0] if rows else []
    missing = [x for x in required if not any(x in h for h in header)]
    if missing:
        raise RuntimeError(f'{kind} CSV missing columns: {missing}; header={header}')
    tmp = DOWNLOADS / f'{kind}_extracted_{datetime.now():%Y%m%d_%H%M%S}.csv'
    tmp.write_bytes(('\r\n'.join(body) + '\r\n').encode('cp932', errors='replace'))
    return source_name, rows, tmp


def backup_and_replace(src: Path, out: Path, label: str) -> Path | None:
    backup = None
    if out.exists():
        backup = DOWNLOADS / f'{out.stem}_backup_{datetime.now():%Y%m%d_%H%M%S}{out.suffix}'
        shutil.copy2(out, backup)
    shutil.copy2(src, out)
    return backup


async def click_by_text(page, text: str) -> bool:
    return await page.evaluate('''label => {
      const els = [...document.querySelectorAll('a,button,li,span,div,input')];
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const target = els.find(el => visible(el) && ((el.innerText || el.value || '').trim() === label))
        || els.find(el => visible(el) && ((el.innerText || el.value || '').includes(label)));
      if (target) { target.click(); return true; }
      return false;
    }''', text)


async def download_settings_csv(page, menu_label: str, kind: str) -> Path:
    await page.goto('https://ad.rms.rakuten.co.jp/rpp/items', timeout=60000)
    await page.wait_for_load_state('networkidle', timeout=60000)
    await page.wait_for_timeout(3000)
    if '/rpp/items' not in page.url:
        sample = await page.evaluate('''() => document.body.innerText.slice(0, 1200)''')
        raise RuntimeError(f'RPP items page not reached: url={page.url}; sample={sample}')

    # 「全件ダウンロード」メニューの各項目は即downloadではなく、履歴に生成リクエストを積む。
    if await page.locator('#btnDownloadAllItemKeyword').count() > 0:
        await page.locator('#btnDownloadAllItemKeyword').first.click()
    else:
        ok = await click_by_text(page, '全件ダウンロード')
        if not ok:
            sample = await page.evaluate('''() => document.body.innerText.slice(0, 1500)''')
            raise RuntimeError(f'all-download menu not found; sample={sample}')
    await page.wait_for_timeout(1500)
    ok = await click_by_text(page, menu_label)
    if not ok:
        sample = await page.evaluate('''() => document.body.innerText.slice(0, 2200)''')
        raise RuntimeError(f'menu item not found: {menu_label}; sample={sample}')
    await page.wait_for_timeout(10000)

    await page.goto('https://ad.rms.rakuten.co.jp/rpp/download', timeout=60000)
    await page.wait_for_load_state('networkidle', timeout=60000)
    await page.wait_for_timeout(3000)

    row_index = -1
    for _ in range(12):
        row_index = await page.evaluate('''label => {
          const rows = [...document.querySelectorAll('tr')];
          // History is newest-first. Wait for the newest matching request rather
          // than silently selecting an older completed export below it.
          const idx = rows.findIndex(r => r.innerText.includes(label));
          if (idx < 0) return -1;
          return rows[idx].innerText.includes('完了') ? idx : -2;
        }''', menu_label)
        if row_index >= 0:
            break
        refresh = page.locator('#btnDownloadHistoryRefresh')
        if await refresh.count() > 0:
            await refresh.first.click()
        await page.wait_for_timeout(5000)
    if row_index == -2:
        raise RuntimeError(f'newest settings download did not complete for {menu_label}')
    if row_index < 0:
        # 履歴文言が短縮される場合に備え、商品/キーワードの広め条件でも探す。
        fallback_terms = ['商品全件', 'キーワード全件'] if 'キーワード' in menu_label else ['商品全件']
        row_index = await page.evaluate('''terms => {
          const rows = [...document.querySelectorAll('tr')];
          return rows.findIndex(r => terms.some(t => r.innerText.includes(t)) && r.innerText.includes('完了'));
        }''', fallback_terms)
    if row_index < 0:
        sample = await page.evaluate('''() => document.body.innerText.slice(0, 2000)''')
        raise RuntimeError(f'settings download history row not found for {menu_label}; sample={sample}')

    async with page.expect_download(timeout=60000) as dl_info:
        clicked = await page.evaluate('''idx => {
          const row = [...document.querySelectorAll('tr')][idx];
          const el = [...row.querySelectorAll('a,button')].find(e => (e.innerText || e.value || '').includes('ダウンロード'));
          if (el) { el.click(); return true; }
          return false;
        }''', row_index)
        if not clicked:
            raise RuntimeError('download button not found in matched settings history row')
    download = await dl_info.value
    out = DOWNLOADS / f'{kind}_{datetime.now():%Y%m%d_%H%M%S}_{download.suggested_filename}'
    await download.save_as(str(out))
    return out


def normalize_code(s: str) -> str:
    return re.sub(r'[^0-9A-Za-z_-]', '', s.strip())


async def collect_exclude_items(page) -> tuple[list[str], dict[str, object]]:
    await page.goto('https://ad.rms.rakuten.co.jp/rpp/exclude', timeout=60000)
    await page.wait_for_load_state('networkidle', timeout=60000)
    await page.wait_for_timeout(3000)
    if '/rpp/exclude' not in page.url:
        sample = await page.evaluate('''() => document.body.innerText.slice(0, 1200)''')
        raise RuntimeError(f'RPP exclude page not reached: url={page.url}; sample={sample}')

    body = await page.evaluate('''() => document.body.innerText''')
    m = re.search(r'登録済み除外商品[^0-9]*([0-9,]+)件', body)
    expected = int(m.group(1).replace(',', '')) if m else None

    codes: set[str] = set()
    pages_seen = 0
    for _ in range(200):
        pages_seen += 1
        page_codes = await page.evaluate('''() => {
          const out = [];
          const headerCells = [...document.querySelectorAll('th')].map((th, i) => ({i, text: th.innerText.trim()}));
          let codeIndex = headerCells.find(h => h.text.includes('商品管理番号'))?.i;
          for (const tr of document.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
            if (!cells.length) continue;
            let v = codeIndex != null && codeIndex < cells.length ? cells[codeIndex] : '';
            if (!v) {
              v = cells.find(c => /^[A-Za-z][0-9A-Za-z_-]{2,}$/.test(c)) || '';
            }
            if (v) out.push(v);
          }
          return out;
        }''')
        for c in page_codes:
            cc = normalize_code(str(c))
            if cc and not cc.lower().startswith('http'):
                codes.add(cc)

        next_clicked = await page.evaluate('''() => {
          const els = [...document.querySelectorAll('a,button')];
          const visible = el => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const candidates = els.filter(el => visible(el) && /次|>|›|NEXT/i.test((el.innerText || el.value || el.getAttribute('aria-label') || '').trim()));
          const target = candidates.find(el => !el.disabled && !String(el.className || '').includes('disabled') && el.getAttribute('aria-disabled') !== 'true');
          if (target) { target.click(); return true; }
          return false;
        }''')
        if not next_clicked:
            break
        await page.wait_for_timeout(1200)
    return sorted(codes, key=str.lower), {'expected_count': expected, 'pages_seen': pages_seen}


def write_exclude_csv(codes: Iterable[str]) -> Path:
    tmp = DOWNLOADS / f'exclude_items_extracted_{datetime.now():%Y%m%d_%H%M%S}.csv'
    with tmp.open('w', encoding='cp932', newline='') as f:
        w = csv.writer(f, lineterminator='\r\n')
        w.writerow(['コントロールカラム', '商品管理番号'])
        for code in codes:
            w.writerow(['', code])
    return tmp


def validate_exclude_collection(codes: list[str], meta: dict[str, object]) -> None:
    expected = meta.get('expected_count')
    if not isinstance(expected, int):
        raise RuntimeError('exclude item expected count was not found')
    if len(codes) != expected:
        raise RuntimeError(f'exclude item list incomplete: expected={expected}, collected={len(codes)}')


async def refresh(targets: set[str], exclude_output: Path = EXCLUDE_OUT) -> dict[str, object]:
    load_env(PROJECT / '.env')
    load_env(RAKUTEN_MARKETING / '.env')
    from scripts_refresh_rpp_keyword_report import _rms_login_lenient

    p_inst = browser = None
    result: dict[str, object] = {'ok': True, 'updated_at': datetime.now().isoformat(), 'targets': sorted(targets)}
    try:
        p_inst, browser, context, page = await _rms_login_lenient()
        if 'items' in targets:
            downloaded = await download_settings_csv(page, '登録済み商品全件ダウンロード', 'rpp_item_settings')
            source_name, rows, extracted = normalize_csv(downloaded, ['商品管理番号', '商品名', '商品CPC', '除外'], 'rpp_item_settings')
            backup = backup_and_replace(extracted, ITEMS_OUT, 'items')
            result['items'] = {'downloaded': str(downloaded), 'source_csv': source_name, 'output': str(ITEMS_OUT), 'backup': str(backup) if backup else None, 'rows': len(rows) - 1}
        if 'keywords' in targets:
            downloaded = await download_settings_csv(page, '手動登録済みキーワード全件ダウンロード', 'rpp_keyword_settings')
            source_name, rows, extracted = normalize_csv(downloaded, ['商品管理番号', '商品名', '商品CPC', 'キーワード'], 'rpp_keyword_settings')
            backup = backup_and_replace(extracted, KEYWORDS_OUT, 'keywords')
            result['keywords'] = {'downloaded': str(downloaded), 'source_csv': source_name, 'output': str(KEYWORDS_OUT), 'backup': str(backup) if backup else None, 'rows': len(rows) - 1}
        if 'exclude' in targets:
            codes, meta = await collect_exclude_items(page)
            validate_exclude_collection(codes, meta)
            extracted = write_exclude_csv(codes)
            backup = backup_and_replace(extracted, exclude_output, 'exclude')
            result['exclude'] = {'output': str(exclude_output), 'backup': str(backup) if backup else None, 'rows': len(codes), **meta}
        result['completed_at'] = datetime.now().isoformat()
        return result
    finally:
        if browser:
            await browser.close()
        if p_inst:
            await p_inst.stop()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--items-only', action='store_true')
    ap.add_argument('--keywords-only', action='store_true')
    ap.add_argument('--exclude-only', action='store_true')
    ap.add_argument('--exclude-output', type=Path, default=EXCLUDE_OUT)
    args = ap.parse_args()
    targets = set()
    if args.items_only:
        targets.add('items')
    if args.keywords_only:
        targets.add('keywords')
    if args.exclude_only:
        targets.add('exclude')
    if not targets:
        targets = {'items', 'keywords', 'exclude'}
    res = asyncio.run(refresh(targets, args.exclude_output))
    receipt = PROJECT / 'rpp_logs' / f'rpp_settings_refresh_{datetime.now():%Y%m%d_%H%M%S}.json'
    receipt.parent.mkdir(exist_ok=True)
    receipt.write_text(json.dumps(res, ensure_ascii=False, indent=2, default=str) + '\n', encoding='utf-8')
    print(json.dumps({**res, 'receipt': str(receipt)}, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
