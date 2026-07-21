# getstoreready-mcp

MCP server for [GetStoreReady](https://getstoreready.com) — create projects,
upload screenshots, apply templates, edit screen designs, translate listings,
export ZIPs, and more from an MCP-capable AI client (Claude, Cursor, Codex,
Gemini, …).

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

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.getstoreready]
command = "npx"
args = ["-y", "github:getstoreready/getstoreready-mcp"]

[mcp_servers.getstoreready.env]
GSR_API_KEY = "gsr_live_your_key_here"
```

### Gemini CLI

Add to `~/.gemini/settings.json`:

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

### App bootstrap (from local repo)

| Tool | What it does |
|---|---|
| `detect_app` | Infer stack, app name, platforms, locales, and prioritized screens from a repo path. |
| `discover_screenshots` | Find PNG/JPG under `marketing/`, `fastlane/screenshots/`, `screenshots/`, etc. |
| `bootstrap_store_project` | One-shot: detect → upload → create project → apply template → return text layers for copy. |

**Agent skill:** [getstoreready/getstoreready-skill](https://github.com/getstoreready/getstoreready-skill) — install with `npx skills add getstoreready/getstoreready-skill`.

**Quick bootstrap:**

1. `detect_app({ appRootPath: "/path/to/app" })`
2. `discover_screenshots({ appRootPath })` — optional if you already know paths
3. `bootstrap_store_project({ appRootPath, templateKey: "random" })`
4. `update_screen_text` per screen (optionally after `get_screen_images` + vision)

### Projects & templates

| Tool | What it does |
|---|---|
| `list_projects` | List your GetStoreReady projects. |
| `create_project` | Create a new project. Returns its id and editor URL. |
| `get_project` | Project summary — platforms, languages, screen count, editor URL. |
| `list_templates` | List templates with your owned/locked state. |
| `apply_template` | Apply a template by key or `"random"`. See recommended flow below. |
| `upload_screenshots` | Upload raw app screenshots — prefer local `path` over base64 `data`. |
| `place_screenshot_image` | Place an uploaded asset into a screen by 1-based index. |

### Screen design

| Tool | What it does |
|---|---|
| `get_screens` | List screens with text layer ids, current copy, and device asset urls. |
| `get_screen_images` | Return device screenshot images for **your AI client's vision** (not server OCR). |
| `update_screen_text` | Change one template text layer on one screen. |
| `update_screen_design` | Change background and/or multiple text layers on one screen. |
| `bulk_update_designs` | Same background/text across all or selected screens (e.g. white bg everywhere). |

### Listing & localization

| Tool | What it does |
|---|---|
| `list_store_languages` | Active and available store languages for a project. |
| `add_store_language` | Add `de_DE`, `fr_FR`, etc. |
| `get_listing` | Read ASO / store listing text for one locale. |
| `update_listing` | Update listing fields for one locale. |
| `get_ai_credits` | AI credit balance and translate availability. |
| `estimate_translation` | Credit cost estimate before translating. |
| `translate_project` | AI-translate listing and/or screen text between languages. |

### Export

| Tool | What it does |
|---|---|
| `export_project` | Enqueue export, wait for ZIP, optionally save to a local path. |

### Store push (Premium/Pro)

Link credentials in the web UI first (`/projects/:id/settings`).

| Tool | What it does |
|---|---|
| `get_app_store_link` | App Store Connect link status for a project. |
| `preview_app_store_push` | Review ASC push plan, blockers, warnings, live-store diff. |
| `push_to_app_store` | Push listing + screenshots to App Store Connect. |
| `get_app_store_push_job` | Poll an App Store push job. |
| `get_google_play_link` | Google Play link status for a project. |
| `preview_google_play_push` | Review Play push plan, blockers, live-store diff. |
| `push_to_google_play` | Push listing, screenshots, and app icon to Google Play. |
| `get_google_play_push_job` | Poll a Google Play push job. |

### Recommended flows

**Template + screenshots (live editor):**

1. `apply_template({ projectId, templateKey })` — without `assetIds`
2. `upload_screenshots({ images: [{ path: "/local/shot.png" }] })`
3. `place_screenshot_image` once per screen

**Screenshot-aware titles (vision on your client):**

1. `get_screens` or `get_screen_images` — your AI reads the images
2. `update_screen_text` per screen with generated marketing copy

**Bootstrap from an app repo (Flutter / RN / Swift):**

1. `bootstrap_store_project({ appRootPath: "/path/to/my-app" })`
2. `update_screen_text` for each screen using returned `textLayers`
3. `update_listing` when ASO metadata is ready

**Add German + translate:**

1. `estimate_translation({ fromLanguage: "en_US", toLanguage: "de_DE", includeListing: true, includeDesigns: true })`
2. `get_ai_credits` — confirm balance
3. `add_store_language({ languageCode: "de_DE" })`
4. `translate_project({ fromLanguage: "en_US", toLanguage: "de_DE", includeListing: true, includeDesigns: true })`

**Push to App Store / Google Play:**

1. `get_app_store_link` / `get_google_play_link` — confirm linked
2. `preview_app_store_push` / `preview_google_play_push` — review blockers + diff
3. `push_to_app_store` / `push_to_google_play` — enqueue (waits by default)

**White backgrounds on all screens:**

```json
bulk_update_designs({
  "projectId": "...",
  "background": { "type": "solid", "color": "#ffffff" }
})
```

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
