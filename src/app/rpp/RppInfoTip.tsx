"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const HELP = {
  "選択": "CPC提案CSVに含める行を選びます。選択しただけではRMSへ反映されません。",
  "商品 / キーワード": "商品管理番号、RPP設定キーワード、商品名を表示します。商品CPCは商品単位、キーワードCPCはキーワード単位の設定です。",
  "商品 / KW": "実験対象の商品管理番号とRPP設定キーワードです。",
  "商品/KW": "対象の商品管理番号とRPP設定キーワードです。",
  "商品": "対象の商品管理番号と商品名です。",
  "KW": "RPPに設定している検索キーワードです。",
  "担当 / G": "運用担当者と広告グループです。担当・グループ絞り込みに使います。",
  "判定": "実績と安全ルールから算出したCPCの上げ・下げ・保留判定です。",
  "運用候補": "現在の実績から推奨される確認・解除などの次アクションです。",
  "実績": "対象期間の広告費、クリック、売上などの実績です。データ未同期時は推測せず未取得として扱います。",
  "CPC": "1クリックあたりの入札単価です。左が現在値、右が提案値です。",
  "CPC/実績": "現在CPCと、判断に使った広告実績です。",
  "CPC/順位": "現在のCPCとPC・スマートフォンでのRPP広告掲載順位です。",
  "ROAS": "広告費に対する売上の割合です。売上÷広告費×100で、値が高いほど広告効率が高い状態です。",
  "検索順位": "検索結果のRPP広告枠におけるPC・スマートフォン別の掲載位置です。",
  "順位": "検索結果のRPP広告枠における掲載位置です。",
  "運用モード": "ROAS逆算・順位目標・CPC固定のどのルールで提案を作るかを示します。",
  "モード・期間": "実験で固定している運用モードと開始・終了期間です。",
  "保護": "ブロック・ホワイト・変更不可・注力など、自動提案を制御する安全区分です。",
  "配信": "商品広告の現在の除外状態です。除外操作は商品CPC行だけで行います。",
  "操作": "設定、CSV出力、除外・再開など、この行に対して実行できる操作です。",
  "ブロック理由": "安全ルールにより自動提案・承認の対象外になった理由です。",
  "対象外理由": "自動調整の対象から外れた理由です。",
  "承認": "提案を承認・却下・保留にします。承認だけではRMSへ反映されません。",
  "開始値": "実験開始時点のCPC、順位、CTR、CVR、ROASです。",
  "終了値": "実験終了時点で取得した同じ指標です。未終了の場合は未取得です。",
  "状態": "処理・計画・実験などの現在状態です。",
  "原因": "保留になった主な判定理由です。",
  "次アクション": "保留理由を解消するために次に確認・実施する作業です。",
  "日時": "イベントまたは処理を記録した日本時間です。",
  "イベント": "監査ログに記録された操作の種類です。",
  "対象": "操作・イベントの対象商品や設定です。",
  "実行者": "操作を実行したユーザーまたは機械処理です。",
  "結果": "RMS反映処理の完了・失敗などの結果です。",
  "読戻し": "反映後にRMSから再取得し、期待値と一致したかの確認結果です。",
  "件数": "処理対象になったデータ行数です。",
  "CSV/理由": "使用したCSV、または処理できなかった理由です。",
  "種別": "CSVや実行履歴の種類です。",
  "ファイル": "生成・使用したファイル名です。",
  "サイズ": "ファイル容量です。",
  "日": "当月の日付です。",
  "配分": "月予算のうち、その日に割り当てる比率です。",
  "日予算": "月予算と配分比率から計算した、その日の計画予算です。",
  "差額": "日予算に対する実績広告費の差です。プラスは計画超過を表します。",
  "累計計画": "月初からその日までの計画予算の累計です。",
  "指標": "期間Aと期間Bで比較する広告実績の項目です。",
  "A": "選択した対象月の実績です。",
  "B": "前月比では前月、前年同月比では前年同月の実績です。",
  "増減": "期間Bを基準にした期間Aの増減率です。比較元がない場合は比較不可です。",
  "月予算": "当月のRPP広告費上限として計画に使う金額です。RMS予算は自動変更しません。",
  "7日広告費": "商品別7日レポートから集計した直近の広告費です。",
  "日平均": "取得済み期間の広告費を日数で割った平均です。",
  "月末着地予測": "現在の日平均が続いた場合の月末広告費予測です。",
  "予算消化予測": "月末着地予測が月予算の何％になるかを示します。",
  "実績ROAS": "対象実績の売上÷広告費×100です。",
  "上げ候補": "現在CPCを上げる提案が作られている件数です。",
  "下げ候補": "現在CPCを下げる提案が作られている件数です。",
  "保留": "安全条件や実績不足により、人の確認待ちになっている件数です。",
  "対象外": "広告枠なし・実績なしなど、自動調整対象外の件数です。",
  "RPP設定中": "現在読み込まれている商品CPC・キーワードCPC設定の総件数です。",
  "データ状態": "候補生成に必要な実績・順位データが最新かどうかを示します。",
  "候補": "現在値と異なるCPC提案がある件数です。",
  "予測広告費": "選択中の提案CPCを適用した場合の推定広告費です。RMSへの反映値ではありません。",
  "削減見込み": "現状広告費と予測広告費の差です。プラスは削減見込みを表します。",
  "当月予算": "当月の日別配分・着地予測に使う計画予算です。RMSには反映されません。",
  "翌月予算": "翌月用に保存する計画予算です。RMSには反映されません。",
  "警告ライン": "予算消化予測がこの割合以上になったとき警告表示します。",
  "目標ROAS": "予算管理や提案判断で目安にする広告費対売上率です。",
  "日別配分": "月予算を均等、または手動比率で各日に割り当てます。",
  "最低CPC": "自動提案で下回らないCPCの下限です。",
  "商品CPC上限": "商品CPCの自動提案で超えない上限です。",
  "KW CPC上限": "キーワードCPCの自動提案で超えない上限です。",
  "1日最大上げ": "1回の候補生成で現在CPCから上げられる最大金額です。",
  "1日最大下げ": "1回の候補生成で現在CPCから下げられる最大金額です。",
  "ROAS最低": "CPCを上げる判断などに使う最低ROASです。",
  "比較": "前月または前年同月のどちらと比較するかを選びます。",
  "対象月": "期間比較の基準となる月です。",
  "売上窓": "広告クリック後、売上を広告成果として計上する期間です。12時間と720時間を混在させません。",
  "商品管理番号": "楽天RMSで商品を識別する管理番号です。",
  "RPP設定KW": "RPPへ実際に設定するキーワードです。検索調査キーワードとは別に管理します。",
  "検索調査キーワード": "自然検索や広告掲載位置を調査するキーワードです。RPPへ実際に設定するキーワードとは別に管理します。",
  "担当": "この商品・キーワードの運用担当者です。",
  "広告グループ": "予算・目標・一時ROASなどをまとめて管理するグループです。",
  "保護区分": "自動提案や除外判断を制御する安全区分です。",
  "保護理由": "保護区分を設定した業務上の理由です。",
  "運用方針": "攻め・維持・テスト・停止候補の運用判断です。",
  "最適化モード": "通常のROAS逆算、掲載位置を狙う順位目標、効果検証用のCPC固定から選びます。",
  "固定CPC": "CPC固定モードで維持する入札単価です。",
  "CPC上限": "この対象で提案できるCPCの個別上限です。",
  "実験終了日": "テスト運用を終了し、結果確認へ移る日です。",
  "CTR目標": "広告表示回数に対するクリック率の目標です。",
  "CVR目標": "広告クリック数に対する購入率の目標です。",
  "PC検索位置目標": "PC検索結果で目標とするRPP広告掲載位置です。",
  "SP検索位置目標": "スマートフォン検索結果で目標とするRPP広告掲載位置です。",
  "メモ": "判断根拠や運用上の注意事項を残す欄です。",
  "検索": "商品管理番号・商品名・キーワード・担当者で表示行を絞り込みます。",
  "モード": "表示する運用モードを絞り込みます。",
  "自動調整候補を有効化": "保存後の候補再生成で自動調整ルールを使う全体スイッチです。RMSへは自動反映しません。",
  "商品CPCも候補化": "商品単位のCPCを自動調整候補へ含めます。",
  "キーワードCPCを候補化": "キーワード単位のCPCを自動調整候補へ含めます。",
  "上げは検索位置が悪い時だけ": "CPC引き上げ候補を、目標検索位置に届いていない対象だけに制限します。",
  "変更不可リストは除外": "変更不可に指定した対象を自動調整候補から外します。",
  "RMS除外中商品は除外": "現在RMSで広告除外中の商品を自動調整候補から外します。",
  "CSVプレビュー": "広告グループ割当CSVを保存前に検証します。不明商品や競合がある場合は適用しません。",
  "開始": "一時ROAS設定を有効にする開始日時です。",
  "終了": "一時ROAS設定を終了し、基準値へ戻す日時です。",
} as const;

export type RppHelpLabel = keyof typeof HELP;

export function RppInfoTip({ label }: { label: RppHelpLabel }) {
  const description = HELP[label];
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; placement: "above" | "below" } | null>(null);

  function updatePosition() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportMargin = 12;
    const tooltipWidth = Math.min(320, window.innerWidth - viewportMargin * 2);
    const centeredLeft = rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(centeredLeft, viewportMargin + tooltipWidth / 2),
      window.innerWidth - viewportMargin - tooltipWidth / 2,
    );
    const estimatedHeight = 104;
    const placement = rect.bottom + estimatedHeight > window.innerHeight && rect.top > estimatedHeight ? "above" : "below";
    const top = placement === "above" ? rect.top - 8 : rect.bottom + 8;
    setPosition({ left, top, placement });
  }

  function show() {
    updatePosition();
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePosition();
    const closeOutside = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);

  const tooltipStyle = position ? ({
    left: position.left,
    top: position.top,
    "--rpp-tooltip-shift": position.placement === "above" ? "-100%" : "0%",
  } as CSSProperties) : undefined;

  return (
    <span className="rpp-help-label">
      <span>{label}</span>
      <span
        ref={triggerRef}
        className="rpp-info-tip"
        tabIndex={0}
        aria-label={`${label}の説明: ${description}`}
        aria-describedby={open ? tooltipId : undefined}
        title={description}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={show}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
      >
        <span aria-hidden="true">i</span>
      </span>
      {open && position ? createPortal(
        <span id={tooltipId} className="rpp-info-popover" role="tooltip" style={tooltipStyle}>{description}</span>,
        document.body,
      ) : null}
    </span>
  );
}
