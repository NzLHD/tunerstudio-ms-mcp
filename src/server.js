#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  applyCurrentTuneChanges,
  compareTunes,
  getTuneItem,
  inspectDataLog,
  inspectProject,
  inspectTune,
  installationInfo,
  launchTunerStudio,
  listDataLogs,
  listProjects,
  listSerialPorts,
  listTunes,
  listTuneItems,
  megaLogViewerInstallationInfo,
  openLogInMegaLogViewer,
} from "./tunerstudio.js";

const server = new McpServer(
  { name: "tunerstudio-ms", version: "1.4.0" },
  { instructions: "Inspect CurrentTune.msq before editing and pass its SHA-256 to apply_current_tune_changes. The tool makes a verified backup and atomically updates CurrentTune.msq. If TunerStudio is open, it detects the external change and prompts the user; otherwise the tool normally launches it. Use the data-log tools for bounded analysis and open_log_in_megalogviewer when interactive review is useful. Never accept, burn, download to an ECU, flash firmware, or send controller commands." },
);

function result(data, message) {
  return { structuredContent: data, content: [{ type: "text", text: message || JSON.stringify(data, null, 2) }] };
}

server.registerTool("get_installation_info", {
  title: "Get TunerStudio installation info",
  description: "Check whether TunerStudio MS is installed and locate its launcher and projects directory.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => { const data = await installationInfo(); return result(data); });

server.registerTool("get_megalogviewer_installation_info", {
  title: "Get MegaLogViewer installation info",
  description: "Check whether MegaLogViewer MS is installed and locate its launcher.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => { const data = await megaLogViewerInstallationInfo(); return result(data); });

server.registerTool("list_projects", {
  title: "List TunerStudio projects",
  description: "List the local TunerStudio project folders and basic controller metadata.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => { const projects = await listProjects(); return result({ projects }, `Found ${projects.length} TunerStudio project(s).`); });

server.registerTool("inspect_project", {
  title: "Inspect a TunerStudio project",
  description: "Summarize a local TunerStudio project, including properties and tune/log counts.",
  inputSchema: { projectId: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ projectId }) => { const data = await inspectProject(projectId); return result(data); });

server.registerTool("list_tunes", {
  title: "List tune files",
  description: "List .msq and .msqpart tune files in a TunerStudio project.",
  inputSchema: { projectId: z.string().min(1), limit: z.number().int().min(1).max(500).default(100) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, limit }) => { const tunes = await listTunes(projectId, process.env, limit); return result({ projectId, tunes }, `Found ${tunes.length} tune file(s).`); });

server.registerTool("inspect_tune", {
  title: "Inspect a tune file",
  description: "Read metadata and a bounded structural summary from an MSQ tune without changing it.",
  inputSchema: { projectId: z.string().min(1), relativePath: z.string().min(1) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, relativePath }) => { const data = await inspectTune(projectId, relativePath); return result(data); });

server.registerTool("list_tune_items", {
  title: "List tune settings and tables",
  description: "Discover scalar settings, arrays, and tables in an MSQ tune before reading or staging changes.",
  inputSchema: {
    projectId: z.string().min(1),
    relativePath: z.string().min(1),
    kind: z.enum(["all", "setting", "array", "table"]).default("all"),
    query: z.string().default(""),
    limit: z.number().int().min(1).max(500).default(100),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, relativePath, kind, query, limit }) => {
  const data = await listTuneItems(projectId, relativePath, { kind, query, limit });
  return result(data, `Found ${data.matchedItems} matching tune item(s); returned ${data.items.length}.`);
});

server.registerTool("get_tune_item", {
  title: "Read a tune setting or table",
  description: "Read the current value and metadata for one scalar setting, array, or table in an MSQ tune.",
  inputSchema: { projectId: z.string().min(1), relativePath: z.string().min(1), name: z.string().min(1), occurrence: z.number().int().min(0).default(0) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, relativePath, name, occurrence }) => {
  const data = await getTuneItem(projectId, relativePath, name, occurrence);
  return result(data);
});

const tuneChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("setting"), name: z.string().min(1), occurrence: z.number().int().min(0).default(0), value: z.union([z.string(), z.number()]) }),
  z.object({ kind: z.literal("tableCells"), name: z.string().min(1), occurrence: z.number().int().min(0).default(0), cells: z.array(z.object({ row: z.number().int().min(0), column: z.number().int().min(0), value: z.number().finite() })).min(1).max(1000) }),
  z.object({ kind: z.literal("replaceTable"), name: z.string().min(1), occurrence: z.number().int().min(0).default(0), values: z.array(z.array(z.number().finite()).min(1)).min(1) }),
]);

server.registerTool("apply_current_tune_changes", {
  title: "Apply backed-up changes to CurrentTune",
  description: "Create and verify an immutable backup, then atomically update the project's CurrentTune.msq. An open TunerStudio instance will show its external-change prompt; otherwise TunerStudio is launched for review by default. This never accepts or downloads changes to the ECU.",
  inputSchema: {
    projectId: z.string().min(1),
    expectedSourceSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
    changes: z.array(tuneChangeSchema).min(1).max(100),
    launchForReview: z.boolean().default(true),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, changes, expectedSourceSha256, launchForReview }) => {
  const data = await applyCurrentTuneChanges(projectId, changes, expectedSourceSha256);
  const launch = launchForReview && !data.tunerStudioWasRunning ? await launchTunerStudio(projectId) : null;
  const response = { ...data, launchedForReview: Boolean(launch), reviewInExistingTunerStudio: data.tunerStudioWasRunning, launch };
  const reviewMessage = data.tunerStudioWasRunning
    ? " The open TunerStudio instance will prompt the user about the external tune change."
    : launch
      ? " TunerStudio was launched for user review."
      : " Launch TunerStudio before deciding whether to download to the ECU.";
  return result(response, `Backed up and updated CurrentTune.msq with ${data.changes.length} change(s).${reviewMessage}`);
});

server.registerTool("compare_tunes", {
  title: "Compare two tune files",
  description: "Compare settings and table cells between two MSQ files and return a bounded change report for review.",
  inputSchema: { projectId: z.string().min(1), leftRelativePath: z.string().min(1), rightRelativePath: z.string().min(1), limit: z.number().int().min(1).max(2000).default(500) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, leftRelativePath, rightRelativePath, limit }) => {
  const data = await compareTunes(projectId, leftRelativePath, rightRelativePath, limit);
  return result(data, `Found ${data.totalChangedItems} changed item(s) and ${data.totalChangedValues} changed value(s).`);
});

server.registerTool("list_data_logs", {
  title: "List data logs",
  description: "List .msl, .csv, and .mlg data logs in a TunerStudio project.",
  inputSchema: { projectId: z.string().min(1), limit: z.number().int().min(1).max(500).default(100) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, limit }) => { const logs = await listDataLogs(projectId, process.env, limit); return result({ projectId, logs }, `Found ${logs.length} data log(s).`); });

server.registerTool("inspect_data_log", {
  title: "Inspect a text data log",
  description: "Summarize fields and numeric ranges from a local .msl or .csv TunerStudio log.",
  inputSchema: { projectId: z.string().min(1), relativePath: z.string().min(1), sampleRows: z.number().int().min(1).max(50000).default(5000) },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, relativePath, sampleRows }) => { const data = await inspectDataLog(projectId, relativePath, process.env, sampleRows); return result(data); });

server.registerTool("open_log_in_megalogviewer", {
  title: "Open a data log in MegaLogViewer",
  description: "Open a project-contained .msl, .csv, or .mlg log in MegaLogViewer MS, optionally selecting a view, live trailing, or automatic playback.",
  inputSchema: {
    projectId: z.string().min(1),
    relativePath: z.string().min(1),
    displayView: z.enum(["lineGraph", "scatterPlot", "histogram", "ignitionLogger"]).default("lineGraph"),
    trailFile: z.boolean().default(false),
    startPlayback: z.boolean().default(false),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, relativePath, displayView, trailFile, startPlayback }) => {
  const data = await openLogInMegaLogViewer(projectId, relativePath, { displayView, trailFile, startPlayback });
  return result(data, `Opened ${data.relativePath} in MegaLogViewer using the ${data.displayView} view.`);
});

server.registerTool("list_serial_ports", {
  title: "List likely ECU serial ports",
  description: "List local Linux serial devices commonly used by ECUs and report whether this user can read them.",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => { const ports = await listSerialPorts(); return result({ ports }, `Found ${ports.length} likely ECU serial port(s).`); });

server.registerTool("launch_tunerstudio", {
  title: "Launch TunerStudio MS",
  description: "Launch the installed TunerStudio MS desktop application. This starts a GUI process but does not connect to or alter an ECU.",
  inputSchema: { projectId: z.string().min(1).optional() },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ projectId }) => { const data = await launchTunerStudio(projectId); return result(data, `Launched TunerStudio MS (PID ${data.pid}).`); });

const transport = new StdioServerTransport();
await server.connect(transport);
