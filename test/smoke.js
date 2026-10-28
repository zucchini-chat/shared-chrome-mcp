// Smoke test: a throwaway Chrome on a test port, two MCP sessions at once, then shut down only what it started.
// Usage: npm run smoke (port 9333 unless SMOKE_PORT is set).
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const { chromium } = createRequire(import.meta.resolve('@playwright/mcp'))('playwright-core');
const PORT = Number(process.env.SMOKE_PORT ?? 9333);
if (PORT === 9222) throw new Error('Refusing to test on 9222: that is where a real shared Chrome usually runs.');
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'shared-chrome-mcp-smoke-'));
const profile = join(work, 'profile');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const PAGES = {
  // Content arrives 1.5 s after load, behind a visible spinner: only a real readiness wait sees it.
  '/slow': `<title>slow</title><div class="loading">Loading...</div><script>
    setTimeout(async () => { document.body.innerHTML = '<h1>' + await (await fetch('/data')).text() + '</h1>'; }, 1500);</script>`,
  // The DOM never stops changing: must come back NOT READY.
  '/busy': `<title>busy</title><p id="n">0</p><script>setInterval(() => n.textContent++, 100);</script>`,
  '/plain': `<title>plain</title><h1>Plain page</h1><a href="/popup-target" target="_blank">Open popup</a>`,
  '/popup-target': `<title>popup</title><h1>Popup page</h1>`,
  '/dialog': `<title>dialog</title><button onclick="alert('hi')">Say hi</button>`,
};
const site = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/data') { await sleep(500); return res.end('Loaded late'); }
  res.setHeader('content-type', 'text/html');
  res.end(PAGES[path] ?? 'not found');
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${site.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${ok ? detail.slice(0, 120) : detail}` : ''}`); };
const text = r => r.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
// Playwright MCP writes an action's snapshot to a file, relative to the server's cwd, and links it.
const snapshot = (r, session) => { const file = text(r).match(/^- \[Snapshot\]\((.+)\)$/m)?.[1]; return file ? readFileSync(join(work, session, file), 'utf8') : text(r); };

const chrome = spawn(process.execPath, [CLI, 'start', '--port', String(PORT), '--profile', profile], { stdio: ['ignore', 'inherit', 'inherit'] });
let observer;
const sessions = [];

try {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
    await sleep(500);
  }
  observer = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = observer.contexts()[0];
  context.on('dialog', () => {}); // or this observer would dismiss the sessions' dialogs
  const pageAt = url => context.pages().find(p => p.url() === url);
  const windowOf = async page => (await (await context.newCDPSession(page)).send('Browser.getWindowForTarget')).windowId;

  const connect = async (name, port = PORT) => {
    const client = new Client({ name, version: '0' });
    mkdirSync(join(work, name)); // a project folder of its own, as agents usually have
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, '--port', String(port)], cwd: join(work, name), stderr: 'inherit' }));
    sessions.push(client);
    return client;
  };
  const [a, b] = await Promise.all([connect('agent-a'), connect('agent-b')]);
  const call = (client, name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });

  const started = Date.now();
  const [navA, navB] = await Promise.all([
    call(a, 'browser_navigate', { url: `${base}/slow` }),
    call(b, 'browser_navigate', { url: `${base}/plain` }),
  ]);
  console.log(`both navigations took ${Date.now() - started} ms`);

  const slow = pageAt(`${base}/slow`), plain = pageAt(`${base}/plain`);
  const [winA, winB, winFirst] = await Promise.all([windowOf(slow), windowOf(plain), windowOf(context.pages()[0])]);
  check('each session got its own window', winA !== winB && winA !== winFirst && winB !== winFirst, `windows ${winA}, ${winB}, Chrome's first window ${winFirst}`);
  const hidden = await Promise.all([slow, plain].map(p => p.evaluate(() => document.hidden)));
  check('both pages report document.hidden === false', hidden.every(h => h === false), `hidden: ${hidden}`);
  const viaMcp = await Promise.all([a, b].map(c => call(c, 'browser_evaluate', { function: '() => location.pathname + " hidden=" + document.hidden' })));
  check('each session evaluates in its own page', text(viaMcp[0]).includes('/slow hidden=false') && text(viaMcp[1]).includes('/plain hidden=false'));

  check('readiness wait: navigate returns the late content', /Ready after \d+ ms/.test(text(navA)) && snapshot(navA, 'agent-a').includes('Loaded late') && !snapshot(navA, 'agent-a').includes('Loading...'),
    text(navA).match(/### Page readiness\n.*/)?.[0].replace('\n', ' '));
  check('readiness wait: a quick page is ready too', /Ready after/.test(text(navB)));

  const tabsA = text(await call(a, 'browser_tabs', { action: 'list' }));
  check('a session lists only its own tabs', tabsA.includes('/slow') && !tabsA.includes('/plain') && !tabsA.includes('about:blank'), tabsA.replace(/\n/g, ' | ').slice(0, 200));

  const ref = snapshot(navB, 'agent-b').match(/link "Open popup" \[ref=(\w+)\]/)?.[1];
  const clicked = await call(b, 'browser_click', { element: 'Open popup link', target: ref });
  const tabsB = text(await call(b, 'browser_tabs', { action: 'list' }));
  check('a popup opened from a session page joins that session', tabsB.includes('/popup-target') && tabsB.includes('/plain') && !clicked.isError,
    `ref ${ref}; ${tabsB.replace(/\n/g, ' | ').slice(0, 200)}; click: ${text(clicked).replace(/\n/g, ' | ').slice(0, 400)}`);
  // macOS lists a backgrounded process at scheduling priority 4. Under load such a renderer acks a click seconds late and the click times out.
  const backgrounded = process.platform !== 'darwin' ? [] : execFileSync('ps', ['-axo', 'pri=,command='], { encoding: 'utf8' })
    .split('\n').filter(line => line.includes(profile) && line.includes('--type=renderer') && /^\s*4\s/.test(line));
  check('no renderer is backgrounded, not even the page under its popup tab', !backgrounded.length, `${backgrounded.length} at background priority`);

  const dialogPage = await call(a, 'browser_navigate', { url: `${base}/dialog` });
  const button = snapshot(dialogPage, 'agent-a').match(/button "Say hi" \[ref=(\w+)\]/)?.[1];
  const opened = await call(a, 'browser_click', { element: 'Say hi button', target: button });
  const accepted = await call(a, 'browser_handle_dialog', { accept: true });
  check('a click that opens a dialog returns the dialog, no readiness wait', text(opened).includes('### Modal state') && !text(opened).includes('Page readiness') && !accepted.isError,
    `${text(opened).replace(/\n/g, ' | ').slice(0, 300)} || accept: ${text(accepted).slice(0, 100)}`);

  const busy = await call(a, 'browser_navigate', { url: `${base}/busy` });
  check('a page that never settles comes back NOT READY', text(busy).includes('NOT READY'), text(busy).match(/NOT READY.*/)?.[0].slice(0, 120));

  const logout = await call(b, 'browser_click', { element: 'Sign out button', target: 'e1' });
  check('logging out is refused', logout.isError && text(logout).includes('Refused'));

  await call(a, 'browser_tabs', { action: 'new' });
  await call(a, 'browser_navigate', { url: `${base}/plain?handover` });
  const handed = await call(a, 'browser_hand_over', { note: 'Solve the captcha' });
  const tabsAfter = text(await call(a, 'browser_tabs', { action: 'list' }));
  const handedTitle = await pageAt(`${base}/plain?handover`)?.title();
  check('a handed-over window leaves the session, titled with the note', !handed.isError && !tabsAfter.includes('handover') && tabsAfter.includes('/busy') && handedTitle === 'Solve the captcha - plain',
    `${text(handed).slice(0, 150)} | title ${handedTitle} | tabs ${tabsAfter.replace(/\n/g, ' | ').slice(0, 200)}`);

  await a.close();
  for (let i = 0; i < 40 && pageAt(`${base}/busy`); i++) await sleep(250);
  check('closing session A closes its window', !pageAt(`${base}/busy`));
  check('the handed-over window outlives session A', !!pageAt(`${base}/plain?handover`));
  const stillB = await call(b, 'browser_evaluate', { function: '() => location.pathname' });
  check('session B is intact after A closed', !stillB.isError && !!pageAt(`${base}/plain`), text(stillB).match(/### Result\n.*/)?.[0].replace('\n', ' '));

  const closed = await call(b, 'browser_close');
  const reopened = await call(b, 'browser_navigate', { url: `${base}/plain?reopened` });
  const tabsReopened = text(await call(b, 'browser_tabs', { action: 'list' }));
  const blanks = context.pages().filter(p => p.url().startsWith('about:blank#')).length;
  check('after browser_close the next navigate opens a fresh window, no stray tabs',
    !closed.isError && /Ready after/.test(text(reopened)) && !pageAt(`${base}/plain`) && !!pageAt(`${base}/plain?reopened`) && tabsReopened.match(/^- \d+:/gm)?.length === 1 && !blanks,
    `${text(reopened).match(/### (Error|Page readiness)\n.*/)?.[0].replace('\n', ' ')} | blank windows ${blanks} | tabs ${tabsReopened.replace(/\n/g, ' | ').slice(0, 200)}`);

  const d = await connect('agent-d');
  const before = context.pages().length;
  const empty = await call(d, 'browser_tabs', { action: 'list' });
  check('listing tabs with none open opens nothing', text(empty).includes('No open tabs') && context.pages().length === before, text(empty).replace(/\n/g, ' | '));

  const nowhere = await connect('agent-c', PORT + 1);
  const down = await call(nowhere, 'browser_navigate', { url: `${base}/plain` });
  check('without Chrome a call says so plainly', down.isError && text(down).includes('No Chrome on'), text(down).match(/No Chrome on.*/)?.[0].slice(0, 80));
} catch (error) {
  check('smoke test ran to the end', false, error.stack);
} finally {
  await Promise.all(sessions.map(s => s.close().catch(() => {})));
  await observer?.close().catch(() => {});
  const exited = new Promise(resolve => chrome.once('exit', resolve));
  // Killing a Windows process from outside gives it no chance to run its own SIGTERM handler, so
  // "start" never gets to close the Chrome it launched: taskkill /T stops the whole tree directly.
  if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F']); } catch {} }
  else chrome.kill('SIGTERM');
  await Promise.race([exited, sleep(15000)]);
  site.close();
  // Windows Defender scans a freshly closed Chrome profile for a while; each touch while it's scanning
  // seems to restart the scan (rmSync's own maxRetries/retryDelay still touches it between tries and
  // reliably failed here), so this waits it out mostly untouched between tries instead.
  for (const delay of [0, 5000, 10000, 20000, 30000]) {
    await sleep(delay);
    try { rmSync(work, { recursive: true, force: true }); break; } catch (error) { if (delay === 30000) throw error; }
  }
}

const failed = results.filter(ok => !ok).length;
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
