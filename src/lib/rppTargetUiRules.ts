export type RppCpcSource = "商品CPC" | "キーワードCPC";

export function canOperateProductExclusion(source: RppCpcSource) {
  return source === "商品CPC";
}

export function deliveryLabel(source: RppCpcSource, productExcluded: boolean) {
  if (!productExcluded) return "配信中";
  return source === "商品CPC" ? "除外ON" : "商品側除外";
}
