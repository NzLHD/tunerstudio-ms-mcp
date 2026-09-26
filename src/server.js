#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  inspectDataLog,
  inspectProject,
  inspectTune,
  installationInfo,
  launchTunerStudio,
  listDataLogs,
  listProjects,
  listSerialPorts,
  listTunes,
} from "./tunerstudio.js";

const server = new McpServer(
  { name: "tunerstudio-ms", version: "1.0.0" },
  { instructions: "Inspect TunerStudio projects, tune files, data logs, serial ports, and installation state before launching the desktop app. This server does not write ECU settings or send controller commands." },
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
