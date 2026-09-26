# TunerStudio MS MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for inspecting and safely editing TunerStudio MS projects and opening project data logs in MegaLogViewer MS.

The server uses stdio transport and runs entirely on the same computer as TunerStudio. It can make backup-protected changes to `CurrentTune.msq` and launch TunerStudio for user review, but it never accepts changes, downloads or burns settings to an ECU, flashes firmware, or sends controller commands.

## Requirements

- Node.js 20 or newer
- TunerStudio MS installed locally
- MegaLogViewer MS installed locally for interactive log review
- A 64-bit Java runtime supported by both applications

The default Linux paths are:

- TunerStudio: `~/.local/opt/TunerStudioMS`
- TunerStudio launcher: `~/.local/bin/tunerstudio`
- MegaLogViewer: `~/.local/opt/MegaLogViewerMS`
- MegaLogViewer launcher: `~/.local/bin/megalogviewer`
- Projects: `~/TunerStudioProjects`

Override them with `TUNERSTUDIO_HOME`, `TUNERSTUDIO_LAUNCHER`, `TUNERSTUDIO_PROJECTS_DIR`, `MEGALOGVIEWER_HOME`, and `MEGALOGVIEWER_LAUNCHER`.

## Install

```bash
git clone https://github.com/NzLHD/tunerstudio-ms-mcp.git
cd tunerstudio-ms-mcp
npm ci
npm test
```

## Configure an MCP client

The checked-in `.mcp.json` works with clients that support project-level MCP configuration:

```json
{
  "mcpServers": {
    "tunerstudio": {
      "command": "node",
      "args": ["./src/server.js"]
    }
  }
}
```

From the repository root, Codex CLI can register the server with:

```bash
codex mcp add tunerstudio -- node "$PWD/src/server.js"
codex mcp list
```

If either application uses non-default paths, add the corresponding environment variables to your client configuration. Open a new client session after changing MCP configuration so the tools enter that session's inventory.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_installation_info` | Check the configured installation and project paths. |
| `get_megalogviewer_installation_info` | Check the configured MegaLogViewer installation and launcher. |
| `list_projects` | List local TunerStudio projects. |
| `inspect_project` | Summarize a project's configuration and files. |
| `list_tunes` | List `.msq` and `.msqpart` files. |
| `inspect_tune` | Read bounded metadata from a tune file. |
| `list_tune_items` | Discover scalar settings, arrays, and tables. |
| `get_tune_item` | Read a complete setting, array, or table with dimensions and units. |
| `apply_current_tune_changes` | Back up and atomically update `CurrentTune.msq`, then launch TunerStudio for review. |
| `compare_tunes` | Report changed settings and individual table cells. |
| `list_data_logs` | List `.msl`, `.csv`, and `.mlg` logs. |
| `inspect_data_log` | Summarize fields and numeric ranges in text logs. |
| `open_log_in_megalogviewer` | Open a project log in MegaLogViewer with a selected analysis view. |
| `list_serial_ports` | List likely Linux ECU serial devices and access state. |
| `launch_tunerstudio` | Start TunerStudio, optionally with a project. |

All file inputs are constrained to the configured projects directory. Tune inspection is limited to 20 MiB, text-log inspection to 100 MiB, and returned samples are bounded.

## Safe tune editing workflow

Tune changes use a review-first workflow:

1. Call `list_tune_items` or `get_tune_item` on `CurrentTune.msq` and retain the returned SHA-256 hash.
2. Call `apply_current_tune_changes` with that hash and one or more changes.
3. The tool verifies an immutable backup and atomically replaces `CurrentTune.msq`.
4. If TunerStudio is already open, it detects the external file change and prompts the user. Otherwise the tool launches the project by default.
5. Call `compare_tunes` with the returned backup path and `CurrentTune.msq` for a machine-readable change report.
6. The user reviews TunerStudio's validation and difference report, then explicitly decides whether to accept or download the tune to the ECU.

`apply_current_tune_changes` supports:

- `setting` for scalar numeric or enumerated-string settings.
- `tableCells` for selected numeric table cells.
- `replaceTable` for a complete numeric matrix with exactly matching dimensions.

Table row and column indexes are zero-based and follow MSQ file storage order. Before every edit, the original tune is copied to `<project>/McpBackups/` and its SHA-256 is verified. A JSON manifest beside the backup records the before/after hashes, exact changes, and whether TunerStudio was running. Stale source hashes, dimension mismatches, path traversal, and symlink escapes are rejected.

The MCP server cannot download or burn a tune to an ECU. That final action remains exclusively in TunerStudio under direct user control.

## MegaLogViewer integration

Use `list_data_logs` to discover logs in a project and `inspect_data_log` for a bounded summary of text-based `.msl` or `.csv` data. Call `open_log_in_megalogviewer` for interactive analysis of project-contained `.msl`, `.csv`, or `.mlg` logs.

The open tool starts MegaLogViewer through a private temporary properties file and supports its `lineGraph`, `scatterPlot`, `histogram`, and `ignitionLogger` views. It can also request live file trailing or automatic playback. The temporary file is mode `0600` and is automatically removed after launch. Log paths are resolved to their real filesystem location and rejected if they escape the configured TunerStudio project, including through symbolic links.

## Development

```bash
npm install
npm test
npm start
```

The test suite covers scalar and table editing while TunerStudio is open or closed, verified backups, atomic current-tune replacement, stale-hash rejection, path and symlink traversal rejection, tune comparisons, log parsing, MegaLogViewer launch properties, and a real MCP stdio handshake.

## Serial permissions on Linux

On distributions that assign serial devices to the `dialout` group, add your user to that group if TunerStudio cannot open the ECU port:

```bash
sudo usermod -aG dialout "$USER"
```

Sign out and back in for the group change to take effect.
