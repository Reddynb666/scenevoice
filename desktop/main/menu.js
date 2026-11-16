// The native application menu, in the interface language: every listening
// action with its accelerator (shared/actions.js), so each action still works
// when a screen reader keeps the single keys for itself. Builds the template
// only: pure, no Electron. The main process turns it into a Menu.

import { ACTIONS, COMMAND_ACCELERATORS } from '../shared/actions.js';

/** Menu item ids: `action:<id>` for a listening action, `cmd:<name>` for the rest. */
export const actionItemId = (id) => `action:${id}`;
export const commandItemId = (name) => `cmd:${name}`;

/**
 * @param {object} o
 * @param {(key: string, vars?: object) => string} o.t
 * @param {string} o.platform                 process.platform
 * @param {string} o.appName
 * @param {'app'|'reader'} [o.channel]        which channel reads descriptions (the checkbox)
 * @param {boolean} [o.modal]                 a dialog is open in the page: listening items are off
 * @param {boolean} [o.devTools]              add the developer tools (unpackaged runs only)
 * @param {(id: string) => void} o.onCommand  called with the item id
 * @returns {object[]} a template for Menu.buildFromTemplate
 */
export function buildMenuTemplate({ t, platform, appName, channel = 'app', modal = false, devTools = false, onCommand }) {
  const mac = platform === 'darwin';
  // Windows and Linux menus have access keys (Alt+F); macOS menus do not.
  const top = (key, letter) => (mac ? t(key) : `${t(key)}(&${letter})`);
  const item = (id, label, extra = {}) => ({ id, label, enabled: !modal, click: () => onCommand(id), ...extra });
  const action = (id) => {
    const a = ACTIONS.find((x) => x.id === id);
    return item(actionItemId(a.id), t(a.label), { accelerator: a.accelerator });
  };
  const separator = { type: 'separator' };

  const template = [];
  if (mac) {
    template.push({
      label: appName,
      submenu: [
        { role: 'about', label: t('menuAbout', { name: appName }) },
        separator,
        { role: 'hide', label: t('menuHide', { name: appName }) },
        { role: 'hideOthers', label: t('menuHideOthers') },
        { role: 'unhide', label: t('menuShowAll') },
        separator,
        { role: 'quit', label: t('menuQuitMac', { name: appName }) },
      ],
    });
  }

  const file = [
    item(commandItemId('sample'), t('menuSample')),
    item(commandItemId('open'), t('menuOpen'), { accelerator: COMMAND_ACCELERATORS.open }),
    separator,
    item(commandItemId('report'), t('menuReport'), { enabled: true }),
  ];
  if (!mac) file.push(separator, { role: 'quit', label: t('menuQuit') });
  template.push({ label: top('menuFile', 'F'), submenu: file });

  template.push({
    label: top('menuListen', 'L'),
    submenu: [
      action('toggle'),
      action('back'),
      action('forward'),
      separator,
      action('describe'),
      action('repeat'),
      action('stop'),
      action('who'),
      action('wrong'),
      separator,
      item(commandItemId('channel'), t('menuUseReader'), { type: 'checkbox', checked: channel === 'reader' }),
    ],
  });

  const view = [
    { role: 'zoomIn', label: t('menuZoomIn') },
    { role: 'zoomOut', label: t('menuZoomOut') },
    { role: 'resetZoom', label: t('menuZoomReset') },
  ];
  if (devTools) view.push(separator, { role: 'toggleDevTools' });
  template.push({ label: top('menuView', 'V'), submenu: view });

  template.push({ label: top('menuHelp', 'H'), submenu: [action('help')] });
  return template;
}

/** Every item with an id in a template, submenus included. */
export function itemsWithId(template) {
  const out = [];
  for (const entry of template) {
    if (entry.id) out.push(entry);
    if (Array.isArray(entry.submenu)) out.push(...itemsWithId(entry.submenu));
  }
  return out;
}
