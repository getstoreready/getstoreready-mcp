<p align="center">
  <a href="https://getstoreready.com"><img src="img/logo.png" alt="GetStoreReady" width="320"></a>
</p>

<h1 align="center">getstoreready-mcp</h1>

<p align="center">MCP server for <a href="https://getstoreready.com">GetStoreReady</a> — create projects,
upload screenshots, apply templates, edit screen designs, translate listings,
export ZIPs, and more from an MCP-capable AI client (Claude, Cursor, Codex,
Gemini, …).</p>

---
## Two ways to connect

### A. Hosted connector (no install)

Add **`https://api.getstoreready.com/mcp`** as a custom connector / remote MCP
server. The first time, your AI app opens getstoreready.com — sign up or log in,
click **Allow**, done. No API key to copy.

- **Claude (web / desktop):** Settings → Connectors → Add custom connector → paste the URL.
- **Claude Code:** `claude mcp add --transport http getstoreready https://api.getstoreready.com/mcp`
- **ChatGPT, Cursor, others:** add it as a remote / Streamable HTTP MCP server.

The hosted connector can't see your computer, so the local-only tools
(`detect_app`, `capture_screenshots`, `bootstrap_store_project`, upload by file
path, saving a store key from a file) are only in the local server below.

### B. Local server (simulator capture, local files)

Every client below runs the same command. **No API key needed** — ask your
agent to "sign in to GetStoreReady": the `sign_in` tool opens
getstoreready.com/connect with a short code, you sign up or log in and click
**Allow**, and the key is saved to `~/.config/getstoreready/credentials.json`.

```json
{
  "command": "npx",
  "args": ["-y", "github:getstoreready/getstoreready-mcp"]
}
```

Prefer a fixed key (CI, scripts)? Create one at
**[getstoreready.com/profile/api-keys](https://getstoreready.com/profile/api-keys)**
and set it as `GSR_API_KEY` in the server's `env` — it takes precedence over
`sign_in`. The examples below show that optional `env` block.

### Claude Code

Project-scoped (shared via `.mcp.json` committed to a repo):

```bash
claude mcp add getstoreready --scope project -- npx -y github:getstoreready/getstoreready-mcp
```

Optionally set `GSR_API_KEY` in your environment (otherwise use `sign_in`), or add it to the
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

### Account & billing

| Tool | What it does |
|---|---|
| `sign_in` | Browser sign-in / sign-up (local server only) — no password or key in the chat |
| `sign_out` | Forget the saved key on this machine (local server only) |
| `get_account` | Signed-in email, plan, AI credit balance |
| `list_plans` | Plans and credit packs with prices |
| `start_checkout` | Payment link for a plan or credit pack — the user pays in their browser |

### App bootstrap (from local repo)

| Tool | What it does |
|---|---|
| `detect_app` | Infer stack, app name, platforms, locales, and prioritized screens from a repo path. |
| `discover_screenshots` | Find PNG/JPG under `marketing/`, `fastlane/screenshots/`, `screenshots/`, etc. |
| `capture_screenshots` | Capture from iOS Simulator (`simctl` + optional Maestro) or Android (`adb`) into `marketing/<locale>/`. Prefer `deepLinks` or Maestro for distinct screens. |
| `bootstrap_store_project` | One-shot: detect → upload → create project → apply template → return text layers for copy. |

**Agent skill:** [getstoreready/getstoreready-skill](https://github.com/getstoreready/getstoreready-skill) — install with `npx skills add getstoreready/getstoreready-skill`.

**Quick bootstrap:**

1. `detect_app({ appRootPath: "/path/to/app" })`
2. `discover_screenshots({ appRootPath })` — if empty, `capture_screenshots({ appRootPath, platform: "ios" })`
3. `bootstrap_store_project({ appRootPath, templateKey: "random" })`
4. `update_screen_text` per screen (optionally after `get_screen_images` + vision)
5. Optional: `update_listing` → `translate_project` → `export_project` → store push tools

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

### Free-form design (full editor parity)

Everything the web editor can do — free text with per-word highlight runs, any
Google Font, device mockups with 3D tilt/lean and view presets, image & icon
layers, edge fades, gradient/pattern/panorama backgrounds, per-device overrides
(iPhone vs iPad vs Android), groups and z-order — is one Design JSON per screen.
These tools read and write it directly; the vocabulary comes live from the API,
so new editor features show up without an MCP update.

| Tool | What it does |
|---|---|
| `get_design_catalog` | **Start here.** Design guide + JSON Schema + layer defaults, device models & view presets, slot sizes, fonts, icons. Also exposed as the `gsr://design-guide` resource. |
| `get_screen_design` | Full Design JSON of one screen (or the feature graphic). |
| `set_screen_design` | Replace a screen's whole design (validated by the API). |
| `edit_layers` | Batch ops: add / update / remove / move / duplicate / set_override (per device slot) / group / ungroup. |
| `set_background` | Background for one/all screens, or a per-slot background override. |
| `render_preview` | Render a screen to PNG per device slot with the export engine — for the agent to *look* at its work. |
| `add_screen` / `delete_screen` / `move_screen` | Blank, template, copied or full-design screens; feature graphic too. |
| `set_device_slots` | Which device sizes the project produces; tablet landscape. |
| `list_media` | Your uploads + curated stock images usable as `assetId`. |

**Design loop:** `get_design_catalog` → `add_screen` / `set_screen_design` →
`render_preview` → `edit_layers` tweaks (incl. `set_override` for tablets) →
`render_preview` again for every enabled slot.

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
| `remove_store_language` | Remove a language (not the primary one) |
| `reorder_store_languages` | Set language order |
| `set_primary_store_language` | Change the primary (source) language |
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

Hosted mode (what runs behind `api.getstoreready.com/mcp`):

```bash
npm run build
PORT=3100 GSR_API_BASE=http://localhost:3201 GSR_PUBLIC_API_BASE=http://localhost:3201 node dist/index.js --http
```

## Configuration

| Env var | Required | Default |
|---|---|---|
| `GSR_API_KEY` | No — or use `sign_in` | — |
| `GSR_CREDENTIALS_PATH` | No | `~/.config/getstoreready/credentials.json` |
| `GSR_API_BASE` | No | `https://api.getstoreready.com` |
| `GSR_SITE_URL` | No | `https://getstoreready.com` |

## License

MIT

## Store connections

Connect a project to App Store Connect / Google Play without the web UI.
Secrets are passed as **file paths** — the MCP reads the file locally and sends
it encrypted to GetStoreReady, so keys never enter the chat.

| Tool | Purpose |
|------|---------|
| `list_store_credentials` | Saved keys / service accounts (no secrets) |
| `add_app_store_credential` | `issuerId`, `keyId`, `privateKeyPath` (AuthKey_XXXX.p8) |
| `add_google_play_credential` | `serviceAccountJsonPath` |
| `test_store_credential` | Check a credential, optionally against an app |
| `delete_store_credential` | Remove a saved credential |
| `link_app_store` / `link_google_play` | Connect a project to its store app |
| `test_store_link` / `unlink_store` | Check or remove a project's link |
