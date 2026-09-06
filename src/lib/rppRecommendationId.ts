export type RppRecommendationIdentity = {
  date: string;
  itemCode: string;
  keyword: string;
  source: string;
  action: string;
  direction: string;
  currentCpc: number;
  meyasuCpc: number;
  proposedCpc: number | null;
  reasons: string[];
  blocks: string[];
  uploadReady: boolean;
};

export function recommendationId(row: RppRecommendationIdentity) {
  return ["v2", row.date, row.itemCode, row.keyword, row.source, row.action, row.direction, row.currentCpc, row.meyasuCpc, row.proposedCpc, JSON.stringify(row.reasons), JSON.stringify(row.blocks), row.uploadReady]
    .map((part) => encodeURIComponent(String(part)))
    .join("__");
}
