# RPP product delivery scheduler

商品別の毎日停止時間帯と、1回限りのON/OFF予約をMac Studioから実行するコードです。

## Production paths

- Runtime data: `/Users/nob/Projects/rpp-8am-notify`
- Worker wrapper: `~/.hermes/scripts/rpp_product_delivery_scheduler_tick.sh`
- Web/API: `https://rakuten-mvp-web.onrender.com`
- Time zone: `Asia/Tokyo`

## Safety

- 実行前にPostgreSQL上の予約をclaimし、claim IDと15分leaseで取消・二重実行を防止する。
- RMS除外一覧は画面表示件数と収集件数が完全一致する場合だけ使用する。0件は期待値0の場合のみ正常。
- 1商品ずつ操作し、RMS送信直前と送信後を読み戻す。
- WALは `PREPARED → SUBMITTING → SUBMITTED → VERIFIED`。`PREPARED`失敗はclaimを解放して再試行し、送信結果不明は`UNCERTAIN`として再送せず警告する。
- post-submit readbackは最大3分pollingし、商品管理番号列の完全一致0/1件を必須とする。
- 時間帯occurrenceを永続キュー化し、時間内にOFFにできなかった対象は`MISSED`として通知する。
- orphan設定は新規実行から隔離する。orphan ONは`owned`かつ`reservationOff`一致時だけ安全復帰する。
- 管理中商品は15分ごとにRMS driftを確認する。
- 元から除外中の商品は時間帯終了時に解除しない。
- ONは商品の全RPP設定行へ目標が保存済みの場合だけ許可する。
- 旧01:30/06:00ジョブと併用しない。

## Verification

```bash
python3 -m unittest -v test_rpp_product_delivery_scheduler.py test_rpp_product_delivery_orphans.py test_rpp_product_night_pause.py
node --test test_rpp_apply_exclusion_upload.mjs
python3 -m py_compile rpp_product_delivery_scheduler.py rpp_product_night_pause.py scripts_refresh_rpp_settings_csvs.py
bash -n rpp_product_delivery_scheduler_tick.sh
node --check ../rpp_apply_exclusion_upload.mjs
```

## Cutover order

1. Web PRをRenderへ反映し、machine GETで `schedules`、`reservations`、`releaseAllowedItemCodes` を読み戻す。
2. 旧ジョブ `5cbe755c528c`、`91b07d3d1b0d`、`2634bd47dcba` を停止する。
3. 新ワーカーを1回実行し、RMS変更0件・state移行・WALなしを確認する。
4. 新しい毎分Hermes cronを登録する。
5. cronの実行状態、次回時刻、API、stateを読み戻す。
