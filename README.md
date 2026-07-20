# getstoreready-mcp

MCP server for [GetStoreReady](https://getstoreready.com) — create projects,
upload screenshots, list and apply templates, update store listing text, and
check project status, all from an MCP-capable AI client (Claude, Cursor,
Codex, Gemini, …).

## 1. Get an API key

Create one at **[getstoreready.com/profile/api-keys](https://getstoreready.com/profile/api-keys)**
(you'll need a GetStoreReady account). The token is shown once — copy it
somewhere safe.

## 2. Add it to your MCP client

Every client below runs the same command:

```json
{
  "command": "npx",
  "args": ["-y", "github:getstoreready/getstoreready-mcp"],
  "env": {
    "GSR_API_KEY": "gsr_live_your_key_here"
  }
}
```

### Claude Code

Project-scoped (shared via `.mcp.json` committed to a repo):

```bash
claude mcp add getstoreready --scope project -- npx -y github:getstoreready/getstoreready-mcp
```

Then set `GSR_API_KEY` in your environment, or add it directly to the
generated `.mcp.json`:

```json
{
  "mcpServers": {
    "getstoreready": {
      "command": "npx",
      "args": ["-y", "github:getstoreready/getstoreready-mcp"],
      "env": { "GSR_API_KEY": "gsr_live_your_key_here" }
    }
  }
}
```

User-scoped (available in every project): same block in
`~/.claude.json` under `mcpServers`, or `claude mcp add --scope user`.

### Claude Desktop

Settings → Developer → Edit Config (opens `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "getstoreready": {
      "command": "npx",
      "args": ["-y", "github:getstoreready/getstoreready-mcp"],
      "env": { "GSR_API_KEY": "gsr_live_your_key_here" }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "getstoreready": {
      "command": "npx",
      "args": ["-y", "github:getstoreready/getstoreready-mcp"],
      "env": { "GSR_API_KEY": "gsr_live_your_key_here" }
    }
  }
}
```

Or use Cursor's one-click install deep link — replace `YOUR_KEY` and open:

```
cursor://anysphere.cursor-deeplink/mcp/install?name=getstoreready&config=BASE64_OF_JSON_BELOW
```

where the JSON to base64-encode is:

```json
{
  "command": "npx",
  "args": ["-y", "github:getstoreready/getstoreready-mcp"],
  "env": { "GSR_API_KEY": "YOUR_KEY" }
}
```

### Codex CLI

Add to `~/.codex/config.toml` (or `.codex/config.toml` for a trusted project):

```toml
[mcp_servers.getstoreready]
command = "npx"
args = ["-y", "github:getstoreready/getstoreready-mcp"]

[mcp_servers.getstoreready.env]
GSR_API_KEY = "gsr_live_your_key_here"
```

Or interactively: `codex mcp add getstoreready -- npx -y github:getstoreready/getstoreready-mcp`.

### Gemini CLI

Add to `~/.gemini/settings.json` (or project `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "getstoreready": {
      "command": "npx",
      "args": ["-y", "github:getstoreready/getstoreready-mcp"],
      "env": { "GSR_API_KEY": "gsr_live_your_key_here" }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | List your GetStoreReady projects. |
| `create_project` | Create a new project. Returns its id and editor URL. |
| `upload_screenshots` | Upload raw app screenshots (base64), returns asset ids. |
| `list_templates` | List templates with your actual owned/locked state. |
| `apply_template` | Apply a template by key, or `"random"` to pick any unlocked one. Optionally places uploaded screenshots into it in order. |
| `update_listing` | Update store listing / ASO text (app name, subtitle, description, keywords, …) for one locale. |
| `get_project` | Summary of a project — name, platforms, screen count, editor URL. |

## Local development

```bash
git clone git@github.com:getstoreready/getstoreready-mcp.git
cd getstoreready-mcp
npm install
GSR_API_KEY=... GSR_API_BASE=http://localhost:3201 GSR_SITE_URL=http://localhost:3200 npm run dev
```

## Configuration

| Env var | Required | Default |
|---|---|---|
| `GSR_API_KEY` | Yes | — |
| `GSR_API_BASE` | No | `https://api.getstoreready.com` |
| `GSR_SITE_URL` | No | `https://getstoreready.com` |

## License

MIT
