---
name: shared-browser
description: Rules for the shared logged-in Chrome (the browser_* tools of the shared-chrome-mcp MCP server). Read before any browser work - logins, payments, downloads, popups, parallel agents, and what to do when Chrome is down.
---

# Shared browser

One Chrome, on its own profile, runs all the time and every agent on this machine uses it at once: Claude Code sessions, Codex, Cursor, anything with the MCP server. Its logins belong to all of them. The server already gives your session its own window, keeps you in it, waits for the page after navigate, click, back, select or key press, and closes your windows when the session ends. You do the rest:

- **Use only this browser for web work that needs a login.** Do not launch another Chrome or a second browser tool on the same sites. Claude in Chrome is blocked on purpose: it refuses to log in.
- **Log in yourself** when a site asks, with the credentials the human keeps for agents. A login made here counts for every agent. Hand it to the human only when it needs them (a 2FA code on their phone, a CAPTCHA you cannot pass).
- **Hand a window over** with `browser_hand_over` when a step needs the human (a CAPTCHA, a 2FA code, a final review before submit): fill everything else first, pass a `note` with what they should do, and tell them. The window comes to the front and stays open after your session ends; you no longer see it. Keep the handle from the result: once they say they are done, or with `text` that only shows once they are (e.g. "Payment method added"), `browser_take_back` returns the same page as they left it, and you carry on there. Never take it back while they may still be working in it.
- **Never log out**, never clear cookies or site data: every agent loses that login. The server refuses obvious logout clicks and URLs, but not every one.
- **Pay only on an explicit go-ahead** from the human for that specific purchase. Without one, stop at checkout and ask. Chrome's saved-card autofill popup does not react to automation.
- **Downloads** land in Chrome's download folder (usually `~/Downloads`), not in a Playwright download event. Move the file from there.
- **Not ready** in a result means the page was still loading or changing when the wait gave up: conclude nothing from it; call `browser_snapshot` again, or `browser_wait_for` a text you expect.
- **Popups:** a link that opens a new tab puts it in your window, where it hides your first page. Work in it with `browser_tabs` `select`, then `browser_tabs` `close` it.
- **One browser job per session.** Subagents share their parent's MCP server and so its current tab: run one browser subagent at a time. For parallel browser jobs, run separate sessions (for example `claude -p "<job>"` per job).
- **When done**, `browser_close` closes your windows; other agents' windows stay.

## Chrome is down

A tool error says `No Chrome on http://127.0.0.1:<port>`: nothing answers on that port. (`Chrome ... is up, but attaching to it failed` is not this: retry, never restart.) Never start a Chrome of your own on a guess: one on another profile has none of the logins.
1. Find how this machine keeps the shared Chrome running (its setup notes, e.g. the repo's tools file) and restart it that way. The steps below are for this package's own keep-alive only.
2. `node "${CLAUDE_PLUGIN_ROOT}/cli.js" status` shows whether Chrome is up and whether its launchd agent is installed.
3. Installed (macOS): `launchctl kickstart -k gui/$(id -u)/shared-chrome-mcp`. Its log is the profile path plus `.log` (default `~/.shared-chrome-mcp/profile.log`).
4. Not installed: start it in the background with `node "${CLAUDE_PLUGIN_ROOT}/cli.js" start`, and tell the human that `npx -y github:zucchini-chat/shared-chrome-mcp install` keeps it running for good.
5. Your windows are gone after a restart; the next browser call opens a new one. If every site now shows logged out, Chrome was started some other way: it must run with the mock-keychain flags, which only `start` passes.
