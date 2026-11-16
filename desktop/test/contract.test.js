// The IPC contract: every channel has a validator, and only the app's own main
// frame may send.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CHANNELS, channelsOfKind, senderAllowed, validatePayload } from '../ipc/contract.js';
import { ACTION_IDS, MENU_COMMANDS } from '../shared/actions.js';

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(DESKTOP, file), 'utf8');

describe('the channel table', () => {
  it('gives every channel a kind and a validator', () => {
    for (const [name, spec] of Object.entries(CHANNELS)) {
      expect(['invoke', 'send', 'event'], name).toContain(spec.kind);
      expect(typeof spec.validate, name).toBe('function');
      expect(name).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });

  it('keeps the self-test channels out of a normal run', () => {
    const normal = [...channelsOfKind('invoke'), ...channelsOfKind('send'), ...channelsOfKind('event')];
    expect(normal.some((name) => name.startsWith('selftest:'))).toBe(false);
    expect(channelsOfKind('invoke', { selftest: true })).toContain('selftest:input');
    expect(normal.sort()).toEqual(['film:open', 'log:write', 'menu:action', 'mic:arm', 'notify:show', 'reader:busy', 'report:result', 'report:save', 'sample:open', 'ui:state']);
  });

  it('is the only source of channel names: the page and the main process spell none out of it', () => {
    const known = new Set(Object.keys(CHANNELS));
    const used = new Set();
    for (const file of ['renderer/app.js', 'renderer/selftest.js', 'main/index.js', 'main/selftest.js']) {
      for (const match of read(file).matchAll(/['"`]((?:sample|film|notify|report|log|ui|menu|reader|mic|selftest):[a-z]+)['"`]/g)) used.add(match[1]);
    }
    for (const name of used) expect(known.has(name), name).toBe(true);
    // Every page-to-main channel has a handler in the main process.
    const main = read('main/index.js') + read('main/selftest.js');
    for (const name of [...channelsOfKind('invoke', { selftest: true }), ...channelsOfKind('send', { selftest: true })]) {
      expect(main.includes(`'${name}'`), name).toBe(true);
    }
  });
});

describe('validatePayload', () => {
  it('rejects a channel that is not in the table', () => {
    expect(validatePayload('fs:read', { path: '/etc/passwd' })).toMatchObject({ ok: false });
    expect(validatePayload('__proto__', {})).toMatchObject({ ok: false });
    expect(validatePayload('toString', undefined)).toMatchObject({ ok: false });
  });

  it('takes no payload where none is expected', () => {
    for (const channel of ['sample:open', 'film:open', 'report:save']) {
      expect(validatePayload(channel, undefined)).toEqual({ ok: true, value: undefined });
      expect(validatePayload(channel, null).ok).toBe(true);
      expect(validatePayload(channel, { path: '/Users/me/film.mkv' }).ok).toBe(false);
      expect(validatePayload(channel, 'x').ok).toBe(false);
    }
  });

  it('accepts a notification with a short title and body, and nothing else', () => {
    expect(validatePayload('notify:show', { title: 'Test', body: 'A test notification.' })).toEqual({ ok: true, value: { title: 'Test', body: 'A test notification.' } });
    expect(validatePayload('notify:show', { title: 'Test' }).ok).toBe(false);
    expect(validatePayload('notify:show', { title: '', body: 'x' }).ok).toBe(false);
    expect(validatePayload('notify:show', { title: 'T', body: 'x'.repeat(241) }).ok).toBe(false);
    expect(validatePayload('notify:show', { title: 'T', body: 'x', icon: '/tmp/a.png' }).ok).toBe(false);
    expect(validatePayload('notify:show', { title: 5, body: 'x' }).ok).toBe(false);
    expect(validatePayload('notify:show', ['T', 'x']).ok).toBe(false);
    expect(validatePayload('notify:show', null).ok).toBe(false);
  });

  it('accepts one log line without line breaks', () => {
    expect(validatePayload('log:write', { line: 'action who via key' }).ok).toBe(true);
    expect(validatePayload('log:write', { line: 'two\nlines' }).ok).toBe(false);
    expect(validatePayload('log:write', { line: 'x'.repeat(301) }).ok).toBe(false);
    expect(validatePayload('log:write', { line: '' }).ok).toBe(false);
    expect(validatePayload('log:write', 'action').ok).toBe(false);
  });

  it('accepts the interface state with both fields of the right type', () => {
    expect(validatePayload('ui:state', { modal: false, channel: 'reader' }).ok).toBe(true);
    expect(validatePayload('ui:state', { modal: 'no', channel: 'app' }).ok).toBe(false);
    expect(validatePayload('ui:state', { modal: true, channel: 'loud' }).ok).toBe(false);
    expect(validatePayload('ui:state', { modal: true }).ok).toBe(false);
  });

  it('lets the menu send every listening action and menu command, and nothing else', () => {
    for (const action of [...ACTION_IDS, ...MENU_COMMANDS]) {
      expect(validatePayload('menu:action', { action }).ok, action).toBe(true);
    }
    expect(validatePayload('menu:action', { action: 'quit' }).ok).toBe(false);
    expect(validatePayload('reader:busy', { cause: 'menu', open: true }).ok).toBe(true);
    expect(validatePayload('reader:busy', { cause: 'menu', open: false }).ok).toBe(true);
    // The native Open and Save dialogs silence the page's voice the same way.
    expect(validatePayload('reader:busy', { cause: 'dialog', open: true }).ok).toBe(true);
    expect(validatePayload('reader:busy', { cause: 'dialog', open: false }).ok).toBe(true);
    expect(validatePayload('reader:busy', { cause: 'menu' }).ok).toBe(false);
    expect(validatePayload('reader:busy', { cause: 'earthquake', open: true }).ok).toBe(false);
  });

  it('lets the main process say how saving the report went, and nothing about where', () => {
    expect(validatePayload('report:result', { saved: true, reason: '' }).ok).toBe(true);
    expect(validatePayload('report:result', { saved: false, reason: 'EACCES' }).ok).toBe(true);
    expect(validatePayload('report:result', { saved: true }).ok).toBe(false);
    expect(validatePayload('report:result', { saved: true, reason: '', path: '/Users/me/report.txt' }).ok).toBe(false);
    expect(CHANNELS['report:result'].kind).toBe('event');
  });

  it('returns a copy holding only the declared fields', () => {
    const payload = { title: 'T', body: 'B' };
    const result = validatePayload('notify:show', payload);
    expect(result.value).not.toBe(payload);
    expect(Object.keys(result.value)).toEqual(['title', 'body']);
  });

  it('rejects objects that are not plain', () => {
    class Sneaky {
      constructor() {
        this.line = 'x';
      }
    }
    expect(validatePayload('log:write', new Sneaky()).ok).toBe(false);
    expect(validatePayload('log:write', Object.assign(Object.create(null), { line: 'x' })).ok).toBe(true);
  });

  it('checks the self-test channels too', () => {
    expect(validatePayload('selftest:input', { keyCode: 'Tab' }).ok).toBe(true);
    expect(validatePayload('selftest:input', { keyCode: 'Tab', modifiers: ['shift'] }).ok).toBe(true);
    expect(validatePayload('selftest:input', { keyCode: 'Tab', modifiers: ['hyper'] }).ok).toBe(false);
    expect(validatePayload('selftest:dialog', { ms: 900 }).ok).toBe(true);
    expect(validatePayload('selftest:dialog', { ms: 60_000 }).ok).toBe(false);
    expect(validatePayload('selftest:zoom', { factor: 2 }).ok).toBe(true);
    expect(validatePayload('selftest:zoom', { factor: 20 }).ok).toBe(false);
    expect(validatePayload('selftest:emulate', { forcedColors: true }).ok).toBe(true);
    expect(validatePayload('selftest:emulate', { forcedColors: 'yes' }).ok).toBe(false);
    expect(validatePayload('selftest:done', { checks: [{ name: 'a', ok: true, detail: '' }], axe: { ran: true, violations: 0, incomplete: 1, passes: 30, detail: '' }, info: '' }).ok).toBe(true);
    expect(validatePayload('selftest:done', { checks: [{ name: 'a', ok: 'yes', detail: '' }], axe: { ran: true, violations: 0, incomplete: 1, passes: 30, detail: '' }, info: '' }).ok).toBe(false);
  });
});

describe('the self-test\'s report', () => {
  it('gives every check a name that fits the contract, so none arrives cut off', () => {
    const source = read('renderer/selftest.js');
    const names = [...source.matchAll(/\bcheck\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    expect(names.length).toBeGreaterThan(40);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.length, name).toBeLessThanOrEqual(60);
      expect(validatePayload('selftest:done', { checks: [{ name, ok: true, detail: '' }], axe: { ran: false, violations: 0, incomplete: 0, passes: 0, detail: '' }, info: '' }).ok, name).toBe(true);
    }
  });
});

describe('senderAllowed', () => {
  const own = { url: 'app://scenevoice/renderer/index.html', isMainFrame: true, isAppWindow: true };

  it('accepts the main frame of the app window showing the app page', () => {
    expect(senderAllowed(own)).toBe(true);
  });

  it('rejects a sub-frame, another window, and any other page', () => {
    expect(senderAllowed({ ...own, isMainFrame: false })).toBe(false);
    expect(senderAllowed({ ...own, isAppWindow: false })).toBe(false);
    expect(senderAllowed({ ...own, url: 'https://example.com/' })).toBe(false);
    expect(senderAllowed({ ...own, url: 'file:///Users/me/index.html' })).toBe(false);
    expect(senderAllowed({ ...own, url: 'app://evil/renderer/index.html' })).toBe(false);
    expect(senderAllowed({ ...own, url: 'svmedia://media/abc' })).toBe(false);
    expect(senderAllowed({ ...own, url: '' })).toBe(false);
    expect(senderAllowed({ ...own, url: undefined })).toBe(false);
    expect(senderAllowed(null)).toBe(false);
    expect(senderAllowed({ url: own.url })).toBe(false);
  });
});

describe('the preload bridge', () => {
  const preload = read('main/preload.cjs');

  it('is CommonJS and requires nothing but electron', () => {
    const required = [...preload.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(required).toEqual(['electron']);
    expect(preload).not.toMatch(/^\s*import\s/m);
  });

  it('exposes one object and refuses channels it was not given', () => {
    expect(preload.match(/exposeInMainWorld/g)).toHaveLength(1);
    expect(preload).toContain('invokes.has(channel)');
    expect(preload).toContain('sends.has(channel)');
    expect(preload).toContain('events.has(channel)');
    // The page never gets the ipcRenderer object or an event from it.
    expect(preload).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/);
  });
});
