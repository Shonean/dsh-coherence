# Connecting external agents to dsh-coherence over MCP

The suite's `mcpServer` feature (default off) serves memory, worklog, codebase-map, and transcript tools over MCP Streamable HTTP at `http://127.0.0.1:3140/mcp` (configurable via `mcpServer.port` and `mcpServer.path`). Point each agent's MCP client at that endpoint to read and write the shared memory, direction, and codebase map.

```yaml
# Enable the bridge in the dsh profile that keeps running (web / vscode / desktop):
- id: dsh-coherence
  name: 'dsh-coherence'
  config:
    features:
      mcpServer: true
    mcpServer:
      transport: streamable-http
      port: 3140
```

## Claude Code

Project `.mcp.json`:

```json
{
  "mcpServers": {
    "dsh-memory": {
      "type": "http",
      "url": "http://127.0.0.1:3140/mcp"
    }
  }
}
```

## opencode

`opencode.json` (project or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "dsh-memory": {
      "type": "http",
      "url": "http://127.0.0.1:3140/mcp"
    }
  }
}
```

## codex

`~/.codex/config.toml` (codex supports streamable-http MCP servers by URL):

```toml
[mcp_servers.dsh-memory]
url = "http://127.0.0.1:3140/mcp"
```

If a client only supports stdio, run `dsh mcp-server` instead (a future CLI subcommand) and point the client at that process; the streamable-http endpoint is the single-process, single-writer default.
