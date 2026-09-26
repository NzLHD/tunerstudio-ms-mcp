import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

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

async function resolveExistingRealPathInside(root, candidate) {
  const realRoot = await fs.realpath(root);
  const realCandidate = await fs.realpath(candidate);
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${path.sep}`)) throw new Error("Resolved path escapes the configured TunerStudio directory");
  return realCandidate;
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

function parseXmlAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/g)) attributes[match[1]] = match[3];
  return attributes;
}

function unescapeXml(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readTuneDocument(projectId, relativePath, env = process.env) {
  assertSimpleName(projectId, "projectId");
  const { projectsDir } = getPaths(env);
  const projectDir = resolveInside(projectsDir, projectId);
  const tunePath = await resolveExistingRealPathInside(projectDir, resolveInside(projectDir, relativePath));
  if (!/\.(msq|msqpart)$/i.test(tunePath)) throw new Error("Tune path must end in .msq or .msqpart");
  const stat = await fs.stat(tunePath);
  if (!stat.isFile()) throw new Error("Tune path is not a file");
  if (stat.size > 20 * 1024 * 1024) throw new Error("Tune file exceeds the 20 MiB inspection limit");
  const buffer = await fs.readFile(tunePath);
  const text = buffer.toString("latin1");
  if (!/<msq\b/i.test(text)) throw new Error("Tune does not contain an MSQ root element");
  return { projectDir, tunePath, relativePath: path.relative(projectDir, tunePath), buffer, text, stat };
}

function parseTuneElements(text) {
  const elements = [];
  const occurrences = new Map();
  const elementPattern = /(<(constant|pcVariable)\b([^>]*)>)([\s\S]*?)(<\/\2>)/gi;
  for (const match of text.matchAll(elementPattern)) {
    const attributes = parseXmlAttributes(match[3]);
    if (!attributes.name) continue;
    const rows = Number.parseInt(attributes.rows || "1", 10);
    const cols = Number.parseInt(attributes.cols || "1", 10);
    if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) continue;
    const occurrenceKey = `${match[2]}:${attributes.name}`;
    const occurrence = occurrences.get(occurrenceKey) || 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const content = match[4];
    const trimmed = content.trim();
    const quoted = /^"[\s\S]*"$/.test(trimmed);
    const tokens = quoted ? [unescapeXml(trimmed.slice(1, -1))] : trimmed.split(/\s+/).filter(Boolean);
    const expectedValues = rows * cols;
    const numericValues = quoted ? null : tokens.map(Number);
    const isNumeric = numericValues !== null && numericValues.length === expectedValues && numericValues.every(Number.isFinite);
    elements.push({
      tag: match[2],
      name: attributes.name,
      occurrence,
      attributes,
      rows,
      cols,
      digits: Number.isInteger(Number(attributes.digits)) && Number(attributes.digits) >= 0 && Number(attributes.digits) <= 20 ? Number(attributes.digits) : null,
      units: attributes.units || null,
      kind: rows > 1 && cols > 1 ? "table" : expectedValues > 1 ? "array" : "setting",
      quoted,
      isNumeric,
      values: isNumeric ? numericValues : tokens,
      content,
      contentStart: match.index + match[1].length,
      contentEnd: match.index + match[1].length + content.length,
    });
  }
  return elements;
}

function publicTuneElement(element, includeValues = false) {
  const result = {
    name: element.name,
    occurrence: element.occurrence,
    elementType: element.tag,
    kind: element.kind,
    rows: element.rows,
    columns: element.cols,
    digits: element.digits,
    units: element.units,
    numeric: element.isNumeric,
  };
  if (includeValues) {
    result.value = element.kind === "setting" ? element.values[0] : undefined;
    result.values = element.kind === "setting"
      ? undefined
      : Array.from({ length: element.rows }, (_, row) => element.values.slice(row * element.cols, (row + 1) * element.cols));
  }
  return result;
}

export async function listTuneItems(projectId, relativePath, options = {}, env = process.env) {
  const document = await readTuneDocument(projectId, relativePath, env);
  const kind = options.kind || "all";
  const query = (options.query || "").toLowerCase();
  const limit = Math.min(Math.max(options.limit || 100, 1), 500);
  const allElements = parseTuneElements(document.text);
  const items = allElements
    .filter((element) => kind === "all" || element.kind === kind)
    .filter((element) => !query || element.name.toLowerCase().includes(query))
    .slice(0, limit)
    .map((element) => publicTuneElement(element));
  return {
    projectId,
    relativePath: document.relativePath,
    sha256: sha256(document.buffer),
    totalItems: allElements.length,
    matchedItems: allElements.filter((element) => (kind === "all" || element.kind === kind) && (!query || element.name.toLowerCase().includes(query))).length,
    items,
  };
}

function findTuneElement(elements, name, occurrence = 0) {
  const element = elements.find((candidate) => candidate.name === name && candidate.occurrence === occurrence);
  if (!element) throw new Error(`Tune item not found: ${name} (occurrence ${occurrence})`);
  return element;
}

export async function getTuneItem(projectId, relativePath, name, occurrence = 0, env = process.env) {
  const document = await readTuneDocument(projectId, relativePath, env);
  const element = findTuneElement(parseTuneElements(document.text), name, occurrence);
  if (element.values.length > 4096) throw new Error("Tune item exceeds the 4096-value response limit");
  return {
    projectId,
    relativePath: document.relativePath,
    sha256: sha256(document.buffer),
    item: publicTuneElement(element, true),
    indexing: "Table row and column indexes are zero-based and follow MSQ file storage order.",
  };
}

function formatNumeric(value, digits) {
  if (!Number.isFinite(value)) throw new Error("Tune values must be finite numbers");
  return digits === null ? String(value) : value.toFixed(digits);
}

function formatElementContent(element, values) {
  if (element.kind === "setting") {
    const value = values[0];
    if (element.quoted) {
      const stringValue = String(value);
      if ([...stringValue].some((character) => character.codePointAt(0) > 255)) throw new Error(`${element.name} contains characters outside ISO-8859-1`);
      return `"${escapeXml(stringValue)}"`;
    }
    return formatNumeric(Number(value), element.digits);
  }
  const rows = [];
  for (let row = 0; row < element.rows; row += 1) {
    const rowValues = values.slice(row * element.cols, (row + 1) * element.cols).map((value) => formatNumeric(Number(value), element.digits));
    rows.push(`         ${rowValues.join(" ")} `);
  }
  return `\n${rows.join("\n")}\n      `;
}

function summarizeAppliedChange(element, before, after) {
  if (element.kind === "setting") return { kind: "setting", name: element.name, occurrence: element.occurrence, before: before[0], after: after[0], units: element.units };
  const changedCells = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) changedCells.push({ row: Math.floor(index / element.cols), column: index % element.cols, before: before[index], after: after[index] });
  }
  return { kind: element.kind, name: element.name, occurrence: element.occurrence, rows: element.rows, columns: element.cols, changedCellCount: changedCells.length, changedCells: changedCells.slice(0, 200) };
}

async function findRunningTunerStudioProcesses() {
  if (process.platform !== "linux") return [];
  const entries = await fs.readdir("/proc", { withFileTypes: true }).catch(() => []);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const commandLine = await fs.readFile(path.join("/proc", entry.name, "cmdline"), "utf8").catch(() => "");
    if (commandLine.includes("TunerStudioMS.jar")) matches.push(Number(entry.name));
  }
  return matches;
}

function renderTuneChanges(document, changes) {
  if (!Array.isArray(changes) || changes.length < 1) throw new Error("At least one tune change is required");
  const elements = parseTuneElements(document.text);
  const replacements = [];
  const appliedChanges = [];
  const seenItems = new Set();
  for (const change of changes) {
    const occurrence = change.occurrence || 0;
    const element = findTuneElement(elements, change.name, occurrence);
    const itemKey = `${element.tag}:${element.name}:${occurrence}`;
    if (seenItems.has(itemKey)) throw new Error(`Multiple changes target the same item: ${change.name} (occurrence ${occurrence})`);
    seenItems.add(itemKey);
    const before = [...element.values];
    const after = [...before];

    if (change.kind === "setting") {
      if (element.kind !== "setting") throw new Error(`${change.name} is a ${element.kind}, not a scalar setting`);
      after[0] = element.quoted ? String(change.value) : Number(change.value);
    } else if (change.kind === "tableCells") {
      if (element.kind !== "table") throw new Error(`${change.name} is a ${element.kind}, not a table`);
      if (!Array.isArray(change.cells) || change.cells.length < 1) throw new Error(`No table cells supplied for ${change.name}`);
      for (const cell of change.cells) {
        if (!Number.isInteger(cell.row) || cell.row < 0 || cell.row >= element.rows) throw new Error(`Row ${cell.row} is outside ${change.name}`);
        if (!Number.isInteger(cell.column) || cell.column < 0 || cell.column >= element.cols) throw new Error(`Column ${cell.column} is outside ${change.name}`);
        after[cell.row * element.cols + cell.column] = Number(cell.value);
      }
    } else if (change.kind === "replaceTable") {
      if (element.kind !== "table") throw new Error(`${change.name} is a ${element.kind}, not a table`);
      if (!Array.isArray(change.values) || change.values.length !== element.rows || change.values.some((row) => !Array.isArray(row) || row.length !== element.cols)) {
        throw new Error(`${change.name} replacement must be exactly ${element.rows} rows by ${element.cols} columns`);
      }
      after.splice(0, after.length, ...change.values.flat().map(Number));
    } else throw new Error(`Unsupported change kind: ${change.kind}`);

    if (!element.quoted && after.some((value) => !Number.isFinite(Number(value)))) throw new Error(`${change.name} contains a non-numeric value`);
    const summary = summarizeAppliedChange(element, before, after);
    if (summary.kind !== "setting" && summary.changedCellCount === 0) throw new Error(`${change.name} does not change any table cells`);
    if (summary.kind === "setting" && summary.before === summary.after) throw new Error(`${change.name} does not change the setting value`);
    replacements.push({ start: element.contentStart, end: element.contentEnd, content: formatElementContent(element, after) });
    appliedChanges.push(summary);
  }

  let outputText = document.text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) outputText = `${outputText.slice(0, replacement.start)}${replacement.content}${outputText.slice(replacement.end)}`;
  return { outputBuffer: Buffer.from(outputText, "latin1"), appliedChanges };
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-");
}

export async function applyCurrentTuneChanges(projectId, changes, expectedSourceSha256, env = process.env) {
  const runningProcesses = await findRunningTunerStudioProcesses();
  if (runningProcesses.length > 0) throw new Error(`Close TunerStudio before editing CurrentTune.msq (running PID${runningProcesses.length === 1 ? "" : "s"}: ${runningProcesses.join(", ")})`);
  const document = await readTuneDocument(projectId, "CurrentTune.msq", env);
  const sourceHash = sha256(document.buffer);
  if (!expectedSourceSha256) throw new Error("expectedSourceSha256 is required; read CurrentTune.msq again before editing");
  if (expectedSourceSha256.toLowerCase() !== sourceHash) throw new Error("CurrentTune.msq hash does not match expectedSourceSha256; read the tune again before editing");
  const { outputBuffer, appliedChanges } = renderTuneChanges(document, changes);

  const backupDir = path.join(document.projectDir, "McpBackups");
  await fs.mkdir(backupDir, { recursive: true });
  const realBackupDir = await resolveExistingRealPathInside(document.projectDir, backupDir);
  const backupFileName = `CurrentTune-before-${backupTimestamp()}-${sourceHash.slice(0, 12)}.msq`;
  const backupPath = resolveInside(realBackupDir, backupFileName);
  await fs.copyFile(document.tunePath, backupPath, fsConstants.COPYFILE_EXCL);
  const backupBuffer = await fs.readFile(backupPath);
  if (sha256(backupBuffer) !== sourceHash) throw new Error("Backup verification failed; CurrentTune.msq was not changed");

  const currentBuffer = await fs.readFile(document.tunePath);
  if (sha256(currentBuffer) !== sourceHash) throw new Error("CurrentTune.msq changed after backup; edit aborted before replacement");

  const tempPath = resolveInside(document.projectDir, `.CurrentTune.mcp-${crypto.randomUUID()}.tmp`);
  let tempExists = false;
  try {
    const handle = await fs.open(tempPath, "wx", document.stat.mode & 0o777);
    tempExists = true;
    try {
      await handle.writeFile(outputBuffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const finalCheck = await fs.readFile(document.tunePath);
    if (sha256(finalCheck) !== sourceHash) throw new Error("CurrentTune.msq changed while preparing the update; edit aborted before replacement");
    await fs.rename(tempPath, document.tunePath);
    tempExists = false;
  } finally {
    if (tempExists) await fs.unlink(tempPath).catch(() => {});
  }

  const outputHash = sha256(outputBuffer);
  const backupRelativePath = path.relative(document.projectDir, backupPath);
  const manifest = {
    format: "tunerstudio-ms-mcp-current-tune-backup-v1",
    createdAt: new Date().toISOString(),
    projectId,
    currentTuneRelativePath: "CurrentTune.msq",
    beforeSha256: sourceHash,
    afterSha256: outputHash,
    backupRelativePath,
    backupSha256: sourceHash,
    changes: appliedChanges,
    reviewRequired: true,
    ecuUpdated: false,
  };
  await fs.writeFile(`${backupPath}.mcp-backup.json`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export async function compareTunes(projectId, leftRelativePath, rightRelativePath, limit = 500, env = process.env) {
  const left = await readTuneDocument(projectId, leftRelativePath, env);
  const right = await readTuneDocument(projectId, rightRelativePath, env);
  const leftElements = parseTuneElements(left.text);
  const rightMap = new Map(parseTuneElements(right.text).map((element) => [`${element.tag}:${element.name}:${element.occurrence}`, element]));
  const differences = [];
  let totalChangedItems = 0;
  let totalChangedCells = 0;
  for (const leftElement of leftElements) {
    const rightElement = rightMap.get(`${leftElement.tag}:${leftElement.name}:${leftElement.occurrence}`);
    if (!rightElement) continue;
    const summary = summarizeAppliedChange(leftElement, leftElement.values, rightElement.values);
    const changed = summary.kind === "setting" ? summary.before !== summary.after : summary.changedCellCount > 0;
    if (!changed) continue;
    totalChangedItems += 1;
    totalChangedCells += summary.kind === "setting" ? 1 : summary.changedCellCount;
    if (differences.length < limit) differences.push(summary);
  }
  return {
    projectId,
    left: { relativePath: left.relativePath, sha256: sha256(left.buffer) },
    right: { relativePath: right.relativePath, sha256: sha256(right.buffer) },
    totalChangedItems,
    totalChangedValues: totalChangedCells,
    truncated: differences.length < totalChangedItems,
    differences,
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
