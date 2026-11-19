// Which processes --owner-chrome-first takes for the owner's everyday Chrome. Starts no Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { isOwnerChrome } from '../lib/chrome.js';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('the owner Chrome, as the Dock starts it and as it relaunches itself', () => {
  assert.ok(isOwnerChrome(chrome));
  assert.ok(isOwnerChrome(`${chrome} --user-data-dir=${homedir()}/Library/Application Support/Google/Chrome`));
});

test('not a headless Chrome, a shared Chrome or a launcher', () => {
  assert.ok(!isOwnerChrome(`${chrome} --headless=new --remote-debugging-pipe`));
  assert.ok(!isOwnerChrome(`${chrome} --headless=new --dump-dom about:blank`));
  assert.ok(!isOwnerChrome(`${chrome} --user-data-dir=${homedir()}/.chrome-agents --remote-debugging-port=9223 about:blank`));
  assert.ok(!isOwnerChrome(`/usr/local/bin/node cli.js start --port 9223 --chrome ${chrome} --owner-chrome-first`));
});
