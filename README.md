# TunerStudio MS MCP

A local [Model Context Protocol](https://modelcontextprotocol.io/) server for inspecting TunerStudio MS projects, tune files, data logs, serial ports, and installation state.

The server uses stdio transport and runs entirely on the same computer as TunerStudio. It can launch the TunerStudio desktop application, but intentionally does not write tune values, burn ECU settings, flash firmware, or send controller commands.

## Requirements

- Node.js 20 or newer
- TunerStudio MS installed locally
- Java runtime supported by your TunerStudio installation

The default Linux paths are:

- TunerStudio: `~/.local/opt/TunerStudioMS`
- Launcher: `~/.local/bin/tunerstudio`
- Projects: `~/TunerStudioProjects`

Override them with `TUNERSTUDIO_HOME`, `TUNERSTUDIO_LAUNCHER`, and `TUNERSTUDIO_PROJECTS_DIR`.

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

If TunerStudio uses non-default paths, add the three environment variables to your client configuration. Open a new client session after changing MCP configuration so the tools enter that session's inventory.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_installation_info` | Check the configured installation and project paths. |
| `list_projects` | List local TunerStudio projects. |
| `inspect_project` | Summarize a project's configuration and files. |
| `list_tunes` | List `.msq` and `.msqpart` files. |
| `inspect_tune` | Read bounded metadata from a tune file. |
| `list_data_logs` | List `.msl`, `.csv`, and `.mlg` logs. |
| `inspect_data_log` | Summarize fields and numeric ranges in text logs. |
| `list_serial_ports` | List likely Linux ECU serial devices and access state. |
| `launch_tunerstudio` | Start TunerStudio, optionally with a project. |

All file inputs are constrained to the configured projects directory. Tune inspection is limited to 20 MiB, text-log inspection to 100 MiB, and returned samples are bounded.

## Development

```bash
npm install
npm test
npm start
```

The test suite covers tune and log parsing, path traversal rejection, and a real MCP stdio handshake.

## Serial permissions on Linux

On distributions that assign serial devices to the `dialout` group, add your user to that group if TunerStudio cannot open the ECU port:

```bash
sudo usermod -aG dialout "$USER"
```

Sign out and back in for the group change to take effect.
