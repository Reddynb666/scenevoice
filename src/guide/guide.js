// Step-by-step help for getting a Gemini or Qwen API key, written to be followed
// with a screen reader. Opened from the settings page; #gemini or #qwen moves
// focus to that part so it is read first.

import { localizeDocument } from '../shared/i18n.js';

localizeDocument();
const target = document.getElementById(location.hash.slice(1));
if (target && target.tagName === 'H2') target.focus();
