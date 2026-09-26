import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_INSTALL_DIR = path.join(os.homedir(), ".local", "opt", "TunerStudioMS");
const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), "TunerStudioProjects");

export function getPaths(env = process.env) {
  return {
    installDir: path.resolve(env.TUNERSTUDIO_HOME || DEFAULT_INSTALL_DIR),
    projectsDir: path.resolve(env.TUNERSTUDIO_PROJECTS_DIR || DEFAULT_PROJECTS_DIR),
    launcher: path.resolve(env.TUNERSTUDIO_LAUNCHER || path.join(os.homedir(), ".local", "bin", "tunerstudio")),
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function installationInfo(env = process.env) {
  const { installDir, projectsDir, launcher } = getPaths(env);
  const stat = await fs.stat(installDir).catch(() => null);
  return {
    installed: Boolean(stat?.isDirectory()),
    installDir,
    launcher,
    launcherExists: await exists(launcher),
    projectsDir,
    projectsDirExists: await exists(projectsDir),
    platform: process.platform,
    architecture: process.arch,
  };
}

function assertSimpleName(value, label) {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`${label} must be a single name, not a path`);
  }
}

function resolveInside(root, ...parts) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path escapes the configured TunerStudio directory");
  }
  return resolved;
}

async function readProperties(filePath) {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const splitAt = line.search(/(?<!\\)[=:]/);
    if (splitAt < 0) continue;
    const key = line.slice(0, splitAt).trim();
    const value = line.slice(splitAt + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

async function walkFiles(root, maxDepth = 4) {
  const output = [];
  async function visit(current, depth) {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath, depth + 1);
      else if (entry.isFile()) output.push(fullPath);
    }
  }
  await visit(root, 0);
  return output;
}

export async function listProjects(env = process.env) {
  const { projectsDir } = getPaths(env);
  const entries = await fs.readdir(projectsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const projectDir = resolveInside(projectsDir, entry.name);
    const propertyFile = path.join(projectDir, "projectCfg", "project.properties");
    const fallbackPropertyFile = path.join(projectDir, "project.properties");
    const properties = await readProperties((await exists(propertyFile)) ? propertyFile : fallbackPropertyFile);
    const stat = await fs.stat(projectDir);
    projects.push({
      id: entry.name,
      name: properties.projectName || properties.ProjectName || entry.name,
      path: projectDir,
      lastModified: stat.mtime.toISOString(),
      controllerSignature: properties.ecuConfigName || properties.signature || null,
    });
  }
  return projects.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

export async function inspectProject(projectId, env = process.env) {
  assertSimpleName(projectId, "projectId");
  const { projectsDir } = getPaths(env);
  const projectDir = resolveInside(projectsDir, projectId);
  const stat = await fs.stat(projectDir);
  if (!stat.isDirectory()) throw new Error("Project is not a directory");
  const files = await walkFiles(projectDir);
  const tuneFiles = files.filter((file) => /\.(msq|msqpart)$/i.test(file));
  const logFiles = files.filter((file) => /\.(msl|csv|mlg)$/i.test(file));
  const iniFiles = files.filter((file) => /\.ini$/i.test(file));
  const propertyPath = files.find((file) => path.basename(file) === "project.properties");
  const allProperties = propertyPath ? await readProperties(propertyPath) : {};
  const propertyKeys = ["projectName", "projectDescription", "commPort", "CommSettingCom\\ Port", "baudRate", "CommSettingBaud\\ Rate", "selectedComDriver", "canId", "ecuConfigFile", "recordsPerSec", "dashBoardFile"];
  const properties = Object.fromEntries(propertyKeys.filter((key) => key in allProperties).map((key) => [key, allProperties[key]]));
  return {
    id: projectId,
    path: projectDir,
    lastModified: stat.mtime.toISOString(),
    properties,
    counts: { tunes: tuneFiles.length, logs: logFiles.length, iniFiles: iniFiles.length },
    mainControllerIni: iniFiles.find((file) => path.basename(file).toLowerCase() === "maincontroller.ini") || null,
    currentTune: tuneFiles.find((file) => path.basename(file).toLowerCase() === "currenttune.msq") || null,
  };
}

async function listProjectFiles(projectId, extensions, env = process.env, limit = 100) {
  assertSimpleName(projectId, "projectId");
  const { projectsDir } = getPaths(env);
  const projectDir = resolveInside(projectsDir, projectId);
  const files = (await walkFiles(projectDir)).filter((file) => extensions.test(file));
  const records = await Promise.all(files.map(async (file) => {
    const stat = await fs.stat(file);
    return {
      name: path.basename(file),
      relativePath: path.relative(projectDir, file),
      sizeBytes: stat.size,
      lastModified: stat.mtime.toISOString(),
    };
  }));
  return records.sort((a, b) => b.lastModified.localeCompare(a.lastModified)).slice(0, limit);
}

export function listTunes(projectId, env, limit) {
  return listProjectFiles(projectId, /\.(msq|msqpart)$/i, env, limit);
}

export function listDataLogs(projectId, env, limit) {
  return listProjectFiles(projectId, /\.(msl|csv|mlg)$/i, env, limit);
}

export async function inspectTune(projectId, relativePath, env = process.env) {
  assertSimpleName(projectId, "projectId");
  const { projectsDir } = getPaths(env);
  const projectDir = resolveInside(projectsDir, projectId);
  const tunePath = resolveInside(projectDir, relativePath);
  if (!/\.(msq|msqpart)$/i.test(tunePath)) throw new Error("Tune path must end in .msq or .msqpart");
  const stat = await fs.stat(tunePath);
  if (stat.size > 20 * 1024 * 1024) throw new Error("Tune file exceeds the 20 MiB inspection limit");
  const xml = await fs.readFile(tunePath, "utf8");
  const rootMatch = xml.match(/<msq\b([^>]*)>/i);
  const signatureMatch = xml.match(/<bibliography[^>]*>[^]*?<reference[^>]*>([^<]+)<\/reference>/i)
    || xml.match(/signature\s*=\s*["']([^"']+)["']/i);
  const constantNames = [...xml.matchAll(/<constant\b[^>]*\bname=["']([^"']+)["']/gi)].map((match) => match[1]);
  const pageNames = [...xml.matchAll(/<page\b[^>]*\bname=["']([^"']+)["']/gi)].map((match) => match[1]);
  return {
    projectId,
    relativePath: path.relative(projectDir, tunePath),
    sizeBytes: stat.size,
    lastModified: stat.mtime.toISOString(),
    validMsqRoot: Boolean(rootMatch),
    signature: signatureMatch?.[1]?.trim() || null,
    constantCount: constantNames.length,
    sampleConstants: [...new Set(constantNames)].slice(0, 30),
    pageCount: pageNames.length,
    pages: [...new Set(pageNames)].slice(0, 30),
  };
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(value.trim()); value = "";
    } else value += char;
  }
  cells.push(value.trim());
  return cells;
}

export async function inspectDataLog(projectId, relativePath, env = process.env, sampleRows = 5000) {
  assertSimpleName(projectId, "projectId");
  const { projectsDir } = getPaths(env);
  const projectDir = resolveInside(projectsDir, projectId);
  const logPath = resolveInside(projectDir, relativePath);
  if (!/\.(msl|csv)$/i.test(logPath)) throw new Error("Only text .msl and .csv logs can be inspected");
  const stat = await fs.stat(logPath);
  if (stat.size > 100 * 1024 * 1024) throw new Error("Log exceeds the 100 MiB inspection limit");
  const text = await fs.readFile(logPath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const headerIndex = lines.findIndex((line) => {
    const commas = (line.match(/,/g) || []).length;
    const tabs = (line.match(/\t/g) || []).length;
    return Math.max(commas, tabs) >= 2 && /[A-Za-z]/.test(line);
  });
  if (headerIndex < 0) throw new Error("Could not locate a delimited log header");
  const delimiter = (lines[headerIndex].match(/\t/g) || []).length > (lines[headerIndex].match(/,/g) || []).length ? "\t" : ",";
  const fields = parseDelimitedLine(lines[headerIndex], delimiter);
  const numeric = Object.fromEntries(fields.map((field) => [field, { count: 0, min: Infinity, max: -Infinity, sum: 0 }]));
  const dataLines = lines.slice(headerIndex + 1, headerIndex + 1 + sampleRows);
  for (const line of dataLines) {
    const values = parseDelimitedLine(line, delimiter);
    fields.forEach((field, index) => {
      const value = Number(values[index]);
      if (!Number.isFinite(value)) return;
      const summary = numeric[field];
      summary.count += 1;
      summary.min = Math.min(summary.min, value);
      summary.max = Math.max(summary.max, value);
      summary.sum += value;
    });
  }
  const numericFields = Object.fromEntries(Object.entries(numeric)
    .filter(([, value]) => value.count > 0)
    .slice(0, 100)
    .map(([field, value]) => [field, { count: value.count, min: value.min, max: value.max, mean: value.sum / value.count }]));
  return {
    projectId,
    relativePath: path.relative(projectDir, logPath),
    sizeBytes: stat.size,
    lastModified: stat.mtime.toISOString(),
    fields,
    sampledRows: dataLines.length,
    totalNonEmptyLines: lines.length,
    numericFields,
  };
}

export async function listSerialPorts() {
  if (process.platform !== "linux") return [];
  const deviceNames = await fs.readdir("/dev").catch(() => []);
  const candidates = deviceNames.filter((name) => /^(tty(ACM|USB|S)|rfcomm)\d+$/.test(name));
  return Promise.all(candidates.map(async (name) => {
    const devicePath = path.join("/dev", name);
    const stat = await fs.stat(devicePath);
    return { path: devicePath, readable: await fs.access(devicePath, fsConstants.R_OK).then(() => true, () => false), mode: (stat.mode & 0o777).toString(8) };
  }));
}

export async function launchTunerStudio(projectId, env = process.env) {
  const info = await installationInfo(env);
  if (!info.launcherExists) throw new Error(`TunerStudio launcher not found at ${info.launcher}`);
  let projectDirectory = null;
  const args = [];
  if (projectId) {
    assertSimpleName(projectId, "projectId");
    const projectDir = resolveInside(info.projectsDir, projectId);
    const stat = await fs.stat(projectDir);
    if (!stat.isDirectory()) throw new Error("Project is not a directory");
    projectDirectory = projectDir;
    args.push(projectDir);
  }
  const child = spawn(info.launcher, args, {
    cwd: info.installDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  child.unref();
  return { launched: true, pid: child.pid, launcher: info.launcher, requestedProject: projectId || null, projectDirectory };
}
