// Entry of the web player bundle (site/play/player.js, built by `npm run build:web`).
// Everything is in app.js; this only hands it the real window.

import { init } from './app.js';

init({ win: window, version: typeof __SCENEVOICE_VERSION__ === 'string' ? __SCENEVOICE_VERSION__ : '' });
