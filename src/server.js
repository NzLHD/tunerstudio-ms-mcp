#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  compareTunes,
  getTuneItem,
  inspectDataLog,
  inspectProject,
  inspectTune,
  installationInfo,
  launchTunerStudio,
  launchTuneForReview,
  listDataLogs,
  listProjects,
  listSerialPorts,
  listTunes,
  listTuneItems,
  stageTuneChanges,
} from "./tunerstudio.js";

const server = new McpServer(
  { name: "tunerstudio-ms", version: "1.1.0" },
  { instructions: "Inspect TunerStudio projects and tunes before editing. Tune edits create immutable review MSQ files under McpReview; always compare and open the result for user review. This server never writes CurrentTune.msq, downloads to an ECU, burns settings, flashes firmware, or sends controller commands." },
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

server.registerTool("stage_tune_changes", {
  title: "Stage tune settings and table changes",
  description: "Create a new immutable review MSQ under the project's McpReview directory. Never overwrites the source tune, CurrentTune.msq, or an existing review. The user must inspect the result in TunerStudio before any ECU download.",
  inputSchema: {
    projectId: z.string().min(1),
    sourceRelativePath: z.string().min(1),
    outputFileName: z.string().min(5),
    expectedSourceSha256: z.string().regex(/^[0-9a-fA-F]{64}$/),
    changes: z.array(tuneChangeSchema).min(1).max(100),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, sourceRelativePath, outputFileName, changes, expectedSourceSha256 }) => {
  const data = await stageTuneChanges(projectId, sourceRelativePath, outputFileName, changes, expectedSourceSha256);
  return result(data, `Created ${data.outputRelativePath} with ${data.changes.length} staged change(s). Review in TunerStudio before downloading to an ECU.`);
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

server.registerTool("launch_tune_for_review", {
  title: "Open a staged tune for review",
  description: "Open an MSQ from the project's McpReview directory in TunerStudio. The user must review and explicitly choose whether to download it to the ECU.",
  inputSchema: { projectId: z.string().min(1), reviewRelativePath: z.string().min(1) },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ projectId, reviewRelativePath }) => {
  const data = await launchTuneForReview(projectId, reviewRelativePath);
  return result(data, `Opened ${data.reviewRelativePath} in TunerStudio for user review.`);
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
