// Main process of the K3 test shell: one window, the app:// and media schemes,
// the native menu, the IPC handlers of ipc/contract.js, one system
// notification on request and the diagnostic report.
//
// A test instrument, not the product: it calls no model, holds no key, makes
// no network request and reads nothing of a film but its bytes for the player
// and its header for the codec names. The one permission it grants is the
// microphone, for the "Test the microphone" button alone (main/permissions.js).

import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHANNELS, channelsOfKind, senderAllowed, validatePayload } from '../ipc/contract.js';
import { ACTION_IDS } from '../shared/actions.js';
import { LOCALES, createT, pickLanguage } from '../shared/i18n.js';
import { APP_SCHEME, CSP, MEDIA_SCHEME, START_URL, appFileBody, mediaToken, mediaUrl, resolveAppFile } from './apppath.js';
import { RingLog } from './log.js';
import { FILM_EXTENSIONS, MediaRegistry, mediaResponse } from './media.js';
import { actionItemId, buildMenuTemplate, commandItemId } from './menu.js';
import { MIC_ARMED_MS, microphoneRequestAllowed } from './permissions.js';
import { probeFile, unplayableAudio } from './probe.js';
import { formatReport, reportFileName } from './report.js';
import { startSelftest } from './selftest.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE = path.join(ROOT, 'renderer', 'sample', 'sample.mp4');
/**
 * Whether this build carries the sample clip. The builds for testers do not (see
 * THIRD-PARTY-NOTICES.md); SCENEVOICE_NO_SAMPLE=1 makes a developer's copy behave like one.
 */
const HAS_SAMPLE = process.env.SCENEVOICE_NO_SAMPLE !== '1' && fs.existsSync(SAMPLE);
const SELFTEST = process.argv.includes('--selftest');
/** `--selftest --timing` also plays the whole sample and reports when each description was spoken. */
const SELFTEST_TIMING = SELFTEST && process.argv.includes('--timing');
/**
 * SCENEVOICE_SELFTEST_FILM=/path/to/film: the self-test opens this file as "the film" instead of
 * the sample and also checks seeking far into it (for trying a film of several gigabytes).
 */
const SELFTEST_FILM = SELFTEST ? process.env.SCENEVOICE_SELFTEST_FILM || '' : '';
/**
 * Windows shows notifications only for an app with this id on its Start menu shortcut. The
 * installer sets it from build.appId of package.json, so the two have to be the same; a copy run
 * from the unpacked zip has no shortcut and may get no notification at all.
 */
const APP_ID = 'app.scenevoice.desktop.k3test';
const NOTIFICATION_WAIT_MS = 3000;
/** A window still hidden after this long is shown whatever the page has done. */
const REVEAL_AFTER_MS = 5000;
/** A page that has not said it is running this long after its load began did not load. */
const PAGE_READY_MS = 20_000;
/** Chromium's code for a load that was given up on purpose (a reload over a load): not a failure. */
const LOAD_ABORTED = -3;
/** Put first in the report file: older Windows editors then show its Chinese line correctly. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** SCENEVOICE_DEBUG=1 also prints the shell's log, and everything the page logs, to the terminal. */
const DEBUG = process.env.SCENEVOICE_DEBUG === '1';
const log = new RingLog({ echo: DEBUG ? (line) => process.stderr.write(`${line}\n`) : null });
const registry = new MediaRegistry();
/** What the page last told us: a dialog is open, which channel reads descriptions. */
const ui = { modal: false, channel: 'app' };
/** Notifications are kept until they close: one that is collected early never shows. */
const notifications = new Set();

let win = null;
let lang = 'en';
let systemLocale = '';
let t = createT(lang);
/** Container and codec names of the opened film: all the report says about it. */
let film = null;
/** Files the self-test adds to the app:// scheme (axe-core). */
let selftestFiles = {};
/** The "the page has stopped" box is up: one at a time. */
let pageStoppedShown = false;
/** The page has said that it is running (its first message after a load). */
let pageReady = false;
let pageReadyTimer = null;
/** Until when the page's next request for the microphone is let through: 0 unless "Test the microphone" was just pressed. */
let micArmedUntil = 0;

// Both schemes have to be declared before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } },
]);
// Screen readers must find the accessibility tree from the first moment.
app.commandLine.appendSwitch('force-renderer-accessibility');
// The shell uses no network at all: also keep Chromium from fetching things by itself.
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');

if (SELFTEST) {
  // Its own profile folder, so a self-test never touches (or waits for) a running copy.
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'scenevoice-selftest-')));
  // The self-test never opens a real microphone: Chromium's stand-in device answers instead.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
}
const primary = SELFTEST || app.requestSingleInstanceLock();
if (!primary) app.quit();

function languageOverride() {
  const arg = process.argv.find((a) => a.startsWith('--lang='));
  const value = arg ? arg.slice('--lang='.length) : '';
  return Object.hasOwn(LOCALES, value) ? value : '';
}

/** Send a contract event to the page, when there is a page to hear it. */
function tellPage(channel, payload) {
  if (!win || win.isDestroyed() || win.webContents.isCrashed()) return;
  const checked = validatePayload(channel, payload);
  if (!checked.ok || CHANNELS[channel].kind !== 'event') {
    log.add(`main: refused to send ${channel}`);
    return;
  }
  win.webContents.send(channel, checked.value);
}

/**
 * Show a native dialog (Open, Save, a message box). The screen reader reads it, so the page is
 * told to keep its own voice silent for as long as it is open, however the dialog ends.
 * @template T
 * @param {() => Promise<T>} show
 * @returns {Promise<T>}
 */
async function showNativeDialog(show) {
  tellPage('reader:busy', { cause: 'dialog', open: true });
  try {
    return await show();
  } finally {
    tellPage('reader:busy', { cause: 'dialog', open: false });
  }
}

/** The validated payload of a message from the page; throws when the sender or the payload is not acceptable. */
function accept(channel, event, payload) {
  const frame = event.senderFrame;
  const allowed =
    win &&
    !win.isDestroyed() &&
    frame &&
    senderAllowed({
      url: frame.url,
      isMainFrame: frame === win.webContents.mainFrame,
      isAppWindow: event.sender === win.webContents,
    });
  if (!allowed) throw new Error(`${channel}: sender not allowed`);
  const checked = validatePayload(channel, payload);
  if (!checked.ok) throw new Error(checked.error);
  return checked.value;
}

function reportText() {
  let gpu = null;
  try {
    gpu = app.getGPUFeatureStatus();
  } catch {
    gpu = null;
  }
  return formatReport({
    intro: t('reportIntro'),
    generated: new Date().toISOString(),
    app: { name: app.getName(), version: app.getVersion(), packaged: app.isPackaged },
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
    os: { platform: process.platform, release: os.release(), arch: process.arch, system: process.getSystemVersion() },
    language: { interface: lang, system: systemLocale },
    accessibility: typeof app.isAccessibilitySupportEnabled === 'function' && app.isAccessibilitySupportEnabled(),
    channel: ui.channel,
    gpu,
    film,
    log: log.lines(),
  });
}

/**
 * Ask where to save the diagnostic report and write it. Needs nothing from the
 * page, so the menu item still works when the page has stopped answering.
 * @returns {Promise<{saved: boolean, reason: string}>}
 */
async function saveReport() {
  const text = reportText();
  if (SELFTEST) return { saved: false, reason: 'selftest' };
  const options = {
    title: t('reportDialogTitle'),
    defaultPath: path.join(app.getPath('documents'), reportFileName(new Date())),
    filters: [{ name: t('reportFilter'), extensions: ['txt'] }],
  };
  const result = await showNativeDialog(() => (win && !win.isDestroyed() ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)));
  if (result.canceled || !result.filePath) {
    log.add('report: not saved');
    return { saved: false, reason: '' };
  }
  try {
    await fs.promises.writeFile(result.filePath, `${BYTE_ORDER_MARK}${text}`, 'utf8');
    log.add('report: saved');
    return { saved: true, reason: '' };
  } catch (err) {
    const reason = String((err && err.code) || 'error').slice(0, 120);
    log.add(`report: could not be written (${reason})`);
    return { saved: false, reason };
  }
}

/** Show the window if it is still hidden. */
function revealWindow() {
  if (win && !win.isDestroyed() && !win.isVisible()) win.show();
}

/** Quit even when the page no longer answers: a window whose page hangs would refuse to close. */
function quitNow() {
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
}

/**
 * A load of the page begins. If the page has not said that it is running when PAGE_READY_MS
 * are over (its process may be held up or stopped by security software without any event
 * reaching us), the window is shown and a native box says that the page did not load.
 */
function watchPageStart() {
  pageReady = false;
  clearTimeout(pageReadyTimer);
  pageReadyTimer = setTimeout(() => {
    if (pageReady || !win || win.isDestroyed()) return;
    log.add(`main: the page did not report within ${PAGE_READY_MS / 1000} s`);
    revealWindow();
    pageStopped('pageNotLoaded');
  }, PAGE_READY_MS);
}

/**
 * The page is gone: its process crashed, was killed or never started (security software can stop
 * a sandboxed process), the page did not load, or it no longer answers. It cannot say so itself,
 * and a blind tester would be left with silence, so a native message box says it: a screen reader
 * reads that without the page. From the box the tester loads the page again, saves the diagnostic
 * report (which holds the reason), or quits.
 * @param {'pageStopped'|'pageNotLoaded'} [message]  what the box says first
 */
async function pageStopped(message = 'pageStopped') {
  // Nobody can answer a box in the self-test: it fails by its own checks or its timeout.
  if (pageStoppedShown || SELFTEST) return;
  pageStoppedShown = true;
  try {
    for (;;) {
      if (!win || win.isDestroyed()) return;
      const { response } = await showNativeDialog(() =>
        dialog.showMessageBox(win, {
          type: 'error',
          title: t('appName'),
          message: t(message),
          detail: t('pageStoppedDetail'),
          buttons: [t('pageReload'), t('btnReport'), t('menuQuit')],
          defaultId: 0,
          // Escape loads the page again: the harmless one of the three.
          cancelId: 0,
          noLink: true,
        }),
      );
      log.add(`main: ${message}; answer ${response}`);
      if (response === 1) {
        await saveReport();
      } else {
        if (response === 2) {
          quitNow();
        } else if (win && !win.isDestroyed()) {
          watchPageStart();
          win.webContents.reload();
        }
        return;
      }
    }
  } catch (err) {
    log.add(`main: could not say that the page stopped (${String(err && err.message).slice(0, 120)})`);
  } finally {
    pageStoppedShown = false;
  }
}

function showNotification({ title, body }) {
  if (!Notification.isSupported()) return Promise.resolve({ supported: false, shown: false, reason: '' });
  if (SELFTEST) return Promise.resolve({ supported: true, shown: false, reason: 'selftest' });
  return new Promise((resolve) => {
    const notification = new Notification({ title, body });
    notifications.add(notification);
    let settled = false;
    const settle = (shown, reason) => {
      if (settled) return;
      settled = true;
      log.add(`notification: ${shown ? 'shown' : `not confirmed (${reason})`}`);
      resolve({ supported: true, shown, reason });
    };
    notification.once('show', () => settle(true, ''));
    notification.once('failed', (_event, error) => settle(false, String(error || 'failed').slice(0, 120)));
    notification.once('close', () => notifications.delete(notification));
    setTimeout(() => settle(false, 'timeout'), NOTIFICATION_WAIT_MS);
    notification.show();
  });
}

/** One handler per page-to-main channel of the contract. Each gets the validated payload. */
const handlers = {
  async 'sample:open'() {
    try {
      if (!HAS_SAMPLE) throw new Error('no sample clip');
      const token = await registry.open('sample', SAMPLE);
      log.add('sample: opened');
      return { url: mediaUrl(token) };
    } catch {
      log.add('sample: the clip is not in this build');
      return { missing: true };
    }
  },

  async 'film:open'() {
    // No dialog can be answered in the self-test: it opens the sample (or SELFTEST_FILM) as "a film".
    let file = SELFTEST_FILM || (HAS_SAMPLE ? SAMPLE : '');
    if (SELFTEST && !file) {
      log.add('film: this build has no sample clip and the self-test was given no film');
      return { canceled: true };
    }
    if (!SELFTEST) {
      const result = await showNativeDialog(() =>
        dialog.showOpenDialog(win, {
          title: t('openDialogTitle'),
          properties: ['openFile'],
          filters: [{ name: t('openFilter'), extensions: [...FILM_EXTENSIONS] }],
        }),
      );
      if (result.canceled || !result.filePaths.length) {
        log.add('film: nothing chosen');
        return { canceled: true };
      }
      [file] = result.filePaths;
    }
    try {
      const token = await registry.open('film', file);
      film = await probeFile(file).catch(() => ({ container: 'unknown', codecs: [] }));
      log.add(`film: opened; container ${film.container}; codecs ${film.codecs.join(', ') || 'not recognised'}`);
      return { url: mediaUrl(token), audioWarning: unplayableAudio(film.codecs) };
    } catch (err) {
      log.add(`film: could not be opened (${(err && err.code) || 'error'})`);
      return { failed: true };
    }
  },

  'notify:show': (payload) => showNotification(payload),

  'report:save': () => saveReport(),

  'log:write'({ line }) {
    log.add(`page: ${line}`);
  },

  'ui:state'(state) {
    // The page's first message after a load: it is running.
    pageReady = true;
    clearTimeout(pageReadyTimer);
    ui.modal = state.modal;
    ui.channel = state.channel;
    syncMenu();
  },

  // "Test the microphone" was pressed: the page's next request for the microphone, and only that
  // one, is let through (see lockDown).
  'mic:arm'() {
    micArmedUntil = Date.now() + MIC_ARMED_MS;
    log.add('microphone: test asked for');
    return true;
  },
};

function registerIpc() {
  for (const [channel, spec] of Object.entries(CHANNELS)) {
    if (spec.selftest && !SELFTEST) continue;
    if (spec.kind === 'invoke') {
      ipcMain.handle(channel, async (event, payload) => handlers[channel](accept(channel, event, payload)));
    } else if (spec.kind === 'send') {
      ipcMain.on(channel, (event, payload) => {
        try {
          handlers[channel](accept(channel, event, payload));
        } catch (err) {
          log.add(`main: rejected ${String(err && err.message).slice(0, 200)}`);
        }
      });
    }
  }
}

/**
 * Nothing in the session may reach the network, and no permission is granted but one: the
 * microphone, for the single request that follows a press of "Test the microphone".
 */
function lockDown(ses) {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed = microphoneRequestAllowed({
      permission,
      mediaTypes: details && details.mediaTypes,
      url: details && details.requestingUrl,
      isMainFrame: Boolean(details && details.isMainFrame),
      isAppWindow: Boolean(win && !win.isDestroyed() && contents === win.webContents),
      armedUntil: micArmedUntil,
      now: Date.now(),
    });
    // One press of the button, one request.
    if (allowed) micArmedUntil = 0;
    log.add(`main: permission ${String(permission).slice(0, 40)} ${allowed ? 'granted for the microphone test' : 'refused'}`);
    callback(allowed);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
    log.add('main: blocked a network request');
    callback({ cancel: true });
  });
}

function serveSchemes() {
  const headers = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  protocol.handle(APP_SCHEME, async (request) => {
    const hit = request.method === 'GET' ? resolveAppFile(request.url, ROOT, selftestFiles) : null;
    if (hit) {
      try {
        const body = appFileBody(hit, await fs.promises.readFile(hit.file));
        return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': hit.type } });
      } catch {
        // Falls through to "not found".
      }
    }
    return new Response('Not found', { status: 404, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
  });
  protocol.handle(MEDIA_SCHEME, (request) => mediaResponse(registry, mediaToken(request.url), request));
}

function onMenuCommand(id) {
  log.add(`menu: ${id}`);
  if (id === commandItemId('report')) {
    // Saved here, not by way of the page: see saveReport.
    saveReport()
      .then((result) => tellPage('report:result', result))
      .catch((err) => log.add(`report: failed (${String(err && err.message).slice(0, 120)})`));
    return;
  }
  tellPage('menu:action', { action: id.slice(id.indexOf(':') + 1) });
}

function installMenu() {
  const template = buildMenuTemplate({
    t,
    platform: process.platform,
    appName: t('appName'),
    channel: ui.channel,
    modal: ui.modal,
    devTools: !app.isPackaged && !SELFTEST,
    onCommand: onMenuCommand,
  });
  const menu = Menu.buildFromTemplate(template);
  // While a menu is open the screen reader is reading it: the page's voice has to give way.
  for (const top of menu.items) {
    if (!top.submenu) continue;
    top.submenu.on('menu-will-show', () => tellPage('reader:busy', { cause: 'menu', open: true }));
    top.submenu.on('menu-will-close', () => tellPage('reader:busy', { cause: 'menu', open: false }));
  }
  Menu.setApplicationMenu(menu);
}

/** Keep the menu in step with the page: listening items are off while a dialog is open. */
function syncMenu() {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  for (const id of [...ACTION_IDS.map(actionItemId), commandItemId('sample'), commandItemId('open'), commandItemId('channel')]) {
    const item = menu.getMenuItemById(id);
    if (item) item.enabled = !ui.modal;
  }
  const channel = menu.getMenuItemById(commandItemId('channel'));
  if (channel) channel.checked = ui.channel === 'reader';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 420,
    minHeight: 360,
    show: false,
    title: t('appName'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(ROOT, 'main', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Descriptions are timed against the film even when the window is in the background.
      backgroundThrottling: false,
      webSecurity: true,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
      devTools: !app.isPackaged,
      additionalArguments: [
        `--sv-lang=${lang}`,
        `--sv-selftest=${SELFTEST_TIMING ? 2 : SELFTEST ? 1 : 0}`,
        `--sv-sample=${HAS_SAMPLE ? 1 : 0}`,
        `--sv-invoke=${channelsOfKind('invoke', { selftest: SELFTEST }).join(',')}`,
        `--sv-send=${channelsOfKind('send', { selftest: SELFTEST }).join(',')}`,
        `--sv-event=${channelsOfKind('event', { selftest: SELFTEST }).join(',')}`,
      ],
    },
  });
  const contents = win.webContents;
  // The window shows one page and never leaves it.
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('console-message', (event) => {
    if (DEBUG || event.level === 'error' || event.level === 'warning') log.add(`console ${event.level}: ${event.message}`);
  });
  // The window is shown when the page has drawn itself, and in any case: a process that keeps
  // running with no window (and keeps the single-instance lock) is the one thing a tester cannot
  // get out of.
  win.once('ready-to-show', revealWindow);
  setTimeout(revealWindow, REVEAL_AFTER_MS);
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === LOAD_ABORTED) return;
    log.add(`main: the page did not load (${code} ${description})`);
    revealWindow();
    pageStopped('pageNotLoaded');
  });
  contents.on('render-process-gone', (_event, details) => {
    log.add(`main: page process gone (${details.reason})`);
    revealWindow();
    if (details.reason !== 'clean-exit') pageStopped();
  });
  win.on('unresponsive', () => {
    log.add('main: the page does not answer');
    revealWindow();
    pageStopped();
  });
  win.on('closed', () => {
    clearTimeout(pageReadyTimer);
    win = null;
  });
  watchPageStart();
  win.loadURL(START_URL);
}

// Started a second time: bring the first copy's window forward, also when it never came up.
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

// No tray, nothing in the background: closing the window ends the app, on macOS too.
app.on('window-all-closed', () => app.quit());

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(() => {
  if (!primary) return;
  systemLocale = app.getPreferredSystemLanguages()[0] || app.getLocale();
  lang = languageOverride() || pickLanguage(systemLocale);
  t = createT(lang);
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? APP_ID : process.execPath);
  // Before the window exists, so the first thing a screen reader meets is a complete tree.
  if (typeof app.setAccessibilitySupportEnabled === 'function') app.setAccessibilitySupportEnabled(true);
  log.add(`main: started; Electron ${process.versions.electron}; ${process.platform} ${os.release()}; language ${lang}${SELFTEST ? '; self-test' : ''}`);
  lockDown(session.defaultSession);
  serveSchemes();
  if (SELFTEST) {
    const selftest = startSelftest({
      root: ROOT,
      sample: HAS_SAMPLE ? SAMPLE : '',
      film: SELFTEST_FILM,
      registry,
      getWindow: () => win,
      showNativeDialog,
      reportText,
      language: () => lang,
    });
    selftestFiles = selftest.files;
    Object.assign(handlers, selftest.handlers);
  }
  registerIpc();
  installMenu();
  createWindow();
});
