import { EventEmitter } from 'node:events';

// The shared Chrome's one context, narrowed to the pages this MCP session owns: the windows it
// opened and the popups those pages opened. Playwright MCP sees nothing else, so it never lands in
// another agent's tab, and its "new page" opens a window of its own.
export function sessionContext(context) {
  const owned = new Set();
  const events = new EventEmitter();

  const adopt = page => {
    owned.add(page);
    page.once('close', () => owned.delete(page));
    events.emit('page', page);
    return page;
  };

  context.on('page', async page => {
    if (owned.has(await page.opener())) adopt(page);
  });

  // Playwright dismisses any dialog nobody listens for, so without this every session would close the
  // alerts and confirms in other agents' windows. The owner's Playwright MCP tab handles its own.
  context.on('dialog', () => {});

  // A window, not a tab: a background tab reports document.hidden, gets throttled and is flagged by bot checks.
  // Unfocused, so it opens behind whatever the owner is working in instead of on top of it; the page still reports visible.
  const newWindow = async () => {
    const url = 'about:blank#' + Math.random().toString(36).slice(2, 10);
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Target.createTarget', { url, newWindow: true, focus: false });
    await cdp.detach();
    for (let i = 0; i < 100; i++) {
      const page = context.pages().find(p => p.url() === url);
      if (page) return adopt(page);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The new window did not show up in Chrome.');
  };

  const listen = method => (event, listener) => {
    (event === 'page' || event === 'close' ? events : context)[method](event, listener);
    return proxy;
  };
  const overrides = {
    pages: () => [...owned],
    newPage: newWindow,
    on: listen('on'),
    once: listen('once'),
    addListener: listen('addListener'),
    off: listen('off'),
    removeListener: listen('removeListener'),
  };
  const proxy = new Proxy(context, {
    get(target, key) {
      if (key in overrides) return overrides[key];
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    context: proxy,
    // browser_close leaves Playwright MCP deaf to new pages until its context emits 'close'; the
    // shared one never does, so the session's does, and the next call starts afresh.
    close: async () => {
      await Promise.all([...owned].map(page => page.close().catch(() => {})));
      events.emit('close');
    },
    // The page stays open but leaves the session. Playwright MCP drops a tab when its page emits
    // 'close', so the page says so without closing.
    handOver: page => {
      owned.delete(page);
      page.emit('close', page);
    },
    takeBack: page => owned.has(page) || adopt(page),
  };
}
