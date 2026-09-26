import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectDataLog, inspectProject, inspectTune, listProjects } from "../src/tunerstudio.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tunerstudio-mcp-"));
  const projectsDir = path.join(root, "projects");
  const projectDir = path.join(projectsDir, "demo");
  await fs.mkdir(path.join(projectDir, "projectCfg"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "DataLogs"), { recursive: true });
  await fs.writeFile(path.join(projectDir, "projectCfg", "project.properties"), "projectName=Demo Car\necuConfigName=MS3\n");
  await fs.writeFile(path.join(projectDir, "projectCfg", "mainController.ini"), "[MegaTune]\n");
  await fs.writeFile(path.join(projectDir, "CurrentTune.msq"), '<?xml version="1.0"?><msq signature="MS3"><page name="fuel"><constant name="veTable">1 2</constant></page></msq>');
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
  assert.deepEqual(tune.sampleConstants, ["veTable"]);
  const log = await inspectDataLog("demo", "DataLogs/run.msl", env);
  assert.equal(log.sampledRows, 2);
  assert.equal(log.numericFields.RPM.max, 1200);
  assert.equal(log.numericFields.AFR.mean, 14.3);
});

test("rejects project path traversal", async (t) => {
  const { root, env } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => inspectProject("../secret", env), /single name/);
});
