import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("advertises the expected MCP tools and answers an installation query", async (t) => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tunerstudio-mcp-protocol-"));
  const installDir = path.join(fixtureRoot, "TunerStudioMS");
  const projectsDir = path.join(fixtureRoot, "TunerStudioProjects");
  const launcher = path.join(fixtureRoot, "tunerstudio");
  await fs.mkdir(installDir);
  await fs.mkdir(projectsDir);
  await fs.writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(repositoryRoot, "src", "server.js")],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TUNERSTUDIO_HOME: installDir,
      TUNERSTUDIO_LAUNCHER: launcher,
      TUNERSTUDIO_PROJECTS_DIR: projectsDir,
    },
  });
  const client = new Client({ name: "tunerstudio-mcp-test", version: "1.0.0" });
  t.after(async () => client.close());
  t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  await client.connect(transport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "get_installation_info",
    "list_projects",
    "inspect_project",
    "list_tunes",
    "inspect_tune",
    "list_data_logs",
    "inspect_data_log",
    "list_serial_ports",
    "launch_tunerstudio",
  ]);

  const response = await client.callTool({ name: "get_installation_info", arguments: {} });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.installed, true);
  assert.equal(response.structuredContent.launcherExists, true);
});
