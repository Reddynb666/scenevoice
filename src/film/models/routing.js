// Which model a task goes to, and whether that model may be trusted with
// people. Descriptions that name or track characters are only as good as the
// model's habit of writing the token it was given for a person; K1 measures that
// habit per model. A model that has not passed is still used, but the caller
// is told to describe people by their visual labels only, and why.

import { ApiError } from '../../shared/errors.js';
import { MODELS, PRESETS, TASKS, findModel, supportsCharacterLock } from './catalog.js';

/** A preset's own entry for a task, never something inherited from Object.prototype. */
function presetId(presets, preset, task) {
  const own = (o, key) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, key);
  if (!own(presets, preset) || !own(presets[preset], task)) return undefined;
  return presets[preset][task];
}

/**
 * The model for a task.
 * @param {'triage'|'narrate'|'names'} task
 * @param {object} [o]
 * @param {'cn'|'global'} [o.preset]      which preset to take the model from
 * @param {boolean} [o.characterLock]     the caller would like descriptions that follow characters
 * @param {ReadonlyArray<object>} [o.catalog]  MODELS, or MODELS with the listener's own endpoints
 * @param {object} [o.presets]
 * @param {string|object} [o.model]       the listener's own choice, which overrides the preset: an id
 *   in the catalog, or an entry itself (catalog.js customModel)
 * @returns {{model: object, characterLock: boolean, reason: ''|'k1-not-run'|'k1-failed'}}
 *   characterLock is true only for 'narrate', when it was asked for and the model's K1 run passed.
 *   Otherwise the model is still returned, and for 'narrate' the reason says why the lock is off:
 *   'k1-not-run' (no result yet) or 'k1-failed'. The reason is '' when the lock is on, was not
 *   asked for, or the task has no people to lock.
 * @throws {ApiError} 'no-model' for an unknown task, preset or model
 */
export function route(task, { preset = 'cn', characterLock = true, catalog = MODELS, presets = PRESETS, model } = {}) {
  if (!TASKS.includes(task)) throw new ApiError('no-model', `unknown task: ${String(task)}`);
  const explicit = model !== undefined && model !== null && model !== '';
  const wanted = explicit ? model : presetId(presets, preset, task);
  // An entry passed whole is the listener's own endpoint: it need not be in the catalog.
  const entry = wanted && typeof wanted === 'object' ? (typeof wanted.id === 'string' && wanted.id ? wanted : undefined) : findModel(wanted, catalog);
  if (!entry) throw new ApiError('no-model', explicit ? `unknown model: ${String(model?.id ?? model)}` : `no ${task} model in preset ${String(preset)}`);
  if (task !== 'narrate' || !characterLock) return { model: entry, characterLock: false, reason: '' };
  if (supportsCharacterLock(entry)) return { model: entry, characterLock: true, reason: '' };
  return { model: entry, characterLock: false, reason: entry.k1 ? 'k1-failed' : 'k1-not-run' };
}
