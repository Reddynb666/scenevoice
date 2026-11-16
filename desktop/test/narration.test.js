// The fake narration: the script file itself, and which description is due when.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { clock, cueAt, dueCues, durationParts, namesAt, prepareScript } from '../renderer/narration.js';

const DESKTOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'renderer', 'sample', 'narration.json'), 'utf8'));
const zh = prepareScript(data, 'zh');
const en = prepareScript(data, 'en');

describe('narration.json', () => {
  it('has about ten descriptions in Chinese and English, in time order, inside the clip', () => {
    expect(data.cues.length).toBeGreaterThanOrEqual(9);
    expect(data.cues.length).toBeLessThanOrEqual(12);
    expect(zh.cues).toHaveLength(data.cues.length);
    expect(en.cues).toHaveLength(data.cues.length);
    const times = zh.cues.map((c) => c.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBeGreaterThan(1);
    expect(times[times.length - 1]).toBeLessThan(zh.duration);
    for (const cue of data.cues) {
      expect(/[一-鿿]/.test(cue.zh), cue.id).toBe(true);
      expect(/^[\x20-\x7e]+$/.test(cue.en), cue.id).toBe(true);
    }
  });

  it('leaves room to say each description before the next is due', () => {
    for (let i = 1; i < zh.cues.length; i += 1) {
      expect(zh.cues[i].t - zh.cues[i - 1].t).toBeGreaterThanOrEqual(1.9);
    }
  });

  it('introduces a named character with a look and an outfit in the first description', () => {
    const first = data.cues[0];
    expect(first.people).toEqual(['celia']);
    expect(first.zh.startsWith('希莉亚，')).toBe(true);
    expect(first.zh).toMatch(/女人.*穿/);
    expect(first.en.startsWith('Celia, ')).toBe(true);
    expect(first.en).toMatch(/woman.*jacket/);
  });

  it('uses the name alone afterwards', () => {
    const later = data.cues.slice(1).filter((c) => c.people.includes('celia'));
    expect(later.length).toBeGreaterThan(0);
    for (const cue of later) {
      expect(cue.zh).toContain('希莉亚');
      expect(cue.zh).not.toMatch(/女人|马尾/);
      expect(cue.en).not.toMatch(/woman|ponytail/);
    }
  });

  it('uses one fixed label for a person the film has not named', () => {
    const label = data.people.glasses;
    const cues = data.cues.filter((c) => c.people.includes('glasses'));
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      expect(cue.zh).toContain(label.zh);
      expect(cue.en.toLowerCase()).toContain(label.en.toLowerCase());
    }
    // W answers with the very same words.
    expect(namesAt(zh, 29)).toEqual([label.zh]);
  });

  it('names in the text exactly the people it lists', () => {
    for (const cue of data.cues) {
      for (const [id, name] of Object.entries(data.people)) {
        const listed = cue.people.includes(id);
        expect(cue.zh.includes(name.zh), `${cue.id} ${id} zh`).toBe(listed);
        expect(cue.en.toLowerCase().includes(name.en.toLowerCase()), `${cue.id} ${id} en`).toBe(listed);
      }
    }
  });

  it('refers only to people of the table, in cues and in the who-table', () => {
    const known = Object.keys(data.people);
    for (const cue of data.cues) for (const id of cue.people) expect(known).toContain(id);
    for (const span of data.who) {
      expect(span.to).toBeGreaterThan(span.from);
      for (const id of span.people) expect(known).toContain(id);
    }
    expect(known).toContain(data.clip.lead);
    expect(zh.leadName).toBe('希莉亚');
    expect(en.leadName).toBe('Celia');
  });
});

describe('dueCues', () => {
  const cues = [
    { id: 'a', t: 4.3 },
    { id: 'b', t: 10.6 },
    { id: 'c', t: 14.6 },
  ];

  it('returns the descriptions whose time passed since the last look', () => {
    expect(dueCues(cues, 4.2, 4.4).map((c) => c.id)).toEqual(['a']);
    expect(dueCues(cues, 4.4, 4.6)).toEqual([]);
    expect(dueCues(cues, 10.0, 10.6).map((c) => c.id)).toEqual(['b']);
    expect(dueCues(cues, 10.6, 10.8)).toEqual([]);
  });

  it('gives nothing across a seek, forwards or backwards', () => {
    expect(dueCues(cues, 2, 12)).toEqual([]);
    expect(dueCues(cues, 12, 4)).toEqual([]);
    expect(dueCues(cues, 4.3, 4.3)).toEqual([]);
  });

  it('fires each description once over a normal playback', () => {
    const fired = [];
    let previous = 0;
    for (let time = 0.25; time <= 20; time += 0.25) {
      fired.push(...dueCues(cues, previous, time).map((c) => c.id));
      previous = time;
    }
    expect(fired).toEqual(['a', 'b', 'c']);
  });
});

describe('cueAt and namesAt', () => {
  it('finds the description for a moment: the latest one at or before it', () => {
    expect(cueAt(zh.cues, 12).id).toBe('c02');
    expect(cueAt(zh.cues, 39.9).id).toBe('c10');
    expect(cueAt(zh.cues, 500).id).toBe('c10');
  });

  it('falls back to the first description before any is due', () => {
    expect(cueAt(zh.cues, 0).id).toBe('c01');
    expect(cueAt([], 3)).toBeNull();
  });

  it('answers who is on screen from the fixed table', () => {
    expect(namesAt(zh, 5)).toEqual(['希莉亚', '汤姆']);
    expect(namesAt(en, 5)).toEqual(['Celia', 'Thom']);
    expect(namesAt(zh, 1)).toEqual([]);
    expect(namesAt(zh, 20)).toEqual([]);
    expect(namesAt(zh, 38)).toEqual(['戴机械目镜的男人']);
    expect(namesAt(zh, 4000)).toEqual([]);
  });
});

describe('clock and durationParts', () => {
  it('writes film times for the log', () => {
    expect(clock(4.3)).toBe('0:04');
    expect(clock(75)).toBe('1:15');
    expect(clock(7449)).toBe('2:04:09');
    expect(clock(-3)).toBe('0:00');
    expect(clock(NaN)).toBe('0:00');
  });

  it('splits a duration for a spoken sentence', () => {
    expect(durationParts(40)).toEqual({ h: 0, m: 0, s: 40 });
    expect(durationParts(7449.4)).toEqual({ h: 2, m: 4, s: 9 });
    expect(durationParts(Infinity)).toEqual({ h: 0, m: 0, s: 0 });
  });
});
