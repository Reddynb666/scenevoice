// A readable page of every description for one video: for reviewing, for braille
// readers, and for sharing with the person who asked for the video to be described.

import { LANGUAGES } from '../shared/constants.js';
import { getScript } from '../shared/cache.js';
import { localizeDocument, t } from '../shared/i18n.js';
import { videoPageUrl } from '../shared/platforms.js';
import { formatTime } from '../shared/script.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const videoId = params.get('v') || '';
const lang = params.get('lang') || 'en';
let script = null;

/**
 * On-screen text exactly as written, when the description does not already
 * quote it in full (it may translate it, or quote only part): for braille, and
 * for copying an address or a line of code character for character.
 */
function exactText(c, shown) {
  return c.kind === 'text' && c.onScreenText && !shown.includes(c.onScreenText) ? c.onScreenText : '';
}

/** Labels shown before a description: on-screen text, and corrected after the user marked it as wrong. */
function tags(c) {
  return [c.kind === 'text' && t('transcript_on_screen'), c.revised && t('transcript_corrected')].filter(Boolean);
}

function lines(detail) {
  return (script?.cues || []).map((c) => {
    const shown = c[detail] || c.standard;
    const exact = exactText(c, shown);
    return `${formatTime(c.start)}  ${tags(c).map((tag) => `[${tag}] `).join('')}${shown}${exact ? ` (${t('transcript_exact', exact)})` : ''}`;
  });
}

function render() {
  const detail = $('detail').value;
  const rows = $('rows');
  rows.replaceChildren();
  for (const c of script?.cues || []) {
    const tr = document.createElement('tr');
    const time = document.createElement('td');
    time.className = 'time';
    time.textContent = formatTime(c.start);
    const text = document.createElement('td');
    for (const label of tags(c)) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = label;
      text.append(tag);
    }
    const shown = c[detail] || c.standard;
    text.append(document.createTextNode(shown));
    const exact = exactText(c, shown);
    if (exact) {
      const line = document.createElement('span');
      line.className = 'exact';
      line.textContent = t('transcript_exact', exact);
      text.append(line);
    }
    tr.append(time, text);
    rows.append(tr);
  }
  const text = `${params.get('title') || videoId}\n${videoPageUrl(videoId)}\n\n${lines(detail).join('\n')}\n`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const dl = $('download');
  if (dl.href) URL.revokeObjectURL(dl.href);
  dl.href = URL.createObjectURL(blob);
  dl.download = `scenevoice-${videoId.replace(/[^\w-]/g, '_')}-${lang}.txt`;
}

async function init() {
  localizeDocument();
  const title = params.get('title') || '';
  $('videoTitle').textContent = title;
  if (title) document.title = `${title} — ${t('transcript_title')}`;
  $('openVideo').href = videoPageUrl(videoId);
  script = videoId ? await getScript(videoId, lang) : null;
  if (!script || !script.cues.length) {
    $('empty').hidden = false;
    $('copy').disabled = true;
    $('download').removeAttribute('href');
    return;
  }
  const langName = LANGUAGES.find((l) => l.code === lang)?.name || lang;
  $('intro').textContent = t('transcript_intro', String(script.cues.length), langName, script.model || '?');
  $('table').hidden = false;
  render();
  $('detail').addEventListener('change', render);
  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lines($('detail').value).join('\n'));
      $('status').textContent = t('transcript_copied');
    } catch {
      $('status').textContent = t('error_unknown');
    }
  });
}

init();
