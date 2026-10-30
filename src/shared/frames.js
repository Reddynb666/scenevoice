// Prompts built from still frames, for models that are sent pictures rather
// than a link to the video (see providers.js). Each prompt is provider-neutral:
// { kind, system, jsonShape, frames: [{time, data, label}], text, maxTokens,
// temperature }. describe.js turns it into a Gemini or Qwen request; Gemini
// enforces the JSON with a schema, other models get `jsonShape` in words.
// No browser APIs here, so everything is unit-testable.

import { languageName, peopleText, scriptInstructions } from './gemini.js';
import { pickEvenly } from './coverage.js';
import { formatTime } from './script.js';
import { askHistoryText } from './ask.js';

/** Longest base64 JPEG accepted from the page (a 640-pixel frame is around 60 000). */
export const MAX_FRAME_CHARS = 1500000;
/** Most frames a single request can carry, whatever the settings say. */
export const MAX_FRAMES = 12;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function shorten(text, n) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Frames from the page, checked: base64 JPEG data only (no data: prefix), a
 * time in seconds, in time order, at most `max` spread over the stretch.
 * The page is not trusted to send anything else.
 */
export function sanitizeFrames(list, { max = MAX_FRAMES } = {}) {
  if (!Array.isArray(list)) return [];
  const frames = list
    .filter((f) => f && typeof f.data === 'string' && f.data.length > 0 && f.data.length <= MAX_FRAME_CHARS && Number.isFinite(f.time) && f.time >= 0)
    .filter((f) => BASE64.test(f.data))
    .map((f) => ({ time: Math.round(f.time * 10) / 10, data: f.data }))
    .sort((a, b) => a.time - b.time);
  return pickEvenly(frames, Math.max(1, Math.min(MAX_FRAMES, Math.floor(max) || 1)));
}

export function frameLabel(time) {
  return `Frame at ${formatTime(time)} (${time.toFixed(1)} s):`;
}

const labelled = (frames) => frames.map((f) => ({ ...f, label: frameLabel(f.time) }));

const CUE_SHAPE =
  '{"start": number, "gap": number, "kind": "visual" | "text", "priority": 1 | 2 | 3, "onScreenText": string, "confidence": "high" | "medium" | "low", "brief": string, "standard": string, "detailed": string}';

/** The answer formats in words, for models without a response schema. */
export const JSON_SHAPES = Object.freeze({
  script: `Answer with one JSON object and nothing else (no markdown, no code fence), with the keys in this order: {"videoType": "entertainment" | "tutorial" | "other", "characters": [{"label": string, "description": string}], "cues": [${CUE_SHAPE}]}.`,
  revise: `Answer with one JSON object and nothing else (no markdown, no code fence): {"cues": [${CUE_SHAPE}]}.`,
  ask: 'Answer with one JSON object and nothing else (no markdown, no code fence), with the keys in this order: {"time": number, "confidence": "high" | "medium" | "low", "answer": string}.',
});

const FRAMES_NOTE = [
  '',
  'What you are given:',
  '- Still frames taken from the video while it plays, each labelled with its time in seconds from the start of the full video. You do not see the motion between frames, and you cannot hear the sound.',
  '- Describe only what the frames show. Do not invent what happened between two frames; when a change between frames is clear (someone has sat down, the place is different), say what is different now.',
  '- Give each description the "start" of the frame it is based on.',
  '- You cannot hear when people speak: estimate "gap" from the picture (a person facing the camera with an open mouth is probably speaking), and use 3 when you cannot tell. The player corrects it from the subtitles when there are any.',
  '- Descriptions given just before these frames are listed in the request: do not say them again. When nothing new and important is visible, return an empty "cues" list.',
].join('\n');

const peopleLine = peopleText;

function videoLines(meta = {}, duration) {
  return [
    `Video title: ${shorten(meta.title, 200) || 'unknown'}`,
    meta.channel ? `Uploader: ${shorten(meta.channel, 100)}` : '',
    meta.description ? `Video description (from the uploader): ${shorten(meta.description, 1000)}` : '',
    Number.isFinite(duration) && duration > 0 ? `Full video length: ${formatTime(duration)} (${Math.round(duration)} seconds).` : '',
  ];
}

/**
 * Describe one stretch of video from its frames.
 * @param {object} p
 * @param {{start: number, end: number}} p.window  the stretch, in seconds
 * @param {Array<{start: number, text: string}>} [p.recent]  descriptions just before it
 */
export function framesScriptPrompt({ meta, window, duration, characters = [], recent = [], lang, frames }) {
  const { start, end } = window;
  return {
    kind: 'script',
    system: `${scriptInstructions(lang)}\n${FRAMES_NOTE}`,
    jsonShape: JSON_SHAPES.script,
    frames: labelled(frames),
    text: [
      ...videoLines(meta, duration),
      `The ${frames.length} frames above were taken between ${formatTime(start)} and ${formatTime(end)} (${start}s to ${end}s) of the full video. Describe only this stretch. "start" is in seconds from the start of the full video.`,
      start < 2 ? 'This is the very start of the video: begin with the establishing description.' : '',
      recent.length ? `Already described just before (do not say again what is still the same): ${recent.map((r) => `${formatTime(r.start)} ${shorten(r.text, 160)}`).join(' | ')}` : '',
      peopleLine(characters),
      `Write in ${languageName(lang)}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    maxTokens: 8192,
    temperature: 0.4,
  };
}

/** Answer a question about the moment the viewer is at, from the frames up to it. */
export function framesAskPrompt({ meta, time, duration, question, nearbyText, history, characters, lang, frames }) {
  return {
    kind: 'ask',
    system: [
      'You help a blind or low-vision person understand a video they are watching.',
      `Answer in ${languageName(lang)}, in at most 3 short sentences, plain text without markdown.`,
      'You are given still frames from the video, each labelled with its time, taken up to the moment they asked. You do not see the motion between frames and you cannot hear the sound.',
      'Base the answer on what the frames show, at or just before the moment they asked. Describe what is visible: do not guess what people feel or intend, do not judge, and name a person only if on-screen text gives the name.',
      'Quote any text on screen that bears on the question exactly as written.',
      'If the frames do not show the answer, or you cannot see it clearly, say so plainly (for example "I can\'t tell from the picture", or in Chinese "画面上看不清") and set "confidence" to "low". Never invent details.',
      '"time": the moment your answer is about, in seconds from the start of the full video: the time of the frame that shows it. SceneVoice says that moment before your answer, so do not put a time in "answer".',
      '"confidence": "high" when the answer is clearly visible, "medium" when part of it is inferred, "low" when you are not sure.',
      'The recent audio descriptions were written by an AI and can be wrong: check them against the picture, and do not repeat them as fact.',
    ].join('\n'),
    jsonShape: JSON_SHAPES.ask,
    frames: labelled(frames),
    text: [
      `Video title: ${shorten(meta?.title, 200) || 'unknown'}`,
      Number.isFinite(duration) && duration > 0 ? `Full video length: ${formatTime(duration)} (${Math.round(duration)} seconds).` : '',
      `The viewer asked at ${formatTime(time)} (${Math.round(time)} seconds).`,
      nearbyText ? `Recent audio descriptions (may be wrong): ${shorten(nearbyText, 800)}` : '',
      peopleLine(characters),
      askHistoryText(history),
      `Question: ${shorten(question, 500)}`,
    ]
      .filter(Boolean)
      .join('\n'),
    maxTokens: 1024,
    temperature: 0.2,
  };
}

/** Describe again, from its frames, a moment whose description the viewer marked as wrong. */
export function framesRevisionPrompt({ meta, duration, cue, characters = [], lang, frames }) {
  return {
    kind: 'revise',
    system: `${scriptInstructions(lang)}\n${FRAMES_NOTE}`,
    jsonShape: JSON_SHAPES.revise,
    frames: labelled(frames),
    text: [
      ...videoLines(meta, duration),
      `A viewer reported that this description, at ${formatTime(cue.start)} (${cue.start} seconds), is wrong:`,
      `"${shorten(cue.standard, 600)}"`,
      cue.kind === 'text' && cue.onScreenText ? `It was given as on-screen text reading: "${shorten(cue.onScreenText, 600)}"` : '',
      `Look again, closely, at the frames above and write a corrected description of that moment: one cue, with "start" at ${cue.start}.`,
      '- Check every detail against the picture: people, actions, objects, colours, numbers and text. Leave out anything you cannot clearly see.',
      '- Do not repeat the reported description, and do not just reword it. Keep only what you can confirm in the picture.',
      '- If you are still not sure, say so in the description ("appears to", "hard to see") and set "confidence" to "low".',
      '- If, looking again, nothing at that moment is worth describing, return an empty "cues" list.',
      peopleLine(characters),
      `Write in ${languageName(lang)}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    maxTokens: 4096,
    temperature: 0.2,
  };
}
