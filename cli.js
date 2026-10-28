#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { install, start, status, uninstall } from './lib/chrome.js';

const HELP = `shared-chrome-mcp: one always-on, logged-in Chrome shared by any number of agents.

Usage:
  shared-chrome-mcp              run the MCP server (stdio) for your agent
  shared-chrome-mcp start        launch Chrome on the shared profile and stay with it (foreground)
  shared-chrome-mcp install      macOS: launchd agent; Windows: Scheduled Task (both survive reboots and crashes)
  shared-chrome-mcp uninstall    remove that launchd agent or Scheduled Task (the profile stays)
  shared-chrome-mcp status       is Chrome up, on which profile, is the launchd agent/Scheduled Task registered

Options (or environment variables):
  --port <n>               CDP port on 127.0.0.1 (SHARED_CHROME_MCP_PORT, default 9222)
  --profile <dir>          Chrome profile directory (SHARED_CHROME_MCP_PROFILE, default ~/.shared-chrome-mcp/profile)
  --chrome <path>          Chrome binary (SHARED_CHROME_MCP_CHROME)
  --label <name>           launchd label / Scheduled Task name (SHARED_CHROME_MCP_LABEL, default shared-chrome-mcp)
  --owner-chrome-first     macOS: start your own Chrome first and restart this one whenever yours restarts,
                           so the Dock and links from other apps keep opening in yours (SHARED_CHROME_MCP_OWNER_CHROME_FIRST=1)
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string' },
    profile: { type: 'string' },
    chrome: { type: 'string' },
    label: { type: 'string' },
    'owner-chrome-first': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const env = process.env;

function defaultChrome() {
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') {
    const candidates = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
      .filter(Boolean).map(dir => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    // Falls back to the Program Files path if none exist, so a missing Chrome still fails with a sensible path in the error.
    return candidates.find(existsSync) ?? candidates[0] ?? 'chrome.exe';
  }
  return 'google-chrome';
}

const profile = (flags.profile ?? env.SHARED_CHROME_MCP_PROFILE ?? '~/.shared-chrome-mcp/profile').replace(/^~(?=\/|$)/, homedir());

const options = {
  port: Number(flags.port ?? env.SHARED_CHROME_MCP_PORT ?? 9222),
  profile: resolve(profile),
  chrome: flags.chrome ?? env.SHARED_CHROME_MCP_CHROME ?? defaultChrome(),
  label: flags.label ?? env.SHARED_CHROME_MCP_LABEL ?? 'shared-chrome-mcp',
  ownerChromeFirst: flags['owner-chrome-first'] ?? env.SHARED_CHROME_MCP_OWNER_CHROME_FIRST === '1',
};

const command = positionals[0] ?? 'serve';
const commands = { start, install, uninstall, status };

if (flags.help || command === 'help') {
  console.log(HELP);
} else if (command === 'serve') {
  const { serve } = await import('./lib/server.js');
  const { version } = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'));
  await serve({ port: options.port, version });
} else if (commands[command]) {
  await commands[command](options).catch(error => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(1);
}
