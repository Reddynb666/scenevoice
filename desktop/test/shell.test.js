// Promises the shell makes about itself: nothing but Electron at run time,
// none of the libraries and models the plan rules out, a page without inline
// code, and the window settings the plan asks for.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(DESKTOP, file), 'utf8');
const pkg = JSON.parse(read('package.json'));

function sourceFiles(folder) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(DESKTOP, folder), { withFileTypes: true })) {
    const relative = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(relative));
    else if (/\.(js|cjs|mjs|html|css|json)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

const SHIPPED = ['main', 'ipc', 'shared', 'locales', 'renderer'].flatMap(sourceFiles);

describe('package.json', () => {
  it('is the private desktop package with its own scripts', () => {
    expect(pkg.name).toBe('scenevoice-desktop');
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe('0.0.1');
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('main/index.js');
    expect(pkg.scripts.selftest).toBe('electron . --selftest');
  });

  it('has no runtime dependency: Electron, the builder and the test tools are for development', () => {
    expect(pkg.dependencies || {}).toEqual({});
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(['axe-core', 'electron', 'electron-builder', 'vitest']);
    // Exact versions: the Chromium the testers get is the one that was tested.
    for (const version of Object.values(pkg.devDependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pulls in none of the packages the plan rules out', () => {
    const lock = read('package-lock.json');
    for (const banned of ['ffmpeg-static', 'insightface', 'scrfd', 'piper', 'rubberband', 'olaf', 'panako', 'alass']) {
      expect(new RegExp(`"node_modules/[^"]*${banned}[^"]*"`, 'i').test(lock), banned).toBe(false);
    }
  });

  it('packs only the folders the app runs from', () => {
    // The last pattern keeps the sample clip out: it goes in only with `--with-sample` (scripts/dist.mjs).
    expect([...pkg.build.files].sort()).toEqual(['!renderer/sample/sample.mp4', 'ipc/**', 'locales/**', 'main/**', 'package.json', 'renderer/**', 'shared/**']);
    expect(pkg.build.asar).toBe(true);
    expect(pkg.build.appId).toBe('app.scenevoice.desktop.k3test');
    expect(pkg.build.productName).toBe('SceneVoice 影院版 测试版');
    // Windows shows a notification only when the running app and its shortcut carry the same id.
    expect(read('main/index.js')).toContain(`const APP_ID = '${pkg.build.appId}';`);
    expect(pkg.build.directories.output).toBe('dist');
  });

  it('carries the notices and the licence in every build', () => {
    expect(pkg.build.extraResources).toEqual([
      { from: 'THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' },
      { from: '../LICENSE', to: 'LICENSE.SceneVoice.txt' },
    ]);
    expect(fs.existsSync(path.join(DESKTOP, 'THIRD-PARTY-NOTICES.md'))).toBe(true);
  });

  it('builds a Windows x64 zip and an assisted, per-user, Chinese installer, and a macOS arm64 zip', () => {
    expect(pkg.scripts['dist:win']).toBe('node scripts/dist.mjs win');
    expect(pkg.scripts['dist:mac']).toBe('node scripts/dist.mjs mac');
    // The builder makes the unpacked folder and the installer; the zip is made from that folder
    // by scripts/dist.mjs, with one folder inside it (the builder's own zip has none).
    expect(pkg.build.win.target).toEqual([
      { target: 'dir', arch: ['x64'] },
      { target: 'nsis', arch: ['x64'] },
    ]);
    const dist = read('scripts/dist.mjs');
    expect(dist).toMatch(/if \(platform === 'win'\) \{\s+const zip = winZip\(pkg\.version\);\s+const made = zipFolder\(path\.join\(DIST, WIN_UNPACKED\), path\.join\(DIST, zip\.file\), zip\.folder\);/);
    // A plain name for the program file: a zip made here is then unpacked the same by every tool.
    expect(pkg.build.win.executableName).toMatch(/^[A-Za-z0-9]+$/);
    expect(pkg.build.artifactName).toMatch(/^[\x20-\x7e]+$/);
    expect(pkg.build.nsis.artifactName).toMatch(/^[\x20-\x7e]+$/);
    expect(pkg.build.nsis.oneClick).toBe(false);
    expect(pkg.build.nsis.perMachine).toBe(false);
    expect(pkg.build.nsis.allowElevation).toBe(false);
    expect(pkg.build.nsis.packElevateHelper).toBe(false);
    expect(pkg.build.nsis.installerLanguages).toEqual(['zh_CN']);
    expect(pkg.build.nsis.include).toBe('build/installer.nsh');
    const include = read('build/installer.nsh');
    expect(include).toMatch(/!macro customInstallMode\s+StrCpy \$isForceCurrentInstall "1"\s+!macroend/);
    expect(include).toMatch(/!macro customWelcomePage\s+!insertmacro MUI_PAGE_WELCOME\s+!macroend/);
    expect(pkg.build.mac.target).toEqual([{ target: 'zip', arch: ['arm64'] }]);
    // macOS stops an app that asks for the microphone without saying why.
    expect(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription).toMatch(/Nothing is recorded/);
  });

  it('has no update, publishing or signing configuration yet', () => {
    expect(pkg.build.publish).toBe(null);
    expect(pkg.build.nsis.differentialPackage).toBe(false);
    const config = JSON.stringify(pkg.build);
    for (const key of ['certificateFile', 'certificatePassword', 'certificateSubjectName', 'signtoolOptions', 'azureSignOptions', 'cscLink', 'identity', 'notarize', 'provisioningProfile', 'electronFuses', 'afterSign']) {
      expect(config.includes(`"${key}"`), key).toBe(false);
    }
    expect(Object.keys({ ...pkg.devDependencies, ...(pkg.dependencies || {}) })).not.toContain('electron-updater');
  });
});

describe('the shipped code', () => {
  it('imports nothing but its own files, Electron and Node', () => {
    for (const file of SHIPPED.filter((f) => /\.(js|cjs|mjs)$/.test(f))) {
      const source = read(file);
      const specifiers = [
        ...[...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
        ...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
        ...[...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
      ];
      for (const specifier of specifiers) {
        expect(specifier === 'electron' || specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../'), `${file} imports ${specifier}`).toBe(true);
        // Nothing reaches out of desktop/ (the extension's code stays untouched and unshared).
        if (specifier.startsWith('.')) {
          const target = path.resolve(DESKTOP, path.dirname(file), specifier);
          expect(target.startsWith(DESKTOP + path.sep), `${file} imports ${specifier}`).toBe(true);
        }
      }
    }
  });

  it('keeps Electron and Node out of the page', () => {
    for (const file of SHIPPED.filter((f) => f.startsWith('renderer') || f.startsWith('shared') || f.startsWith('locales'))) {
      const source = read(file);
      expect(/from\s+['"](electron|node:[^'"]+)['"]/.test(source), file).toBe(false);
      expect(/\brequire\(/.test(source), file).toBe(false);
    }
  });

  it('makes no network request: no fetch, XMLHttpRequest, WebSocket or address in the app code', () => {
    for (const file of SHIPPED.filter((f) => /\.(js|cjs|mjs)$/.test(f) && !/selftest\.js$/.test(f))) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|net\.request/.test(code), file).toBe(false);
      const urls = (code.match(/\b(?:https?|wss?):\/\/[^\s'"`*]+/g) || []);
      expect(urls, file).toEqual([]);
    }
  });

  it('has no model call, key or face code: it is a test instrument', () => {
    for (const file of SHIPPED) {
      expect(/api[_-]?key|x-goog-api-key|Authorization|dashscope|generativelanguage|onnxruntime|safeStorage/i.test(read(file)), file).toBe(false);
    }
  });
});

describe('the page', () => {
  const html = read('renderer/index.html');

  it('has no inline script, style or event handler', () => {
    expect(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)).toBe(false);
    expect(/<style\b/i.test(html)).toBe(false);
    expect(/\sstyle=/i.test(html)).toBe(false);
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
    expect(/(?:src|href)=["'](?:https?:)?\/\//i.test(html)).toBe(false);
  });

  it('has the focusable h1, the six buttons in order, the status and the log', () => {
    expect(html).toMatch(/<h1 id="title" tabindex="-1" data-i18n="heading">/);
    const ids = [...html.matchAll(/<button type="button" id="(btn-[a-z]+)"/g)].map((m) => m[1]);
    expect(ids.slice(0, 6)).toEqual(['btn-sample', 'btn-open', 'btn-dialog', 'btn-notify', 'btn-channel', 'btn-help']);
    expect(html).toMatch(/id="status" role="status"/);
    expect(html).toMatch(/id="log" role="log"/);
    // The two installation checks sit together at the end of the page.
    expect(ids.slice(-2)).toEqual(['btn-mic', 'btn-report']);
    expect(html).toMatch(/id="player" role="application" tabindex="0"/);
    expect(html).toMatch(/<p id="current" tabindex="0">/);
    expect(html).toMatch(/<video id="film"(?![^>]*\bcontrols\b)/);
    expect(html).not.toMatch(/\sautoplay\b/);
    expect((html.match(/<dialog /g) || []).length).toBe(2);
  });

  it('gives every button of the player an action of the table', async () => {
    const { ACTION_IDS } = await import('../shared/actions.js');
    const actions = [...html.matchAll(/data-action="([a-z]+)"/g)].map((m) => m[1]);
    expect(actions).toEqual(ACTION_IDS.filter((id) => id !== 'help'));
  });

  it('follows the system colours, forced colours included, and draws a 3 px focus ring', () => {
    const css = read('renderer/style.css');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(css).toMatch(/@media \(forced-colors: active\)/);
    expect(css).toMatch(/:focus \{\s*outline: 3px solid var\(--focus\);/);
    expect(css).not.toMatch(/outline:\s*(none|0)\b/);
    // Sizes that grow with zoom: no fixed pixel widths.
    expect(css).not.toMatch(/\bwidth:\s*\d{3,}px/);
  });
});

describe('the main process', () => {
  const main = read('main/index.js');

  it('creates the window with the settings the plan asks for', () => {
    expect(main).toMatch(/contextIsolation: true/);
    expect(main).toMatch(/sandbox: true/);
    expect(main).toMatch(/nodeIntegration: false/);
    expect(main).toMatch(/backgroundThrottling: false/);
    expect(main).toMatch(/preload: path\.join\(ROOT, 'main', 'preload\.cjs'\)/);
    expect(main).not.toMatch(/webSecurity: false|allowRunningInsecureContent: true|enableRemoteModule/);
  });

  it('turns accessibility support on before it creates the window', () => {
    const enable = main.indexOf('app.setAccessibilitySupportEnabled(true)');
    const create = main.lastIndexOf('createWindow();');
    expect(enable).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(enable);
  });

  it('registers both schemes as standard and secure, the media one for streaming, and loads no file:// page', () => {
    expect(main).toMatch(/scheme: APP_SCHEME, privileges: \{ standard: true, secure: true/);
    expect(main).toMatch(/scheme: MEDIA_SCHEME, privileges: \{ standard: true, secure: true, stream: true \}/);
    expect(main).toMatch(/win\.loadURL\(START_URL\)/);
    expect(main).not.toMatch(/loadFile\(|file:\/\//);
  });

  it('saves the diagnostic report itself when the menu asks, without a round trip through the page', () => {
    const command = main.slice(main.indexOf('function onMenuCommand'), main.indexOf('function installMenu'));
    expect(command).toMatch(/if \(id === commandItemId\('report'\)\) \{[\s\S]*?saveReport\(\)[\s\S]*?return;/);
    expect(command.indexOf('saveReport()')).toBeLessThan(command.indexOf("tellPage('menu:action'"));
    // No invisible byte order mark in the source: it is written from a named constant.
    expect(main.includes(String.fromCharCode(0xfeff))).toBe(false);
    expect(main).toContain('`${BYTE_ORDER_MARK}${text}`');
  });

  it('tells the page about every native dialog it shows, so the app voice is silent under it', () => {
    const calls = [...main.matchAll(/dialog\.show\w+\(/g)];
    // In the order of the file: save the report (with and without a window), "the page has stopped", open a film.
    expect(calls.map((m) => m[0])).toEqual(['dialog.showSaveDialog(', 'dialog.showSaveDialog(', 'dialog.showMessageBox(', 'dialog.showOpenDialog(']);
    for (const call of calls) {
      expect(main.slice(Math.max(0, call.index - 90), call.index), call[0]).toContain('showNativeDialog(() =>');
    }
    const wrapper = main.slice(main.indexOf('async function showNativeDialog'), main.indexOf('/** The validated payload'));
    expect(wrapper).toMatch(/tellPage\('reader:busy', \{ cause: 'dialog', open: true \}\);\s+try \{\s+return await show\(\);\s+\} finally \{\s+tellPage\('reader:busy', \{ cause: 'dialog', open: false \}\);/);
    // The page turns the cause into a block of the speech bus; the menu's failsafe leaves it alone.
    const page = read('renderer/app.js');
    expect(page).toContain("sv.on('reader:busy', (payload) => bus.setBlocked(blockReason(payload.cause), payload.open === true));");
    expect(page).not.toMatch(/setBlocked\('native', false\)/);
  });

  it('never leaves a running app without a window, and says so when the page stops', () => {
    const create = main.slice(main.indexOf('function createWindow'), main.indexOf("app.on('second-instance'"));
    expect(create).toMatch(/show: false/);
    expect(main).toMatch(/function revealWindow\(\) \{\s+if \(win && !win\.isDestroyed\(\) && !win\.isVisible\(\)\) win\.show\(\);/);
    expect(create).toContain("win.once('ready-to-show', revealWindow);");
    expect(create).toContain('setTimeout(revealWindow, REVEAL_AFTER_MS);');
    expect(main).toMatch(/const REVEAL_AFTER_MS = 5000;/);
    expect(create).toMatch(/contents\.on\('did-fail-load'[\s\S]*?revealWindow\(\);\s+pageStopped\('pageNotLoaded'\);/);
    expect(create).toMatch(/contents\.on\('render-process-gone'[\s\S]*?revealWindow\(\);\s+if \(details\.reason !== 'clean-exit'\) pageStopped\(\);/);
    expect(create).toMatch(/win\.on\('unresponsive'[\s\S]*?revealWindow\(\);\s+pageStopped\(\);/);
    // A second start shows the first copy's window even if it never came up.
    const second = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf("app.on('window-all-closed'"));
    expect(second.indexOf('win.show();')).toBeGreaterThan(0);
    expect(second.indexOf('win.focus();')).toBeGreaterThan(second.indexOf('win.show();'));
    // The box that says the page stopped offers the report, and is never shown to the self-test.
    const stopped = main.slice(main.indexOf('async function pageStopped'), main.indexOf('function showNotification'));
    expect(stopped).toContain('if (pageStoppedShown || SELFTEST) return;');
    expect(stopped).toContain("buttons: [t('pageReload'), t('btnReport'), t('menuQuit')]");
    expect(stopped).toContain('await saveReport();');
    expect(stopped).toContain('win.webContents.reload();');
  });

  it('says that the page did not load when it never reports, and can always be quit', () => {
    // A page whose process is held up sends no event at all: the watch that starts with every
    // load is what notices. The page's first message (ui:state) ends it.
    const watch = main.slice(main.indexOf('function watchPageStart'), main.indexOf('async function pageStopped'));
    expect(watch).toMatch(/pageReady = false;\s+clearTimeout\(pageReadyTimer\);\s+pageReadyTimer = setTimeout\(/);
    expect(watch).toMatch(/if \(pageReady \|\| !win \|\| win\.isDestroyed\(\)\) return;[\s\S]*?revealWindow\(\);\s+pageStopped\('pageNotLoaded'\);\s+\}, PAGE_READY_MS\);/);
    expect(main).toMatch(/'ui:state'\(state\) \{[\s\S]*?pageReady = true;\s+clearTimeout\(pageReadyTimer\);/);
    const create = main.slice(main.indexOf('function createWindow'), main.indexOf("app.on('second-instance'"));
    expect(create).toMatch(/watchPageStart\(\);\s+win\.loadURL\(START_URL\);/);
    const stopped = main.slice(main.indexOf('async function pageStopped'), main.indexOf('function showNotification'));
    // A second load is watched like the first.
    expect(stopped).toMatch(/watchPageStart\(\);\s+win\.webContents\.reload\(\);/);
    expect(stopped).toContain('message: t(message),');
    expect(stopped).toContain("detail: t('pageStoppedDetail'),");
    // Quitting does not wait for a page that no longer answers: such a window refuses to close.
    expect(stopped).toMatch(/if \(response === 2\) \{\s+quitNow\(\);/);
    expect(main).toMatch(/function quitNow\(\) \{\s+if \(win && !win\.isDestroyed\(\)\) win\.destroy\(\);\s+app\.quit\(\);\s+\}/);
  });

  it('grants one permission only: the microphone, for the request that follows its button', () => {
    const lock = main.slice(main.indexOf('function lockDown'), main.indexOf('function serveSchemes'));
    expect(lock).toMatch(/setPermissionRequestHandler\(\(contents, permission, callback, details\) => \{\s+const allowed = microphoneRequestAllowed\(\{/);
    expect(lock).toContain('armedUntil: micArmedUntil,');
    expect(lock).toMatch(/if \(allowed\) micArmedUntil = 0;/);
    expect(lock).toContain('callback(allowed);');
    expect(lock).toContain('ses.setPermissionCheckHandler(() => false);');
    expect(main).toMatch(/'mic:arm'\(\) \{\s+micArmedUntil = Date\.now\(\) \+ MIC_ARMED_MS;/);
    // Nothing else in the main process touches permissions or media devices.
    expect(main.match(/micArmedUntil = /g)).toHaveLength(3);
    expect(main).not.toMatch(/askForMediaAccess|setDevicePermissionHandler|desktopCapturer/);
    // The self-test never opens a real microphone.
    expect(main).toMatch(/if \(SELFTEST\) \{[\s\S]*?appendSwitch\('use-fake-device-for-media-stream'\);\s+\}/);
    // The page: one place asks for the microphone, sound only, after arming; nothing records.
    const page = read('renderer/app.js');
    expect(page.match(/getUserMedia\(/g)).toHaveLength(1);
    expect(page).toMatch(/await sv\.invoke\('mic:arm'\);[\s\S]{0,120}getUserMedia\(\{ audio: true \}\)/);
    for (const file of SHIPPED.filter((f) => /\.(js|cjs|mjs)$/.test(f))) {
      expect(/MediaRecorder|getDisplayMedia|enumerateDevices|createMediaStreamDestination/.test(read(file)), file).toBe(false);
    }
  });

  it('blocks navigation, new windows and permissions, has no tray and quits with its window', () => {
    expect(main).toMatch(/will-navigate/);
    expect(main).toMatch(/setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
    expect(main).toMatch(/setPermissionRequestHandler/);
    expect(main).toMatch(/app\.on\('window-all-closed', \(\) => app\.quit\(\)\)/);
    expect(main).not.toMatch(/\bTray\b/);
    expect(main).toMatch(/setAppUserModelId/);
  });
});
