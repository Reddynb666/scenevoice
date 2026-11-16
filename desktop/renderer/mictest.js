// "Test the microphone": the installation record of K3 asks what Windows and
// the security software say when a program wants the microphone. The button
// asks for it, listens for a moment and says in words whether it heard
// anything. Nothing is recorded, kept or sent: each block of samples is looked
// at for its level and dropped, nothing is played back, and the microphone is
// released as soon as the moment is over, however it ends.
// rms and micFailure are pure; listen touches the Web Audio API it is given.

/** How long the microphone is listened to. */
export const LISTEN_MS = 3000;
const LOOK_EVERY_MS = 50;
/** A level above this counts as sound (full scale is 1): about -46 dB, above the hiss of an open input. */
export const SOUND_RMS = 0.005;

/** The level of one block of samples (-1 to 1): root mean square. */
export function rms(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * What a refused request for the microphone means, from the name of its error.
 * @returns {'denied'|'missing'|'busy'|'failed'}
 */
export function micFailure(errorName) {
  const name = String(errorName || '');
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'failed';
}

/**
 * Listen to a microphone stream and say whether there was sound. The stream's
 * tracks are stopped and the audio context is closed before this returns or
 * throws.
 * @param {MediaStream} stream
 * @param {object} [o]
 * @param {number} [o.ms]
 * @param {typeof AudioContext} [o.AudioContextClass]
 * @param {(ms: number) => Promise<void>} [o.wait]
 * @returns {Promise<{heard: boolean}>}
 */
export async function listen(stream, { ms = LISTEN_MS, AudioContextClass = globalThis.AudioContext, wait = (t) => new Promise((resolve) => setTimeout(resolve, t)) } = {}) {
  let context = null;
  let loudest = 0;
  try {
    context = new AudioContextClass();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    // Into the analyser and nowhere else: the microphone is never played back.
    context.createMediaStreamSource(stream).connect(analyser);
    const block = new Float32Array(analyser.fftSize);
    for (let waited = 0; waited < ms; waited += LOOK_EVERY_MS) {
      await wait(LOOK_EVERY_MS);
      analyser.getFloatTimeDomainData(block);
      loudest = Math.max(loudest, rms(block));
    }
  } finally {
    for (const track of stream.getTracks()) track.stop();
    if (context && typeof context.close === 'function') await Promise.resolve(context.close()).catch(() => {});
  }
  return { heard: loudest >= SOUND_RMS };
}
