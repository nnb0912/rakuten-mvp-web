import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getRppExperimentStatus, jstDateString } from "./rppExperimentStatus.ts";

test("JSTの暦日で実験終了日と期限切れを判定する", () => {
  assert.equal(jstDateString(new Date("2026-08-31T14:59:59.999Z")), "2026-08-31");
  assert.equal(jstDateString(new Date("2026-08-31T15:00:00.000Z")), "2026-09-01");

  assert.equal(getRppExperimentStatus({ endDate: "2026-08-31", finishedAt: "" }, new Date("2026-08-31T14:59:59.999Z")), "ACTIVE");
  assert.equal(getRppExperimentStatus({ endDate: "2026-08-31", finishedAt: "" }, new Date("2026-08-31T15:00:00.000Z")), "EXPIRED");
  assert.equal(getRppExperimentStatus({ endDate: "2026-08-30", finishedAt: "2026-08-31T00:00:00.000Z" }, new Date("2026-09-01T00:00:00.000Z")), "COMPLETED");
});

test("JSONフォールバックで複数履歴を保存し、個別に終了できる", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "rpp-experiments-"));
  process.env.RPP_PROJECT_DIR = projectDir;
  const { finishRppExperiment, readRppExperimentHistory, startRppExperiment } = await import("./rppExperiments.ts");

  try {
    const first = await startRppExperiment({
      targetId: "item-1__keyword",
      itemCode: "item-1",
      keyword: "keyword",
      optimizationMode: "POSITION",
      endDate: "2026-09-07",
      startedAt: "2026-08-31T01:00:00.000Z",
      baseline: { capturedAt: "2026-08-31T00:00:00.000Z", ctr: 1.2, cvr: 2.3, roas: 450, pcPosition: "10", spPosition: "8" },
      settings: { fixedCpc: null, maxCpc: 100, pcPositionGoal: "TOP_5", spPositionGoal: "TOP_7", ctrGoal: 5, cvrGoal: 4, roasFloor: 500 },
    });
    const second = await startRppExperiment({
      targetId: "item-1__keyword",
      itemCode: "item-1",
      keyword: "keyword",
      optimizationMode: "FIXED",
      endDate: "2026-09-14",
      startedAt: "2026-09-08T01:00:00.000Z",
      baseline: { capturedAt: "2026-09-08T00:00:00.000Z", ctr: 1.5, cvr: 2.5, roas: 500, pcPosition: "7", spPosition: "6" },
      settings: { fixedCpc: 80, maxCpc: null, pcPositionGoal: "TOP_5", spPositionGoal: "TOP_5", ctrGoal: 5, cvrGoal: 4, roasFloor: 500 },
    });

    assert.notEqual(first.id, second.id);
    const completed = await finishRppExperiment(first.id, {
      finishedAt: "2026-09-07T02:00:00.000Z",
      result: { capturedAt: "2026-09-07T02:00:00.000Z", ctr: 1.8, cvr: 2.7, roas: 610, pcPosition: "5", spPosition: "7" },
      note: "順位とROASが改善",
    });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.result?.roas, 610);

    const history = await readRppExperimentHistory({ targetId: "item-1__keyword", now: new Date("2026-09-08T03:00:00.000Z") });
    assert.deepEqual(history.map((row) => row.id), [second.id, first.id]);
    assert.deepEqual(history.map((row) => row.status), ["ACTIVE", "COMPLETED"]);

    const persisted = JSON.parse(await readFile(path.join(projectDir, "rpp_targets", "rpp_experiment_history.json"), "utf8"));
    assert.equal(persisted.experiments.length, 2);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    delete process.env.RPP_PROJECT_DIR;
  }
});

test("終了済み実験は再終了できない", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "rpp-experiments-finish-"));
  process.env.RPP_PROJECT_DIR = projectDir;
  const { finishRppExperiment, startRppExperiment } = await import("./rppExperiments.ts");
  try {
    const experiment = await startRppExperiment({
      targetId: "item-2__kw",
      itemCode: "item-2",
      keyword: "kw",
      optimizationMode: "FIXED",
      endDate: "2026-09-01",
      baseline: { capturedAt: "2026-08-31T00:00:00.000Z", ctr: null, cvr: null, roas: null, pcPosition: "", spPosition: "" },
      settings: { fixedCpc: 50, maxCpc: null, pcPositionGoal: "FIRST_PAGE", spPositionGoal: "FIRST_PAGE", ctrGoal: 5, cvrGoal: 5, roasFloor: 500 },
    });
    await finishRppExperiment(experiment.id, { result: { capturedAt: "2026-09-01T00:00:00.000Z", ctr: 1, cvr: 2, roas: 300, pcPosition: "", spPosition: "" } });
    await assert.rejects(() => finishRppExperiment(experiment.id, { result: { capturedAt: "2026-09-01T01:00:00.000Z", ctr: 2, cvr: 3, roas: 400, pcPosition: "", spPosition: "" } }), /すでに終了/);
  } finally {
    await rm(projectDir, { recursive: true, force: true });
    delete process.env.RPP_PROJECT_DIR;
  }
});
