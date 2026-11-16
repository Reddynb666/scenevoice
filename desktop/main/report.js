// The text of the diagnostic report ("Save diagnostic report" in the menu).
// It holds versions, the accessibility and GPU state and the shell's own last
// log lines; about the user's film it holds the container and codec names and
// nothing else: no file name, no path, no length, no picture size.
// Pure: the main process gathers the data, this formats it.

const yesNo = (value) => (value ? 'yes' : 'no');

/**
 * @param {object} d
 * @param {string} d.intro           one localized sentence saying what the report contains
 * @param {string} d.generated       ISO time
 * @param {{name: string, version: string, packaged: boolean}} d.app
 * @param {{electron: string, chrome: string, node: string, v8: string}} d.versions
 * @param {{platform: string, release: string, arch: string, system: string}} d.os
 * @param {{interface: string, system: string}} d.language
 * @param {boolean} d.accessibility  app.isAccessibilitySupportEnabled()
 * @param {string} d.channel         which channel reads descriptions
 * @param {Record<string, string>|null} d.gpu  app.getGPUFeatureStatus()
 * @param {{container: string, codecs: string[]}|null} d.film
 * @param {string[]} d.log
 * @returns {string}
 */
export function formatReport(d) {
  const lines = [
    'SceneVoice film edition, test shell: diagnostic report',
    d.intro,
    '',
    `Generated: ${d.generated}`,
    `App: ${d.app.name} ${d.app.version} (packaged: ${yesNo(d.app.packaged)})`,
    `Electron: ${d.versions.electron}`,
    `Chromium: ${d.versions.chrome}`,
    `Node: ${d.versions.node}`,
    `V8: ${d.versions.v8}`,
    `OS: ${d.os.platform} ${d.os.release} ${d.os.arch} (system version ${d.os.system})`,
    `Interface language: ${d.language.interface} (system: ${d.language.system})`,
    `Accessibility support enabled: ${yesNo(d.accessibility)}`,
    `Descriptions read by: ${d.channel === 'reader' ? 'the screen reader (live region)' : 'the app voice'}`,
    '',
    'GPU feature status:',
  ];
  const gpu = d.gpu && typeof d.gpu === 'object' ? Object.entries(d.gpu) : [];
  if (gpu.length) {
    for (const [feature, state] of gpu) lines.push(`  ${feature}: ${state}`);
  } else {
    lines.push('  not available');
  }
  lines.push('');
  if (d.film) {
    lines.push(`Opened film: container ${d.film.container}; codecs ${d.film.codecs.length ? d.film.codecs.join(', ') : 'not recognised'}`);
  } else {
    lines.push('Opened film: none');
  }
  lines.push('', `Log (last ${d.log.length} lines of the shell itself, times in UTC):`);
  for (const line of d.log) lines.push(`  ${line}`);
  lines.push('');
  return lines.join('\n');
}

/** A file name for the report: scenevoice-diagnostic-20261115-1432.txt */
export function reportFileName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  return `scenevoice-diagnostic-${day}-${pad(date.getHours())}${pad(date.getMinutes())}.txt`;
}
