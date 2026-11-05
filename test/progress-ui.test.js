// @vitest-environment jsdom
// The visible progress box on the player: it sits above the control bar (or at the
// top on Shorts), shows the percent and time left, attaches itself to the player
// even when generation started before the player existed, and stays hidden from
// screen readers, which hear the announcements instead.

import { beforeEach, describe, expect, it } from 'vitest';
import { PageUI } from '../src/content/ui.js';
import { fakeChrome } from './fake-chrome.js';

globalThis.chrome = fakeChrome().chrome;

let place;
let player;
const platform = {
  getPlayer: () => player,
  rightControls: () => null,
  progressPlacement: () => place,
  buttonClass: 'scenevoice-button',
};

const box = (ui) => ui.root.querySelector('.progress');

beforeEach(() => {
  document.body.replaceChildren();
  player = null;
  place = { bottom: '96px' };
});

describe('progress box', () => {
  it('shows section, percent and time left, and is hidden from screen readers', () => {
    player = document.body.appendChild(document.createElement('div'));
    const ui = new PageUI({ onToggle() {}, platform });
    ui.mount();
    ui.showProgress({ done: 1, total: 4, fraction: 0.375, eta: 200 });
    const el = box(ui);
    expect(el.hidden).toBe(false);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.percent').textContent).toBe('38%');
    expect(el.querySelector('.fill').style.width).toBe('38%');
    expect(el.querySelector('.label').textContent).toMatch(/2.*4/);
    expect(el.querySelector('.eta').textContent).toMatch(/4/);
  });

  it('sits above the control bar, measured by the site, and at the top on Shorts', () => {
    player = document.body.appendChild(document.createElement('div'));
    const ui = new PageUI({ onToggle() {}, platform });
    ui.mount();
    expect(box(ui).style.getPropertyValue('--sv-progress-bottom')).toBe('96px');
    expect(box(ui).classList.contains('at-top')).toBe(false);
    place = { top: true };
    ui.mount();
    expect(box(ui).classList.contains('at-top')).toBe(true);
    expect(box(ui).style.getPropertyValue('--sv-progress-bottom')).toBe('');
  });

  it('attaches to the player when progress arrives before the player existed', () => {
    const ui = new PageUI({ onToggle() {}, platform });
    ui.mount(); // no player yet
    expect(ui.host.isConnected).toBe(false);
    player = document.body.appendChild(document.createElement('div'));
    ui.showProgress({ done: 0, total: 1, fraction: 0.1, eta: 30 });
    expect(ui.host.parentNode).toBe(player);
    expect(box(ui).hidden).toBe(false);
  });

  it('uses the same words as the popup for the same progress', () => {
    player = document.body.appendChild(document.createElement('div'));
    const ui = new PageUI({ onToggle() {}, platform });
    ui.mount();
    ui.showProgress({ done: 1, total: 3, fraction: 0.45, eta: 130 });
    const el = box(ui);
    // pages.test.js: the popup shows "Creating descriptions: section 2 of 3 · 45% · About 3 minutes left".
    expect([el.querySelector('.label').textContent, el.querySelector('.percent').textContent, el.querySelector('.eta').textContent].join(' · ')).toBe(
      'Creating descriptions: section 2 of 3 · 45% · About 3 minutes left',
    );
  });

  it('is gone when generation ends', () => {
    player = document.body.appendChild(document.createElement('div'));
    const ui = new PageUI({ onToggle() {}, platform });
    ui.mount();
    ui.showProgress({ done: 0, total: 2, fraction: 0.2, eta: 90 });
    ui.hideProgress();
    expect(box(ui).hidden).toBe(true);
  });
});
