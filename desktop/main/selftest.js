// The main-process half of the self-test (`npm run selftest`, that is
// `electron . --selftest`). The page runs its own checks (renderer/selftest.js)
// and reports them; this half lets the page press real keys and choose menu
// items, reads the accessibility tree Chromium gives to screen readers, adds
// the checks only the main process can make (window settings, the two schemes,
// the report), prints ONE line of JSON on standard output and exits: 0 when
// every check passed, 1 otherwise.
//
// What it cannot do: run a screen reader. It shows that the shell hands
// assistive technology the right things, not what 争渡, 保益 or NVDA make of them.

import { app, Menu, nativeTheme, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ACTIONS } from '../shared/actions.js';
import { CSP, START_URL, mediaUrl } from './apppath.js';
import { actionItemId } from './menu.js';
import { probeFile } from './probe.js';

const TIMEOUT_MS = 180_000;

/** A summary of the accessibility tree: what a screen reader is given. */
async function accessibilitySummary(win) {
  const dbg = win.webContents.debugger;
  const attachedHere = !dbg.isAttached();
  if (attachedHere) dbg.attach('1.3');
  try {
    await dbg.sendCommand('Accessibility.enable');
    const { nodes } = await dbg.sendCommand('Accessibility.getFullAXTree');
    const shown = nodes.filter((n) => !n.ignored);
    const role = (n) => (n.role && n.role.value) || '';
    const name = (n) => String((n.name && n.name.value) || '').trim();
    const property = (n, key) => {
      const hit = (n.properties || []).find((p) => p.name === key);
      return hit && hit.value ? hit.value.value : undefined;
    };
    const buttons = shown.filter((n) => role(n) === 'button');
    const focused = shown.find((n) => property(n, 'focused') === true && role(n) !== 'RootWebArea');
    const count = (r) => shown.filter((n) => role(n) === r).length;
    return {
      buttons: buttons.length,
      unnamedButtons: buttons.filter((n) => !name(n)).length,
      buttonNames: buttons.map(name),
      status: count('status'),
      log: count('log'),
      application: count('application'),
      applicationName: name(shown.find((n) => role(n) === 'application') || {}),
      dialog: count('dialog'),
      dialogName: name(shown.find((n) => role(n) === 'dialog') || {}),
      focusedRole: focused ? role(focused) : '',
      focusedName: focused ? name(focused) : '',
      focusedLevel: focused ? property(focused, 'level') ?? null : null,
    };
  } finally {
    if (attachedHere) dbg.detach();
  }
}

/**
 * @param {object} o
 * @param {string} o.root     desktop/
 * @param {string} o.sample   the sample clip, or '' in a build without it
 * @param {string} [o.film]   a film the self-test opens instead of the sample, or ''
 * @param {import('./media.js').MediaRegistry} o.registry
 * @param {() => Electron.BrowserWindow|null} o.getWindow
 * @param {(show: () => Promise<any>) => Promise<any>} o.showNativeDialog  what the main process shows native dialogs with
 * @param {() => string} o.reportText
 * @param {() => string} o.language
 * @returns {{files: Record<string, string>, handlers: Record<string, Function>}}
 */
export function startSelftest({ root, sample, film = '', registry, getWindow, showNativeDialog, reportText, language }) {
  const axe = path.join(root, 'node_modules', 'axe-core', 'axe.min.js');
  const files = fs.existsSync(axe) ? { '/selftest/axe.min.js': axe } : {};
  let finished = false;

  const print = (result) => {
    if (finished) return;
    finished = true;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    // Let the line reach a pipe before the process goes.
    setTimeout(() => app.exit(result.ok ? 0 : 1), 200);
  };

  const fail = (reason) =>
    print({ selftest: 'scenevoice-desktop', ok: false, failed: [reason], checks: {}, electron: process.versions.electron });

  const timer = setTimeout(() => fail('timeout: the page did not report within 180 seconds'), TIMEOUT_MS);
  app.on('quit', () => {
    try {
      fs.rmSync(app.getPath('userData'), { recursive: true, force: true });
    } catch {
      // A temporary folder left behind is harmless.
    }
  });

  /** What the main process could not check, and why: added to the page's notes. */
  const notes = [];

  async function mainChecks() {
    const win = getWindow();
    const checks = [];
    // Any file will do for byte ranges: the clip, else the film the self-test was given.
    const media = sample || film;
    const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail) });
    const attempt = async (name, fn) => {
      try {
        await fn();
      } catch (err) {
        add(name, false, `threw: ${err && err.message}`);
      }
    };

    await attempt('window settings', () => {
      const prefs = win.webContents.getLastWebPreferences();
      const throttling = win.webContents.getBackgroundThrottling();
      const ok = prefs.contextIsolation === true && prefs.sandbox === true && prefs.nodeIntegration === false && throttling === false;
      add('window settings', ok, `contextIsolation ${prefs.contextIsolation}, sandbox ${prefs.sandbox}, nodeIntegration ${prefs.nodeIntegration}, backgroundThrottling ${throttling}`);
    });

    await attempt('accessibility support enabled', () => {
      add('accessibility support enabled', app.isAccessibilitySupportEnabled() === true);
    });

    await attempt('the window is shown', () => {
      add('the window is shown', win.isVisible() === true);
    });

    await attempt('page comes from the app scheme', () => {
      const url = win.webContents.getURL();
      add('page comes from the app scheme', url === START_URL, url);
    });

    await attempt('content security policy header', async () => {
      const response = await session.defaultSession.fetch(START_URL);
      const header = response.headers.get('content-security-policy') || '';
      add('content security policy header', response.status === 200 && header === CSP && header.includes("connect-src 'none'"), header);
    });

    await attempt('app scheme serves only the page files', async () => {
      const outside = [
        'app://scenevoice/main/index.js',
        'app://scenevoice/renderer/%2e%2e/main/index.js',
        'app://scenevoice/renderer/..%2Fmain%2Findex.js',
        'app://scenevoice/package.json',
        'app://scenevoice/renderer/sample/sample.mp4',
      ];
      const statuses = [];
      for (const url of outside) statuses.push((await session.defaultSession.fetch(url)).status);
      add('app scheme serves only the page files', statuses.every((s) => s === 404), statuses.join(' '));
    });

    await attempt('media scheme serves a byte range', async () => {
      if (!media) {
        notes.push('no sample clip and no film: the media scheme was not exercised');
        return;
      }
      const token = await registry.open('sample', media);
      const size = fs.statSync(media).size;
      const url = mediaUrl(token);
      const response = await session.defaultSession.fetch(url, { headers: { Range: 'bytes=1000-1999' } });
      const body = Buffer.from(await response.arrayBuffer());
      const expected = Buffer.alloc(1000);
      const fd = fs.openSync(media, 'r');
      fs.readSync(fd, expected, 0, 1000, 1000);
      fs.closeSync(fd);
      const ok = response.status === 206 && response.headers.get('content-range') === `bytes 1000-1999/${size}` && body.equals(expected);
      add('media scheme serves a byte range', ok, `status ${response.status}, ${response.headers.get('content-range')}, ${body.length} bytes`);

      const tail = await session.defaultSession.fetch(url, { headers: { Range: 'bytes=-500' } });
      const tailBody = Buffer.from(await tail.arrayBuffer());
      add('media scheme serves the last bytes', tail.status === 206 && tailBody.length === 500 && tail.headers.get('content-range') === `bytes ${size - 500}-${size - 1}/${size}`, `status ${tail.status}, ${tail.headers.get('content-range')}`);

      const beyond = await session.defaultSession.fetch(url, { headers: { Range: `bytes=${size + 10}-` } });
      const unknown = await session.defaultSession.fetch(mediaUrl('0'.repeat(32)));
      add('media scheme refuses what it does not hold', beyond.status === 416 && unknown.status === 404, `beyond the end ${beyond.status}, unknown token ${unknown.status}`);
    });

    if (film) {
      await attempt('media scheme serves a range far into the film', async () => {
        // The page has finished by now: a new token for the film does not disturb it.
        const token = await registry.open('film', film);
        const size = fs.statSync(film).size;
        const start = Math.max(0, size - 4096);
        const started = Date.now();
        const response = await session.defaultSession.fetch(mediaUrl(token), { headers: { Range: `bytes=${start}-` } });
        const body = Buffer.from(await response.arrayBuffer());
        const expected = Buffer.alloc(size - start);
        const fd = fs.openSync(film, 'r');
        fs.readSync(fd, expected, 0, expected.length, start);
        fs.closeSync(fd);
        const ok = response.status === 206 && response.headers.get('content-range') === `bytes ${start}-${size - 1}/${size}` && body.equals(expected);
        add('media scheme serves a range far into the film', ok, `film of ${(size / 1024 ** 2).toFixed(0)} MB, status ${response.status}, ${body.length} bytes in ${Date.now() - started} ms`);
      });
    }

    await attempt('network is blocked for the session', async () => {
      let outcome = 'answered';
      try {
        await session.defaultSession.fetch('https://scenevoice.invalid/');
      } catch (err) {
        outcome = String(err && err.message);
      }
      add('network is blocked for the session', outcome.includes('ERR_BLOCKED_BY_CLIENT'), outcome);
    });

    await attempt('menu has every action with its accelerator', () => {
      const menu = Menu.getApplicationMenu();
      const missing = [];
      for (const action of ACTIONS) {
        const item = menu && menu.getMenuItemById(actionItemId(action.id));
        if (!item || item.accelerator !== action.accelerator || !item.label) missing.push(action.id);
      }
      add('menu has every action with its accelerator', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${ACTIONS.length} items, language ${language()}`);
    });

    await attempt('Electron understands every accelerator', () => {
      // An accelerator Electron cannot read becomes a menu item without a key, silently. What the
      // menu would show for each item is asked through a method Electron keeps for its own tests.
      const menu = Menu.getApplicationMenu();
      const shown = [];
      const bad = [];
      let asked = true;
      for (const top of menu ? menu.items : []) {
        const submenu = top.submenu;
        if (!submenu) continue;
        submenu.items.forEach((item, index) => {
          if (!item.accelerator) return;
          if (typeof submenu._getAcceleratorTextAt !== 'function') {
            asked = false;
            return;
          }
          const text = String(submenu._getAcceleratorTextAt(index) || '');
          shown.push(text);
          // A key it did not understand leaves the modifiers alone: "Ctrl+Alt+" (the plus key itself gives "Ctrl++").
          if (!text || (text.endsWith('+') && !text.endsWith('++'))) bad.push(`${item.accelerator} -> "${text}"`);
        });
      }
      const detail = !asked ? 'not checked: this Electron has no way to ask' : bad.length ? bad.join(', ') : shown.join(' ');
      add('Electron understands every accelerator', bad.length === 0 && (!asked || shown.length >= ACTIONS.length), detail);
    });

    await attempt('codec names of the sample', async () => {
      if (!sample) return;
      const probed = await probeFile(sample);
      const text = `${probed.container}; ${probed.codecs.join(', ')}`;
      add('codec names of the sample', /^MP4/.test(probed.container) && /H\.264/.test(text) && /AAC/.test(text), text);
    });

    await attempt('diagnostic report', () => {
      const text = reportText();
      const leaks = [os.homedir(), root, sample && path.basename(sample), film && path.basename(film), film && path.dirname(film)].filter((s) => s && text.includes(s));
      const ok =
        text.includes(`Electron: ${process.versions.electron}`) &&
        text.includes(`Chromium: ${process.versions.chrome}`) &&
        text.includes('Accessibility support enabled: yes') &&
        text.includes('GPU feature status:') &&
        (film ? /Opened film: container (?!unknown)\S/.test(text) : sample ? /Opened film: container MP4/.test(text) : text.includes('Opened film: none')) &&
        leaks.length === 0;
      add('diagnostic report', ok, leaks.length ? 'the report contains a path or a file name' : `${text.split('\n').length} lines`);
    });

    return checks;
  }

  const handlers = {
    /** Press a real key in the page, the way a keyboard does. */
    'selftest:input'({ keyCode, modifiers = [], char }) {
      const win = getWindow();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      return true;
    },

    /** Choose a menu item by id, the way a click or its accelerator does. */
    'selftest:menu'({ id }) {
      const menu = Menu.getApplicationMenu();
      const item = menu && menu.getMenuItemById(id);
      if (!item) return { found: false, enabled: false, accelerator: '' };
      const state = { found: true, enabled: item.enabled, accelerator: String(item.accelerator || '') };
      if (item.enabled) item.click();
      return state;
    },

    /**
     * Stands in for a native dialog that stays open for a while: no real one can be answered
     * here, but the page is told about this one exactly as about a real one.
     */
    'selftest:dialog': ({ ms }) => showNativeDialog(() => new Promise((resolve) => setTimeout(() => resolve(true), ms))),

    'selftest:zoom'({ factor }) {
      getWindow().webContents.setZoomFactor(factor);
      return true;
    },

    /** Save a picture of the page, for a developer to look at: only when SCENEVOICE_SELFTEST_SHOTS names a folder. */
    async 'selftest:shot'({ name }) {
      const folder = process.env.SCENEVOICE_SELFTEST_SHOTS;
      if (!folder) return false;
      // "start-light" and "start-dark" are taken in that colour scheme, whatever the system is set to.
      const scheme = name.endsWith('-dark') ? 'dark' : name.endsWith('-light') ? 'light' : '';
      if (scheme) {
        nativeTheme.themeSource = scheme;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const image = await getWindow().webContents.capturePage();
      if (scheme) nativeTheme.themeSource = 'system';
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${name.replace(/[^a-z0-9-]/gi, '')}.png`), image.toPNG());
      return true;
    },

    'selftest:ax': () => accessibilitySummary(getWindow()),

    /**
     * Make the page believe the system uses forced colours (Windows high contrast), or stop.
     * Meanwhile the page also counts as focused: a focus ring is drawn only in the active
     * window, and the self-test must not depend on which window the developer is looking at.
     */
    async 'selftest:emulate'({ forcedColors }) {
      const dbg = getWindow().webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('Emulation.setEmulatedMedia', { features: forcedColors ? [{ name: 'forced-colors', value: 'active' }] : [] });
      await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: forcedColors });
      if (!forcedColors) dbg.detach();
      return true;
    },

    async 'selftest:done'(report) {
      clearTimeout(timer);
      let checks = report.checks.slice();
      try {
        checks = checks.concat(await mainChecks());
      } catch (err) {
        checks.push({ name: 'main process checks', ok: false, detail: String(err && err.message) });
      }
      const failed = checks.filter((c) => !c.ok).map((c) => c.name);
      if (report.axe.ran && report.axe.violations > 0) failed.push('axe-core violations');
      print({
        selftest: 'scenevoice-desktop',
        ok: failed.length === 0,
        passed: checks.length - checks.filter((c) => !c.ok).length,
        failed,
        axe: report.axe,
        checks: Object.fromEntries(checks.map((c) => [c.name, c.detail ? { ok: c.ok, detail: c.detail } : { ok: c.ok }])),
        info: [report.info, ...notes].filter(Boolean).join('; '),
        sample: Boolean(sample),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: `${process.platform} ${os.release()} ${process.arch}`,
        language: language(),
      });
    },
  };

  return { files, handlers };
}
