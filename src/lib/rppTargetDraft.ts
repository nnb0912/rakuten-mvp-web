function normalize(value: string) {
  return String(value || "").trim();
}

export function rppTargetDraftKey(itemCode: string, keyword: string) {
  return `rpp-target-draft:v1:${normalize(itemCode).toLowerCase()}:${normalize(keyword)}`;
}

export function parseRppTargetDraft<T extends { itemCode: string; keyword: string }>(raw: string | null, itemCode: string, keyword: string): T | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const row = value as { itemCode?: unknown; keyword?: unknown };
    if (typeof row.itemCode !== "string" || typeof row.keyword !== "string") return null;
    if (normalize(row.itemCode).toLowerCase() !== normalize(itemCode).toLowerCase()) return null;
    if (normalize(row.keyword) !== normalize(keyword)) return null;
    return value as T;
  } catch { return null; }
}
