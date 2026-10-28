import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const windows = process.platform === 'win32';

const cdp = (port, path = 'version') =>
  fetch(`http://127.0.0.1:${port}/json/${path}`, { signal: AbortSignal.timeout(2000) }).then(r => r.json(), () => null);

// Every running process with its full command line, one shape on every OS: `ps` carries it on
// macOS/Linux; Windows keeps it nowhere `tasklist` or Node expose, only in WMI/CIM.
const processes = () => {
  if (windows) {
    // Without this, PowerShell 5.1 writes its stdout in the console's OEM code page: a non-ASCII
    // path (a Cyrillic Windows user name, say) comes back corrupted and every match against it fails.
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'
    ], { encoding: 'utf8' });
    const rows = JSON.parse(out || '[]');
    return (Array.isArray(rows) ? rows : [rows]).filter(r => r.CommandLine).map(r => ({ pid: r.ProcessId, name: r.Name, command: r.CommandLine }));
  }
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .map(line => line.trim().match(/^(\d+) (.*)$/)).filter(Boolean).map(([, pid, command]) => ({ pid: Number(pid), command }));
};

// A command-line arg, quoted or not the way each OS happens to report it (Windows quotes paths with spaces).
const hasArg = (command, flag, value) =>
  new RegExp(`${flag}=["']?${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?(?:\\s|$)`).test(command);

// The Chrome running on this profile, if any (helpers carry --type=, the main process does not).
const profilePid = profile => processes().find(({ command }) => !command.includes('--type=') && hasArg(command, '--user-data-dir', profile))?.pid;

// The owner's everyday Chrome: a main Chrome process without a profile of its own. Only meaningful on
// macOS, where the Dock and links from other apps always go to the oldest running Chrome.
const ownerPid = () => process.platform === 'darwin' && processes().find(({ command }) =>
  /MacOS\/Google Chrome( --|$)/.test(command) && !command.includes('--type=') && !command.includes('--user-data-dir='))?.pid;

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function start(o) {
  if (o.ownerChromeFirst && process.platform !== 'darwin')
    throw new Error('--owner-chrome-first restarts this Chrome whenever the Dock\'s oldest one does, so it is macOS only.');

  // macOS sends Dock clicks and links from other apps to the oldest running Chrome, so the owner's must start first.
  let owner;
  if (o.ownerChromeFirst) {
    if (!ownerPid()) { spawnSync('open', ['-g', '-a', 'Google Chrome']); await sleep(5000); }
    owner = ownerPid();
  }

  // A Chrome already on this profile (started outside this command): watch it, since a second launch
  // would only hand it a new tab and exit.
  let pid = profilePid(o.profile);
  let child;
  if (!pid) {
    if (await cdp(o.port)) throw new Error(`Port ${o.port} is already taken by another browser. Pick another with --port.`);
    mkdirSync(o.profile, { recursive: true });
    child = spawn(o.chrome, [
      `--user-data-dir=${o.profile}`,
      `--remote-debugging-port=${o.port}`,
      // The profile's cookies are encrypted with the mock keychain: launch it any other way and every site shows logged out.
      '--use-mock-keychain',
      '--password-store=basic',
      // Agent windows are often covered by other windows: keep their pages running and visible.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Chrome's performance manager overrides the flag above (crbug.com/549552319): a page under its popup tab still drops
      // to background OS priority, and under load a click on it waits seconds for the renderer.
      '--disable-features=PMProcessPriorityPolicy',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ], { stdio: 'ignore' });
    pid = child.pid;
    // Stopping this command stops the Chrome it started; the loop below ends once Chrome has closed.
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill());
  }

  let up = false;
  for (let i = 0; i < 60 && !(up = !!(await cdp(o.port))); i++) await sleep(500);
  console.log(up ? `Chrome ${pid} on http://127.0.0.1:${o.port}, profile ${o.profile}` : `Chrome ${pid} runs on ${o.profile} but nothing answers on port ${o.port}`);

  while (alive(pid)) {
    await sleep(1000);
    const now = owner && ownerPid();
    // The owner's Chrome restarted (an update, a quit): this one is now the oldest. Exit and let launchd start it again.
    if (now && now !== owner) { process.kill(pid); break; }
  }
}

const uid = () => userInfo().uid;
const plistPath = label => join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const loaded = label => spawnSync('launchctl', ['print', `gui/${uid()}/${label}`], { stdio: 'ignore' }).status === 0;

// Task Scheduler has no "write this script's args as a plist" equivalent, so the task just runs a
// tiny launcher script, the same role the plist's ProgramArguments plays on macOS.
const taskDir = join(homedir(), '.shared-chrome-mcp', 'tasks');
const taskScriptPath = label => join(taskDir, `${label}.cmd`);
const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;
const taskExists = label => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `if (Get-ScheduledTask -TaskName ${psQuote(label)} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
]).status === 0;

// The top of the launcher's own process tree (the cmd.exe Task Scheduler runs the script as), found by
// its own path on the command line of a cmd.exe specifically (not e.g. an editor with the file open):
// killing this takes the loop, "start" and Chrome with it in one shot, and is how both re-installing
// and uninstalling stop an already-running instance.
const scriptRootPid = script => processes().find(({ name, command }) => name === 'cmd.exe' && command.includes(script))?.pid;

async function installWindows(o) {
  if (o.ownerChromeFirst) throw new Error('--owner-chrome-first restarts this Chrome whenever the Dock\'s oldest one does, so it is macOS only.');
  const log = `${o.profile}.log`;
  const script = taskScriptPath(o.label);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(script, [
    '@echo off',
    // cmd.exe reads .cmd files in the console's OEM code page; without switching it, a non-ASCII path
    // (this script's own home-directory paths, say) comes out mangled and every arg after it breaks.
    'chcp 65001 >nul',
    ':loop',
    // Task Scheduler's own restart-on-failure (RestartCount/-Interval below) turned out not to reliably
    // fire for a script action in practice, so the loop itself is what relaunches "start" whenever
    // Chrome goes away; the pause keeps a real crash (e.g. a bad --chrome path) from spinning the CPU.
    `"${process.execPath}" "${CLI}" start --port ${o.port} --profile "${o.profile}" --chrome "${o.chrome}" >> "${log}" 2>&1`,
    'ping -n 3 127.0.0.1 >nul',
    'goto loop',
    '',
  ].join('\r\n'));
  // Scoping the trigger to the current user (rather than plain -AtLogOn, which fires for anyone who
  // logs on and needs admin to register) is what install actually needs elevation for, not the account
  // itself: Register-ScheduledTask works from a normal terminal once it's scoped like this.
  const register = [
    'try {',
    '  $u = "$env:USERDOMAIN\\$env:USERNAME"',
    `  $action = New-ScheduledTaskAction -Execute ${psQuote(script)}`,
    '  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $u',
    '  $principal = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited',
    '  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    `  Register-ScheduledTask -TaskName ${psQuote(o.label)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null`,
    '  exit 0',
    '} catch { Write-Error $_.Exception.Message; exit 1 }',
  ].join('\n');
  const registered = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', register], { stdio: 'inherit' });
  if (registered.status !== 0) throw new Error('Register-ScheduledTask failed');
  // Only once the new registration is confirmed good is it safe to stop whatever instance was already
  // running under the old one (if install is re-run after an update, say): a failed Register above
  // leaves that instance untouched and still working, instead of torn down for nothing.
  const old = scriptRootPid(script);
  if (old) spawnSync('taskkill', ['/PID', String(old), '/T', '/F'], { stdio: 'ignore' });
  const started = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-ScheduledTask -TaskName ${psQuote(o.label)}`], { stdio: 'inherit' });
  if (started.status !== 0) throw new Error('Start-ScheduledTask failed');
  for (let i = 0; i < 60 && !(await cdp(o.port)); i++) await sleep(500);
  console.log(`Installed scheduled task ${o.label} (${script}), log ${log}`);
  await status(o);
}

async function uninstallWindows(o) {
  const unregister = [
    'try {',
    `  if (Get-ScheduledTask -TaskName ${psQuote(o.label)} -ErrorAction SilentlyContinue) {`,
    `    Unregister-ScheduledTask -TaskName ${psQuote(o.label)} -Confirm:$false -ErrorAction Stop`,
    '  }',
    '  exit 0',
    '} catch { Write-Error $_.Exception.Message; exit 1 }',
  ].join('\n');
  const unregistered = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', unregister], { stdio: 'inherit' });
  // A failure here (permissions, say) leaves the task registered and still pointing at a script that's
  // about to be deleted: better to stop and report it than silently proceed into a half-removed state.
  if (unregistered.status !== 0) throw new Error('Unregister-ScheduledTask failed');
  // Unregistering only stops future runs; the loop already running (cmd -> "start" -> Chrome) keeps
  // going and would just relaunch Chrome right back, so stop that whole tree by its root directly.
  const script = taskScriptPath(o.label);
  const root = scriptRootPid(script);
  if (root) spawnSync('taskkill', ['/PID', String(root), '/T', '/F'], { stdio: 'ignore' });
  // Cosmetic only: the profile this task actually ran, read back from the launcher install wrote.
  const profile = (() => { try { return readFileSync(script, 'utf8').match(/--profile "([^"]+)"/)?.[1]; } catch { return undefined; } })() ?? o.profile;
  rmSync(script, { force: true });
  console.log(`Removed scheduled task ${o.label}${root ? ' and stopped its Chrome' : ''}. The profile stays in ${profile}.`);
}

export async function install(o) {
  if (windows) return installWindows(o);
  if (process.platform !== 'darwin') throw new Error('install sets up a launchd agent (macOS) or a Scheduled Task (Windows); elsewhere, run "shared-chrome-mcp start" from your init system.');
  const args = [process.execPath, CLI, 'start', '--port', String(o.port), '--profile', o.profile, '--chrome', o.chrome];
  if (o.ownerChromeFirst) args.push('--owner-chrome-first');
  const log = `${o.profile}.log`;
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plistPath(o.label), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(a => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`);
  spawnSync('launchctl', ['bootout', `gui/${uid()}/${o.label}`], { stdio: 'ignore' });
  // bootout returns before the old agent has closed its Chrome and exited; bootstrapping meanwhile fails with "5: Input/output error".
  for (let i = 0; i < 60 && loaded(o.label); i++) await sleep(500);
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid()}`, plistPath(o.label)], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('launchctl bootstrap failed');
  for (let i = 0; i < 60 && !(await cdp(o.port)); i++) await sleep(500);
  console.log(`Installed launchd agent ${o.label} (${plistPath(o.label)}), log ${log}`);
  await status(o);
}

export async function uninstall(o) {
  if (windows) return uninstallWindows(o);
  if (process.platform !== 'darwin') throw new Error('uninstall removes the launchd agent (macOS) or the Scheduled Task (Windows); elsewhere, remove it from your init system.');
  spawnSync('launchctl', ['bootout', `gui/${uid()}/${o.label}`], { stdio: 'ignore' });
  rmSync(plistPath(o.label), { force: true });
  console.log(`Removed launchd agent ${o.label}. The profile stays in ${o.profile}.`);
}

export async function status(o) {
  const version = await cdp(o.port);
  const pages = version ? (await cdp(o.port, 'list') ?? []).filter(t => t.type === 'page').length : 0;
  const pid = profilePid(o.profile);
  console.log(version ? `CDP: up on 127.0.0.1:${o.port}, ${version.Browser}, ${pages} pages open` : `CDP: down on 127.0.0.1:${o.port}`);
  console.log(`Profile: ${o.profile} (${pid ? `Chrome ${pid}` : 'no Chrome running on it'})`);
  if (process.platform === 'darwin') console.log(`launchd: ${o.label} ${loaded(o.label) ? 'loaded' : 'not installed'}`);
  if (windows) console.log(`Scheduled Task: ${o.label} ${taskExists(o.label) ? 'registered' : 'not installed'}`);
  if (!version) process.exitCode = 1;
}
