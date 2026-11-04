/* SceneVoice website. Two jobs only:
   1. the "Hear it" sample (three descriptions, through the visitor's screen reader
      or the browser's built-in voice), and
   2. remembering which language the visitor picked.
   Every link and every piece of text works without this file.

   The sample text, the status sentences and the button labels live in the page's
   HTML (a JSON block with id "sample-data"), so each language's page owns its words. */
(function () {
  'use strict';

  var doc = document;
  var pageLang = doc.documentElement.lang || 'en';

  /* ---------- Language memory ---------- */

  var LANG_KEY = 'scenevoice-lang';

  function readLang() {
    try { return localStorage.getItem(LANG_KEY); } catch (e) { return null; }
  }

  function saveLang(lang) {
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* private window or storage off: nothing to remember with */ }
  }

  // The link to the other language. Clicking it is the only thing that sets the memory.
  var switchLink = doc.querySelector('a[data-lang-switch]');
  if (switchLink) {
    switchLink.addEventListener('click', function () {
      saveLang(switchLink.getAttribute('data-lang-switch'));
    });
    // A visitor who chose the other language earlier lands there again, same section.
    // Only ever one hop: the remembered language is the one we are going to.
    var remembered = readLang();
    if (remembered && remembered !== pageLang && remembered === switchLink.getAttribute('data-lang-switch')) {
      location.replace(switchLink.href + location.hash);
      return;
    }
  }

  /* ---------- "Hear it" sample ---------- */

  var dataEl = doc.getElementById('sample-data');
  var region = doc.getElementById('sample');
  var status = doc.getElementById('sample-status');
  var srButton = doc.getElementById('hear-sr');
  var ttsButton = doc.getElementById('hear-tts');
  if (!dataEl || !region || !status || !srButton || !ttsButton) return;

  var data;
  try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }

  // Pause between lines, in milliseconds. The page can shorten it (tests do).
  var gap = Number(region.getAttribute('data-gap')) || 3500;
  var shortGap = Math.round(gap / 3);

  var playing = null; // 'sr' | 'tts' | null
  var timers = [];
  var synth = window.speechSynthesis;

  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function later(fn, ms) {
    timers.push(setTimeout(fn, ms));
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function addLine(text, isDialogue) {
    var p = doc.createElement('p');
    if (isDialogue) p.className = 'dialogue';
    p.textContent = text;
    region.appendChild(p);
  }

  // The lines in the order they are heard: a dialogue placeholder, then a description, three times.
  function sequence() {
    var out = [];
    data.lines.forEach(function (line) {
      out.push({ text: data.dialogue, dialogue: true });
      out.push({ text: line, dialogue: false });
    });
    return out;
  }

  function setButtons() {
    srButton.textContent = playing === 'sr' ? data.labels.stop : data.labels.sr;
    ttsButton.textContent = playing === 'tts' ? data.labels.stop : data.labels.tts;
    srButton.setAttribute('aria-pressed', playing === 'sr' ? 'true' : 'false');
    ttsButton.setAttribute('aria-pressed', playing === 'tts' ? 'true' : 'false');
  }

  function stop(announce) {
    var was = playing;
    playing = null;
    clearTimers();
    if (synth && was === 'tts') {
      try { synth.cancel(); } catch (e) { /* nothing was speaking */ }
    }
    // The screen reader may read the region again once the built-in voice is silent.
    region.setAttribute('aria-live', 'polite');
    setButtons();
    if (announce && was) setStatus(data.status.stopped);
  }

  function finish() {
    playing = null;
    region.setAttribute('aria-live', 'polite');
    setButtons();
    setStatus(data.status.done);
  }

  // Screen-reader mode: the live region does the speaking. Lines are added one at a
  // time with a pause after each description, so one is finished before the next starts.
  function playScreenReader() {
    playing = 'sr';
    setButtons();
    region.textContent = '';
    setStatus(data.status.sr);
    var lines = sequence();
    var at = gap; // the status sentence is read first; give it time
    lines.forEach(function (line, i) {
      later(function () { addLine(line.text, line.dialogue); }, at);
      at += line.dialogue ? shortGap : gap;
    });
    later(finish, at);
  }

  // Built-in voice mode: the browser speaks and the live region is switched off while it
  // does, so a screen reader never talks over it. The text still appears, line by line.
  function playBuiltInVoice() {
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
      setStatus(data.status.unavailable);
      return;
    }
    playing = 'tts';
    setButtons();
    region.textContent = '';
    setStatus(data.status.tts);
    var lines = sequence();
    // Let the status sentence be read by a screen reader before the voice starts.
    later(function () {
      if (playing !== 'tts') return;
      region.setAttribute('aria-live', 'off');
      try { synth.cancel(); } catch (e) { /* ignore */ }
      var started = false;
      var index = 0;

      function speakNext() {
        if (playing !== 'tts') return;
        if (index >= lines.length) { finish(); return; }
        var line = lines[index++];
        var u = new window.SpeechSynthesisUtterance(line.text);
        u.lang = pageLang;
        if (line.dialogue) u.rate = 1.05;
        u.onstart = function () {
          started = true;
          addLine(line.text, line.dialogue);
        };
        u.onend = function () {
          if (playing !== 'tts') return;
          later(speakNext, line.dialogue ? shortGap : Math.round(gap / 4));
        };
        u.onerror = function () {
          // "interrupted"/"canceled" follow our own cancel(); anything else means no voice.
          if (playing !== 'tts') return;
          stop(false);
          setStatus(data.status.unavailable);
        };
        synth.speak(u);
      }

      speakNext();
      // Some browsers accept the utterance and never speak. Say so instead of staying silent.
      later(function () {
        if (playing === 'tts' && !started) {
          stop(false);
          setStatus(data.status.unavailable);
        }
      }, 4000);
    }, shortGap);
  }

  srButton.addEventListener('click', function () {
    if (playing === 'sr') { stop(true); return; }
    stop(false);
    playScreenReader();
  });

  ttsButton.addEventListener('click', function () {
    if (playing === 'tts') { stop(true); return; }
    stop(false);
    playBuiltInVoice();
  });

  // Leaving the page should not leave the browser's voice talking.
  window.addEventListener('pagehide', function () { stop(false); });

  setButtons();
})();
