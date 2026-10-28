# shared-chrome-mcp

One Chrome that stays on and stays logged in, shared by all your agents at once: Claude Code, Codex, Cursor, Claude Desktop, anything that speaks MCP.

You log in to a site once, or let the agent do it, and every agent can use that login from then on. The agent logs in by itself when a site asks; nothing stops at the login page and waits for you.

## Why not just Playwright MCP

This is stock [Playwright MCP](https://github.com/microsoft/playwright-mcp) attached to one Chrome over CDP, plus the rules we learned the hard way, enforced by the server so agents don't have to remember them:

- **A window per agent, not a tab.** A background tab reports `document.hidden`, gets throttled, and bot checks flag it. Each MCP session gets its own window on first use and only ever sees its own tabs, so ten agents can work side by side without landing in each other's pages.
- **Waits until the page is ready.** After navigate, click, back, select or key press, it waits for load, network idle, no visible spinners and one second without DOM changes (20 s at most), then returns a fresh snapshot. If the page never settles, the result says `NOT READY` plainly instead of handing back a half-loaded page.
- **Logins stay.** Cookies are shared, so the server refuses obvious logout clicks and URLs. Closing a session closes its windows and nothing else.
- **Hand a window to the human.** For a step only a person can do (a CAPTCHA, a 2FA code, a final review before submit), `browser_hand_over` brings the current window to the front, puts an optional note in its title and leaves it open after the session ends; the session stops seeing it.
- **Always on.** On macOS a launchd agent keeps Chrome running across crashes and reboots; on Windows a Scheduled Task does the same.

Alternatives: [agent-browser](https://github.com/vercel-labs/agent-browser) (a driver that pins each session to a tab) and [BrowserOS neo](https://github.com/browseros-ai/BrowserOS) (a separate browser app for agents).

## Start Chrome

Needs Node.js 20.11+ and Google Chrome.

```sh
npx -y github:zucchini-chat/shared-chrome-mcp install   # macOS: launchd, Windows: Scheduled Task — keeps it running
npx -y github:zucchini-chat/shared-chrome-mcp start     # or run it in the foreground (any OS)
npx -y github:zucchini-chat/shared-chrome-mcp status
```

Chrome opens on its own profile (`~/.shared-chrome-mcp/profile`) with CDP on `127.0.0.1:9222`. Log in there to the sites you want agents to use, or leave that to the agents. Change the port or profile with `--port` / `--profile` (or `SHARED_CHROME_MCP_PORT` / `SHARED_CHROME_MCP_PROFILE`), the same for every command and for the MCP server. `uninstall` removes the launchd agent or Scheduled Task and keeps the profile. `install` points it at the copy of the package it ran from, so run it again after an update.

On Windows, `install` registers a Scheduled Task, scoped to your own account, that starts at logon and relaunches itself whenever it exits, for any reason; `--owner-chrome-first` is macOS-only (there's no Dock to redirect). Stopping the task or the `start` process from outside (Task Manager, `Stop-ScheduledTask`) can't run its own shutdown code the way a signal does on macOS/Linux, so `uninstall` finds and stops that Chrome directly instead of relying on it to exit cleanly.

On macOS, links from other apps open in the oldest running Chrome. If they start landing in the agents' Chrome, install with `--owner-chrome-first`: it starts your own Chrome first and restarts the agents' one whenever yours restarts.

## Claude Code

The repo is a plugin and its own marketplace:

```
/plugin marketplace add zucchini-chat/shared-chrome-mcp
/plugin install shared-chrome-mcp@shared-chrome-mcp
```

Claude Code installs the two dependencies from `package-lock.json` as part of the plugin install. The plugin has no version number, so it follows this repo's commits: `/plugin marketplace update shared-chrome-mcp` brings the latest, or turn on auto-update for the marketplace under `/plugin` > Marketplaces. You get the MCP server, a skill with the rules the server cannot enforce (payments, downloads, parallel agents, what to do when Chrome is down), and a hook that blocks Claude in Chrome, which refuses to log in anywhere.

## Codex, Cursor, Claude Desktop and others

Add it as a stdio MCP server. Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.browser]
command = "npx"
args = ["-y", "github:zucchini-chat/shared-chrome-mcp"]
```

Cursor, Claude Desktop and most others:

```json
{ "mcpServers": { "browser": { "command": "npx", "args": ["-y", "github:zucchini-chat/shared-chrome-mcp"] } } }
```

Each client process is one session with its own window. Subagents inside one session share it, so run one browser subagent at a time, or separate sessions in parallel.

## Security

The CDP port hands the whole logged-in profile to any process on this machine: every cookie and every session, no password asked. Chrome listens on 127.0.0.1 only. Never forward or expose the port, and run this only on a machine where you trust everything that runs. Playwright MCP's `browser_run_code_unsafe` tool, kept here, runs arbitrary code in the server process.

## Test

From a checkout, after `npm install`: `npm run smoke` starts a throwaway Chrome on port 9333, connects two MCP sessions at once and checks the windows, visibility, renderer priority, readiness wait, popups, dialogs, hand-over, reopening after browser_close and cleanup.
