export type RppExperimentStatus = "ACTIVE" | "EXPIRED" | "COMPLETED";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function jstDateString(now: Date = new Date()) {
  if (Number.isNaN(now.getTime())) throw new Error("有効な日時を指定してください");
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function getRppExperimentStatus(
  experiment: { endDate: string; finishedAt?: string | null },
  now: Date = new Date(),
): RppExperimentStatus {
  if (experiment.finishedAt) return "COMPLETED";
  return experiment.endDate < jstDateString(now) ? "EXPIRED" : "ACTIVE";
}
