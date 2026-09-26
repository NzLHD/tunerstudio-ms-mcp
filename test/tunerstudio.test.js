import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compareTunes, getTuneItem, inspectDataLog, inspectProject, inspectTune, listProjects, listTuneItems, stageTuneChanges } from "../src/tunerstudio.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tunerstudio-mcp-"));
  const projectsDir = path.join(root, "projects");
  const projectDir = path.join(projectsDir, "demo");
  await fs.mkdir(path.join(projectDir, "projectCfg"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "DataLogs"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "projectCfg", "project.properties"), "projectName=Demo Car\necuConfigName=MS3\n");
  await fs.writeFile(path.join(projectDir, "projectCfg", "mainController.ini"), "[MegaTune]\n");
  await fs.writeFile(path.join(projectDir, "CurrentTune.msq"), '<?xml version="1.0" encoding="ISO-8859-1"?><msq><bibliography tuneComment="temperature \xB0F"/><versionInfo signature="MS3"/><page number="0"><constant name="nCylinders">"4"</constant><constant digits="0" name="revLimit" units="RPM">7000</constant><constant cols="2" digits="1" name="veTable" rows="2" units="%">\n  1.0 2.0\n  3.0 4.0\n</constant></page></msq>', "latin1");
  await fs.writeFile(path.join(projectDir, "DataLogs", "run.msl"), "# metadata\nTime,RPM,AFR\n0,900,14.7\n1,1200,13.9\n");
  return { root, env: { TUNERSTUDIO_PROJECTS_DIR: projectsDir, TUNERSTUDIO_HOME: path.join(root, "app") } };
}

test("lists and inspects projects", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projects = await listProjects(env);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, "Demo Car");
  const project = await inspectProject("demo", env);
  assert.deepEqual(project.counts, { tunes: 1, logs: 1, iniFiles: 1 });
});

test("inspects tune and log summaries", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tune = await inspectTune("demo", "CurrentTune.msq", env);
  assert.equal(tune.validMsqRoot, true);
  assert.deepEqual(tune.sampleConstants, ["nCylinders", "revLimit", "veTable"]);
  const log = await inspectDataLog("demo", "DataLogs/run.msl", env);
  assert.equal(log.sampledRows, 2);
  assert.equal(log.numericFields.RPM.max, 1200);
  assert.equal(log.numericFields.AFR.mean, 14.3);
});

test("reads settings and tables and stages immutable review tunes", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const listed = await listTuneItems("demo", "CurrentTune.msq", { kind: "all", limit: 20 }, env);
  assert.equal(listed.matchedItems, 3);
  assert.equal(listed.items.find((item) => item.name === "veTable").kind, "table");

  const table = await getTuneItem("demo", "CurrentTune.msq", "veTable", 0, env);
  assert.deepEqual(table.item.values, [[1, 2], [3, 4]]);

  const staged = await stageTuneChanges("demo", "CurrentTune.msq", "review-001.msq", [
    { kind: "setting", name: "nCylinders", value: "6" },
    { kind: "setting", name: "revLimit", value: 7200 },
    { kind: "tableCells", name: "veTable", cells: [{ row: 1, column: 0, value: 9.5 }] },
  ], listed.sha256, env);
  assert.equal(staged.outputRelativePath, path.join("McpReview", "review-001.msq"));
  assert.equal(staged.changes.length, 3);
  const stagedBytes = await fs.readFile(path.join(root, "projects", "demo", staged.outputRelativePath));
  assert.equal(stagedBytes.includes(0xB0), true);

  const originalSetting = await getTuneItem("demo", "CurrentTune.msq", "nCylinders", 0, env);
  const reviewSetting = await getTuneItem("demo", staged.outputRelativePath, "nCylinders", 0, env);
  const reviewTable = await getTuneItem("demo", staged.outputRelativePath, "veTable", 0, env);
  assert.equal(originalSetting.item.value, "4");
  assert.equal(reviewSetting.item.value, "6");
  assert.deepEqual(reviewTable.item.values, [[1, 2], [9.5, 4]]);

  const comparison = await compareTunes("demo", "CurrentTune.msq", staged.outputRelativePath, 20, env);
  assert.equal(comparison.totalChangedItems, 3);
  assert.equal(comparison.totalChangedValues, 3);
  assert.equal(comparison.truncated, false);

  const manifest = JSON.parse(await fs.readFile(path.join(root, "projects", "demo", `${staged.outputRelativePath}.mcp-review.json`), "utf8"));
  assert.equal(manifest.reviewRequired, true);
  assert.equal(manifest.outputSha256, staged.outputSha256);

  const replaced = await stageTuneChanges("demo", staged.outputRelativePath, "review-002.msq", [
    { kind: "replaceTable", name: "veTable", values: [[5.1, 6.2], [7.3, 8.4]] },
  ], staged.outputSha256, env);
  const replacedTable = await getTuneItem("demo", replaced.outputRelativePath, "veTable", 0, env);
  assert.deepEqual(replacedTable.item.values, [[5.1, 6.2], [7.3, 8.4]]);

  await assert.rejects(
    () => stageTuneChanges("demo", "CurrentTune.msq", "review-001.msq", [{ kind: "setting", name: "revLimit", value: 7300 }], listed.sha256, env),
    /already exists/,
  );
});

test("refuses unsafe or stale tune revisions", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await listTuneItems("demo", "CurrentTune.msq", {}, env);
  const change = [{ kind: "setting", name: "revLimit", value: 7200 }];
  await assert.rejects(() => stageTuneChanges("demo", "CurrentTune.msq", "CurrentTune.msq", change, source.sha256, env), /reserved/);
  await assert.rejects(() => stageTuneChanges("demo", "CurrentTune.msq", "review.msq", change, "0".repeat(64), env), /hash does not match/);
  await assert.rejects(() => stageTuneChanges("demo", "CurrentTune.msq", "review.msq", [{ kind: "tableCells", name: "veTable", cells: [{ row: 4, column: 0, value: 1 }] }], source.sha256, env), /outside/);
  await assert.rejects(() => stageTuneChanges("demo", "CurrentTune.msq", "review.msq", [{ kind: "replaceTable", name: "veTable", values: [[1, 2, 3]] }], source.sha256, env), /exactly 2 rows by 2 columns/);
  await assert.rejects(() => stageTuneChanges("demo", "CurrentTune.msq", "review.msq", change, undefined, env), /required/);
});

test("rejects tune and review symlinks that escape the project", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "projects", "demo");
  const outsideTune = path.join(root, "outside.msq");
  await fs.writeFile(outsideTune, '<msq><page><constant name="secret">1</constant></page></msq>');
  await fs.symlink(outsideTune, path.join(projectDir, "linked.msq"));
  await assert.rejects(() => getTuneItem("demo", "linked.msq", "secret", 0, env), /escapes/);

  const outsideReviewDir = path.join(root, "outside-reviews");
  await fs.mkdir(outsideReviewDir);
  await fs.symlink(outsideReviewDir, path.join(projectDir, "McpReview"));
  const source = await listTuneItems("demo", "CurrentTune.msq", {}, env);
  await assert.rejects(
    () => stageTuneChanges("demo", "CurrentTune.msq", "review.msq", [{ kind: "setting", name: "revLimit", value: 7200 }], source.sha256, env),
    /escapes/,
  );
});

test("rejects project path traversal", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => inspectProject("../secret", env), /single name/);
});
