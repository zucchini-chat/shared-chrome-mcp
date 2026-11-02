import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListRootsRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { sessionContext, tabOf } from './session-context.js';
import { waitReady } from './wait-ready.js';

// The same playwright-core copy Playwright MCP runs on, so the pages we hand it are its own kind.
const { chromium } = createRequire(import.meta.resolve('@playwright/mcp'))('playwright-core');

const WAITS_FOR_PAGE = /^browser_(navigate|navigate_back|click|select_option|press_key)$/;
const MAY_LOG_OUT = /^browser_(navigate|click)$/;
const LOGOUT = /\b(log|sign)[\s_-]?(out|off)\b|logout|signout/i;
const PAGE_SECTIONS = /^### (Open tabs|Page|Modal state|WebMCP tools|Snapshot)\n/;
const TIMEOUT = { timeout: 10 * 60 * 1000 };
const SIGNAL_WAIT = 5 * 60 * 1000;

const INSTRUCTIONS = `One always-on, logged-in Chrome shared by every agent on this machine. Your session gets its own window on first use and sees only its own tabs; after navigate, click, back, select or key press the result comes back once the page is ready, with a fresh snapshot, or says plainly that it is not ready. Logins are shared: never log out, and log in yourself when a site asks (a login counts for every agent). Pay only when the human has clearly said to pay for that specific thing. For a step only the human can do (a CAPTCHA, a 2FA code, a final review), browser_hand_over leaves the window open for them; once they say they are done, or the page clearly shows it, browser_take_back gives you the same page back, as they left it. Downloads land in Chrome's download folder (usually ~/Downloads), not in a Playwright download event.`;

const DESCRIPTIONS = {
  browser_close: "Close this session's browser windows. Other agents' windows stay open.",
  browser_tabs: "List, create, close, or select a tab. Only this session's own tabs are visible; a new tab opens as a new window.",
  browser_console_messages: "Always empty: reading the page's console would show sites that the browser is automated.",
};

const HAND_OVER = {
  name: 'browser_hand_over',
  description: "Hand the current page's window to the human, for a step only they can do (a CAPTCHA, a 2FA code, a final review before submit): it comes to the front and stays open after this session ends. This session no longer sees or controls it; the next browser call works in another window of this session or opens a new one. The result has a handle for browser_take_back.",
  inputSchema: { type: 'object', properties: { note: { type: 'string', description: 'What the human should do there; shown at the start of the window title.' } } },
};

const TAKE_BACK = {
  name: 'browser_take_back',
  description: "Take back a window handed over with browser_hand_over: the same tab, as the human left it (a solved CAPTCHA, typed fields), as this session's current tab. Call it only once the human has said they are done there, or pass text to wait until the page shows it. Works from any session that has the handle, also after the one that handed it over has ended.",
  inputSchema: {
    type: 'object',
    properties: {
      handle: { type: 'string', description: 'The handle browser_hand_over returned.' },
      text: { type: 'string', description: `Take it back only once this text shows on the page, e.g. "Payment method added": waits up to ${SIGNAL_WAIT / 60000} minutes without touching the page.` },
    },
    required: ['handle'],
  },
};

const text = result =>result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
const success = message => ({ content: [{ type: 'text', text: `### Result\n${message}` }] });
const failure = message => ({ content: [{ type: 'text', text: `### Error\n${message}` }], isError: true });

export async function serve({ port, version }) {
  const endpoint = `http://127.0.0.1:${port}`;
  let browser, session;

  async function connect() {
    try {
      return await chromium.connectOverCDP(endpoint);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return chromium.connectOverCDP(endpoint).catch(async error => {
        const up = await fetch(`${endpoint}/json/version`).then(r => r.ok, () => false);
        throw new Error(up
          ? `Chrome on ${endpoint} is up, but attaching to it failed twice. Do not restart it: other agents' windows would close. Retry the call; if it keeps failing, tell the human.\n${error.message}`
          : `No Chrome on ${endpoint}. Start the shared Chrome the way this machine's setup does it (with this package's keep-alive: "shared-chrome-mcp start", or "install" on macOS). Do not start a Chrome of your own: one on another profile has none of the logins.`);
      });
    }
  }

  async function ensureSession() {
    if (!browser?.isConnected()) {
      browser = await connect();
      session = sessionContext(browser.contexts()[0]);
    }
    return session;
  }

  const playwright = await createConnection({}, async () => (await ensureSession()).context);

  const server = new Server({ name: 'shared-chrome-mcp', version }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS });
  const client = new Client({ name: 'shared-chrome-mcp', version }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, () =>
    server.getClientCapabilities()?.roots ? server.listRoots() : { roots: [{ uri: pathToFileURL(process.cwd()).href }] });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged());

  const [inner, outer] = InMemoryTransport.createLinkedPair();
  await playwright.connect(outer);
  await client.connect(inner);

  const call = (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { ...TIMEOUT, signal });

  // The page as it is once ready: the action's own sections, a readiness verdict, then a fresh snapshot.
  async function whenReady(result) {
    const check = await call('browser_run_code_unsafe', { code: String(waitReady), _meta: { raw: true } });
    const json = !check.isError && text(check).match(/^\{.*\}$/m);
    const r = json ? JSON.parse(json[0]) : { ready: false, error: text(check) };
    const verdict = r.ready
      ? `### Page readiness\nReady after ${r.ms} ms.`
      : `### Page readiness\nNOT READY: ${r.error ?? `network idle ${r.networkIdle}, DOM quiet ${r.domQuiet}, loading indicators ${r.busyIndicators}, waited ${r.ms} ms`}. Conclude nothing from this page yet; check again with browser_snapshot.`;
    // Same form as the action's own snapshot: Playwright MCP writes an action's snapshot to a file, so refresh that file.
    const file = text(result).match(/^- \[Snapshot\]\((.+)\)$/m)?.[1];
    const fresh = await call('browser_snapshot', file ? { filename: file } : {});
    const kept = text(result).split(/^(?=### )/m).filter(section => !PAGE_SECTIONS.test(section));
    const merged = [...kept, verdict, text(fresh)].map(s => s.trim()).filter(Boolean).join('\n');
    return { ...result, content: [{ type: 'text', text: merged }, ...result.content.filter(part => part.type !== 'text')] };
  }

  // The handle is the tab's CDP target id: the same in every session's connection, for as long as the tab is open.
  async function targetId(page) {
    const cdp = await page.context().newCDPSession(page);
    try { return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; } finally { await cdp.detach().catch(() => {}); }
  }

  async function handOver(note) {
    if (!session?.context.pages().length) return failure('No window to hand over: this session has none open.');
    // Only Playwright MCP knows its current tab: mark that page from inside it, then find it here.
    const marked = await call('browser_run_code_unsafe', { code: 'async page => { page.handedOver = true; }', _meta: { raw: true } });
    const page = session.context.pages().find(p => p.handedOver);
    if (marked.isError || !page) return failure(`Could not hand the window over: ${text(marked)}`);
    delete page.handedOver;
    page.titleNote = note ? `${note} - ` : '';
    await page.bringToFront();
    if (note) await page.evaluate(prefix => { document.title = prefix + document.title; }, page.titleNote);
    await session.handOver(page);
    return success(`Handed over ${page.url()} with handle ${await targetId(page)}: its window is in front and stays open after this session ends. This session no longer sees it. Once the human is done there, browser_take_back with this handle returns it as they left it.`);
  }

  async function takeBack({ handle, text: signal }, abort) {
    await ensureSession();
    const pages = browser.contexts()[0].pages();
    const ids = await Promise.all(pages.map(p => targetId(p).catch(() => null)));
    const page = pages[ids.indexOf(handle)];
    if (!page) return failure(`No window with handle ${handle}: the human may have closed it.`);
    if (signal) {
      const shown = await page.getByText(signal).first().waitFor({ timeout: SIGNAL_WAIT }).then(() => true, () => false);
      if (abort.aborted) return failure('Cancelled: the window is still the human\'s.');
      if (page.isClosed()) return failure('The human closed the window.');
      if (!shown) return failure(`"${signal}" did not show within ${SIGNAL_WAIT / 60000} minutes: the window is still the human's. Ask them, or call again to keep waiting.`);
    }
    // Known only to the session that handed it over; a page that has changed its title since has no note to remove.
    if (page.titleNote) await page.evaluate(prefix => { if (document.title.startsWith(prefix)) document.title = document.title.slice(prefix.length); }, page.titleNote);
    session.takeBack(page);
    // Playwright MCP picks the page up as a tab (list also starts it in a fresh session), then makes it current
    // by its index in Playwright MCP's own tab list, which also has the tabs of isolated contexts.
    // Selecting raises a window; this one stays where it is, under whatever the human went back to.
    await call('browser_tabs', { action: 'list' });
    const tab = tabOf(page);
    page.bringToFront = async () => {};
    const selected = await call('browser_tabs', { action: 'select', index: tab.context.tabs().indexOf(tab) }).finally(() => delete page.bringToFront);
    if (selected.isError) return selected;
    const snapshot = await call('browser_snapshot', {});
    return success(`Took back ${page.url()}: it is this session's current tab.\n${text(snapshot)}`);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await client.listTools();
    return { tools: [...tools.map(tool => DESCRIPTIONS[tool.name] ? { ...tool, description: DESCRIPTIONS[tool.name] } : tool), HAND_OVER, TAKE_BACK] };
  });

  server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args = {} } }, { signal }) => {
    if (name === HAND_OVER.name) return handOver(args.note);
    if (name === TAKE_BACK.name) return takeBack(args, signal).catch(error => failure(error.message));
    // Playwright MCP opens a window to list none; with nothing open there is nothing to list.
    if (name === 'browser_tabs' && args.action === 'list' && !session?.context.pages().length)
      return success('No open tabs in this session.');
    if (MAY_LOG_OUT.test(name) && LOGOUT.test(JSON.stringify(args)))
      return failure("Refused: this looks like logging out. Every agent shares this browser's logins, so a logout here logs all of them out. If it really has to happen, ask the human to do it.");
    const result = await call(name, args, signal);
    if (name === 'browser_close') await session?.close();
    // An open dialog or file chooser blocks every other tool: hand it back as is, for the caller to deal with.
    const settles = WAITS_FOR_PAGE.test(name) && !result.isError && !/^### Modal state$/m.test(text(result));
    return settles ? whenReady(result) : result;
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await session?.close();
    process.exit(0);
  };
  server.onclose = shutdown;
  process.stdin.on('end', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await server.connect(new StdioServerTransport());
}
