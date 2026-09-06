export type RppExclusionChangeInput = {
  itemCode: string;
  currentExcluded: boolean;
  originalExcluded?: boolean;
};

export function parseRppExclusionChanges(value: unknown): RppExclusionChangeInput[] {
  if (!Array.isArray(value)) throw new Error("changesは配列で指定してください");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`changes[${index}]はオブジェクトで指定してください`);
    const row = entry as Record<string, unknown>;
    if (typeof row.itemCode !== "string" || !row.itemCode.trim()) throw new Error(`changes[${index}].itemCodeは必須です`);
    if (typeof row.currentExcluded !== "boolean") throw new Error(`changes[${index}].currentExcludedはbooleanで指定してください`);
    if (row.originalExcluded !== undefined && typeof row.originalExcluded !== "boolean") {
      throw new Error(`changes[${index}].originalExcludedはbooleanで指定してください`);
    }
    return {
      itemCode: row.itemCode.trim(),
      currentExcluded: row.currentExcluded,
      ...(row.originalExcluded === undefined ? {} : { originalExcluded: row.originalExcluded }),
    };
  });
}

export function requireSingleRppExclusionChange(changes: RppExclusionChangeInput[]) {
  if (changes.length !== 1) {
    throw new Error("RMS除外反映は部分成功防止のため1ジョブ1商品で実行してください");
  }
  return changes[0];
}

export function assertRppExclusionQueueAvailable(
  activeJobs: Array<{ changes: Array<{ itemCode: string }>; createdByEmail?: string | null; createdByName?: string | null }>,
  changes: Array<{ itemCode: string }>,
  actorEmail: string,
) {
  const actor = actorEmail.trim().toLowerCase();
  const requested = new Set(changes.map((row) => row.itemCode.trim().toLowerCase()));
  for (const job of activeJobs) {
    const duplicate = job.changes.find((row) => requested.has(row.itemCode.trim().toLowerCase()));
    if (duplicate) throw new Error(`${duplicate.itemCode}: RMS反映ジョブがすでに登録されています`);
    if ((job.createdByEmail || "").trim().toLowerCase() !== actor) {
      throw new Error(`${job.createdByName || "他の担当者"}がRMS反映処理中です`);
    }
  }
}
