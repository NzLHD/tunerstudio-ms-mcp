import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { applyCurrentTuneChanges, compareTunes, getTuneItem, inspectDataLog, inspectProject, inspectTune, listProjects, listTuneItems, megaLogViewerInstallationInfo, openLogInMegaLogViewer } from "../src/tunerstudio.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tunerstudio-mcp-"));
  const projectsDir = path.join(root, "projects");
  const projectDir = path.join(projectsDir, "demo");
  const megaLogViewerHome = path.join(root, "MegaLogViewerMS");
  const megaLogViewerLauncher = path.join(root, "megalogviewer");
  await fs.mkdir(path.join(projectDir, "projectCfg"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "DataLogs"), { recursive: true });
  await fs.mkdir(megaLogViewerHome);
  await fs.writeFile(megaLogViewerLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(projectDir, "projectCfg", "project.properties"), "projectName=Demo Car\necuConfigName=MS3\n");
  await fs.writeFile(path.join(projectDir, "projectCfg", "mainController.ini"), "[MegaTune]\n");
  await fs.writeFile(path.join(projectDir, "CurrentTune.msq"), '<?xml version="1.0" encoding="ISO-8859-1"?><msq><bibliography tuneComment="temperature \xB0F"/><versionInfo signature="MS3"/><page number="0"><constant name="nCylinders">"4"</constant><constant digits="0" name="revLimit" units="RPM">7000</constant><constant cols="2" digits="1" name="veTable" rows="2" units="%">\n  1.0 2.0\n  3.0 4.0\n</constant></page></msq>', "latin1");
  await fs.writeFile(path.join(projectDir, "DataLogs", "run.msl"), "# metadata\nTime,RPM,AFR\n0,900,14.7\n1,1200,13.9\n");
  return { root, env: { TUNERSTUDIO_PROJECTS_DIR: projectsDir, TUNERSTUDIO_HOME: path.join(root, "app"), MEGALOGVIEWER_HOME: megaLogViewerHome, MEGALOGVIEWER_LAUNCHER: megaLogViewerLauncher } };
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

test("reports MegaLogViewer installation and opens project logs with view options", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installation = await megaLogViewerInstallationInfo(env);
  assert.equal(installation.installed, true);
  assert.equal(installation.launcherExists, true);
  const opened = await openLogInMegaLogViewer("demo", "DataLogs/run.msl", { displayView: "scatterPlot", trailFile: true, startPlayback: true }, env);
  t.after(() => fs.unlink(opened.launchPropertiesPath).catch(() => {}));
  assert.equal(opened.launched, true);
  assert.equal(opened.displayView, "scatterPlot");
  const properties = await fs.readFile(opened.launchPropertiesPath, "utf8");
  assert.match(properties, /fileName=.*DataLogs\/run\.msl/);
  assert.match(properties, /trailFile=true/);
  assert.match(properties, /displayView=scatterPlot/);
  assert.match(properties, /startPlayback=true/);
});

test("backs up and atomically updates CurrentTune settings and tables", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const listed = await listTuneItems("demo", "CurrentTune.msq", { kind: "all", limit: 20 }, env);
  assert.equal(listed.matchedItems, 3);
  assert.equal(listed.items.find((item) => item.name === "veTable").kind, "table");

  const table = await getTuneItem("demo", "CurrentTune.msq", "veTable", 0, env);
  assert.deepEqual(table.item.values, [[1, 2], [3, 4]]);
  const originalMode = (await fs.stat(path.join(root, "projects", "demo", "CurrentTune.msq"))).mode & 0o777;

  const applied = await applyCurrentTuneChanges("demo", [
    { kind: "setting", name: "nCylinders", value: "6" },
    { kind: "setting", name: "revLimit", value: 7200 },
    { kind: "tableCells", name: "veTable", cells: [{ row: 1, column: 0, value: 9.5 }] },
  ], listed.sha256, env);
  assert.match(applied.backupRelativePath, /^McpBackups[/\\]CurrentTune-before-/);
  assert.equal(applied.changes.length, 3);
  assert.equal(applied.beforeSha256, listed.sha256);
  assert.equal(applied.backupSha256, listed.sha256);
  assert.equal(applied.ecuUpdated, false);
  const currentBytes = await fs.readFile(path.join(root, "projects", "demo", "CurrentTune.msq"));
  assert.equal(currentBytes.includes(0xB0), true);
  assert.equal((await fs.stat(path.join(root, "projects", "demo", "CurrentTune.msq"))).mode & 0o777, originalMode);
  assert.equal((await fs.readdir(path.join(root, "projects", "demo"))).some((name) => name.startsWith(".CurrentTune.mcp-")), false);

  const backupSetting = await getTuneItem("demo", applied.backupRelativePath, "nCylinders", 0, env);
  const currentSetting = await getTuneItem("demo", "CurrentTune.msq", "nCylinders", 0, env);
  const currentTable = await getTuneItem("demo", "CurrentTune.msq", "veTable", 0, env);
  assert.equal(backupSetting.item.value, "4");
  assert.equal(currentSetting.item.value, "6");
  assert.deepEqual(currentTable.item.values, [[1, 2], [9.5, 4]]);

  const comparison = await compareTunes("demo", applied.backupRelativePath, "CurrentTune.msq", 20, env);
  assert.equal(comparison.totalChangedItems, 3);
  assert.equal(comparison.totalChangedValues, 3);
  assert.equal(comparison.truncated, false);

  const manifest = JSON.parse(await fs.readFile(path.join(root, "projects", "demo", `${applied.backupRelativePath}.mcp-backup.json`), "utf8"));
  assert.equal(manifest.reviewRequired, true);
  assert.equal(manifest.afterSha256, applied.afterSha256);

  const replaced = await applyCurrentTuneChanges("demo", [
    { kind: "replaceTable", name: "veTable", values: [[5.1, 6.2], [7.3, 8.4]] },
  ], applied.afterSha256, env);
  const replacedTable = await getTuneItem("demo", "CurrentTune.msq", "veTable", 0, env);
  assert.deepEqual(replacedTable.item.values, [[5.1, 6.2], [7.3, 8.4]]);
  const secondBackupTable = await getTuneItem("demo", replaced.backupRelativePath, "veTable", 0, env);
  assert.deepEqual(secondBackupTable.item.values, [[1, 2], [9.5, 4]]);
});

test("updates CurrentTune while TunerStudio is running", { skip: process.platform !== "linux" }, async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await listTuneItems("demo", "CurrentTune.msq", {}, env);
  const fakeTunerStudio = spawn("bash", ["-c", "exec -a TunerStudioMS.jar sleep 30"], { stdio: "ignore" });
  t.after(() => fakeTunerStudio.kill("SIGTERM"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const applied = await applyCurrentTuneChanges("demo", [{ kind: "setting", name: "revLimit", value: 7200 }], source.sha256, env);
  assert.equal(applied.tunerStudioWasRunning, true);
  assert.equal(applied.tunerStudioProcessIds.includes(fakeTunerStudio.pid), true);
  const current = await getTuneItem("demo", "CurrentTune.msq", "revLimit", 0, env);
  const backup = await getTuneItem("demo", applied.backupRelativePath, "revLimit", 0, env);
  assert.equal(current.item.value, 7200);
  assert.equal(backup.item.value, 7000);
});

test("refuses unsafe or stale tune revisions", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = await listTuneItems("demo", "CurrentTune.msq", {}, env);
  const change = [{ kind: "setting", name: "revLimit", value: 7200 }];
  await assert.rejects(() => applyCurrentTuneChanges("demo", change, "0".repeat(64), env), /hash does not match/);
  await assert.rejects(() => applyCurrentTuneChanges("demo", [{ kind: "tableCells", name: "veTable", cells: [{ row: 4, column: 0, value: 1 }] }], source.sha256, env), /outside/);
  await assert.rejects(() => applyCurrentTuneChanges("demo", [{ kind: "replaceTable", name: "veTable", values: [[1, 2, 3]] }], source.sha256, env), /exactly 2 rows by 2 columns/);
  await assert.rejects(() => applyCurrentTuneChanges("demo", change, undefined, env), /required/);
});

test("rejects tune and backup symlinks that escape the project", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectDir = path.join(root, "projects", "demo");
  const outsideTune = path.join(root, "outside.msq");
  await fs.writeFile(outsideTune, '<msq><page><constant name="secret">1</constant></page></msq>');
  await fs.symlink(outsideTune, path.join(projectDir, "linked.msq"));
  await assert.rejects(() => getTuneItem("demo", "linked.msq", "secret", 0, env), /escapes/);
  const outsideLog = path.join(root, "outside.msl");
  await fs.writeFile(outsideLog, "Time,RPM\n0,900\n");
  await fs.symlink(outsideLog, path.join(projectDir, "DataLogs", "linked.msl"));
  await assert.rejects(() => openLogInMegaLogViewer("demo", "DataLogs/linked.msl", {}, env), /escapes/);

  const outsideBackupDir = path.join(root, "outside-backups");
  await fs.mkdir(outsideBackupDir);
  await fs.symlink(outsideBackupDir, path.join(projectDir, "McpBackups"));
  const source = await listTuneItems("demo", "CurrentTune.msq", {}, env);
  await assert.rejects(
    () => applyCurrentTuneChanges("demo", [{ kind: "setting", name: "revLimit", value: 7200 }], source.sha256, env),
    /escapes/,
  );
});

test("rejects project path traversal", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => inspectProject("../secret", env), /single name/);
});
