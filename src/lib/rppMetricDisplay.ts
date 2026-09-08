export function formatRppYen(value: number | null | undefined) {
  return value == null ? "未取得" : `${Math.round(value).toLocaleString("ja-JP")}円`;
}

export function formatRppClicks(value: number | null | undefined) {
  return value == null ? "未取得" : `${value.toLocaleString("ja-JP")} click`;
}