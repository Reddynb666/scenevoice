// "Test the microphone": which permission request the main process lets
// through (main/permissions.js), and what the page does with the stream
// (renderer/mictest.js): a level in words, nothing kept, the device released
// however the listening ends.

import { describe, expect, it } from 'vitest';

import { MIC_ARMED_MS, microphoneRequestAllowed } from '../main/permissions.js';
import { LISTEN_MS, SOUND_RMS, listen, micFailure, rms } from '../renderer/mictest.js';

describe('microphoneRequestAllowed', () => {
  const request = { permission: 'media', mediaTypes: ['audio'], url: 'app://scenevoice/renderer/index.html', isMainFrame: true, isAppWindow: true, armedUntil: 10_000, now: 5000 };

  it('lets the microphone through for the page, after the button, for a short while', () => {
    expect(microphoneRequestAllowed(request)).toBe(true);
    expect(MIC_ARMED_MS).toBeLessThanOrEqual(30_000);
  });

  it('refuses it when the button was not pressed, or too long ago', () => {
    expect(microphoneRequestAllowed({ ...request, armedUntil: 0 })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, now: 10_000 })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, armedUntil: undefined })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, armedUntil: NaN })).toBe(false);
  });

  it('refuses the camera, alone or with the microphone, and a request that names no device', () => {
    expect(microphoneRequestAllowed({ ...request, mediaTypes: ['video'] })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, mediaTypes: ['audio', 'video'] })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, mediaTypes: [] })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, mediaTypes: undefined })).toBe(false);
  });

  it('refuses every other permission, armed or not', () => {
    for (const permission of ['geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock', 'fullscreen', 'openExternal', 'clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'mediaKeySystem', 'hid', 'serial', 'usb', 'speaker-selection', 'unknown', '', undefined]) {
      expect(microphoneRequestAllowed({ ...request, permission }), String(permission)).toBe(false);
    }
  });

  it('refuses any frame or page that is not the shell\'s own', () => {
    expect(microphoneRequestAllowed({ ...request, isMainFrame: false })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, isAppWindow: false })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, url: 'https://example.com/' })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, url: 'app://elsewhere/renderer/index.html' })).toBe(false);
    expect(microphoneRequestAllowed({ ...request, url: undefined })).toBe(false);
  });
});

describe('the level of a block of samples', () => {
  it('is zero for silence and for nothing at all', () => {
    expect(rms(new Float32Array(2048))).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(null)).toBe(0);
  });

  it('is the root mean square: 1 for a full-scale square wave, about 0.707 for a sine', () => {
    expect(rms(Float32Array.from({ length: 1000 }, (_, i) => (i % 2 ? 1 : -1)))).toBeCloseTo(1, 6);
    expect(rms(Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * i) / 48)))).toBeCloseTo(Math.SQRT1_2, 3);
  });
});

describe('micFailure', () => {
  it('sorts the errors of a microphone request into four kinds', () => {
    expect(micFailure('NotAllowedError')).toBe('denied');
    expect(micFailure('SecurityError')).toBe('denied');
    expect(micFailure('NotFoundError')).toBe('missing');
    expect(micFailure('OverconstrainedError')).toBe('missing');
    expect(micFailure('NotReadableError')).toBe('busy');
    expect(micFailure('AbortError')).toBe('busy');
    expect(micFailure('TypeError')).toBe('failed');
    expect(micFailure('')).toBe('failed');
    expect(micFailure(undefined)).toBe('failed');
  });
});

/** A stand-in for the Web Audio API: the analyser hands out the blocks it is given, one per look. */
function standInAudio(levels) {
  const log = { contexts: 0, closed: 0, connected: 0, toDestination: 0, looks: 0 };
  class Context {
    constructor() {
      log.contexts += 1;
      this.destination = { isDestination: true };
    }

    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData(block) {
          const level = levels[Math.min(log.looks, levels.length - 1)] ?? 0;
          log.looks += 1;
          block.fill(level);
        },
      };
    }

    createMediaStreamSource() {
      return {
        connect(node) {
          log.connected += 1;
          if (node && node.isDestination) log.toDestination += 1;
        },
      };
    }

    close() {
      log.closed += 1;
      return Promise.resolve();
    }
  }
  return { Context, log };
}

function standInStream() {
  const tracks = [{ kind: 'audio', readyState: 'live', stop() { this.readyState = 'ended'; } }];
  return { getTracks: () => tracks, tracks };
}

describe('listen', () => {
  const quick = { ms: 500, wait: () => Promise.resolve() };

  it('hears sound when any block is above the threshold, and lets go of the microphone', async () => {
    const audio = standInAudio([0, 0, SOUND_RMS * 4, 0]);
    const stream = standInStream();
    expect(await listen(stream, { ...quick, AudioContextClass: audio.Context })).toEqual({ heard: true });
    expect(stream.tracks[0].readyState).toBe('ended');
    expect(audio.log).toMatchObject({ contexts: 1, closed: 1, connected: 1, toDestination: 0, looks: 10 });
  });

  it('hears nothing in silence and in hiss below the threshold, and says only that', async () => {
    for (const level of [0, SOUND_RMS / 2]) {
      const audio = standInAudio([level]);
      const stream = standInStream();
      const result = await listen(stream, { ...quick, AudioContextClass: audio.Context });
      // The verdict and nothing else: no samples, no numbers.
      expect(result).toEqual({ heard: false });
      expect(stream.tracks[0].readyState).toBe('ended');
    }
  });

  it('never plays the microphone back', async () => {
    const audio = standInAudio([0.5]);
    await listen(standInStream(), { ...quick, AudioContextClass: audio.Context });
    expect(audio.log.toDestination).toBe(0);
  });

  it('lets go of the microphone when the listening fails half-way, and when the audio engine is missing', async () => {
    const audio = standInAudio([0.5]);
    const stream = standInStream();
    let looks = 0;
    const wait = () => {
      looks += 1;
      return looks === 3 ? Promise.reject(new Error('interrupted')) : Promise.resolve();
    };
    await expect(listen(stream, { ms: 500, wait, AudioContextClass: audio.Context })).rejects.toThrow('interrupted');
    expect(stream.tracks[0].readyState).toBe('ended');
    expect(audio.log.closed).toBe(1);

    const other = standInStream();
    await expect(listen(other, { ...quick, AudioContextClass: undefined })).rejects.toThrow();
    expect(other.tracks[0].readyState).toBe('ended');
  });

  it('listens for three seconds unless told otherwise', () => {
    expect(LISTEN_MS).toBe(3000);
  });
});
