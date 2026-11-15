// A small JSON-schema checker: enough of the vocabulary to say what is wrong
// with a model's answer before the engine uses it. Only some providers can be
// held to a schema (catalog.js `json`), and none of them is trusted to have kept
// to it, so every answer is checked here against the same schema the prompt
// carries. The problems are sentences with a path, fit to log or to send back
// to the model with a request to repair its answer. No dependencies.

const TYPES = new Map([
  ['string', (v) => typeof v === 'string'],
  // JSON has no NaN or Infinity: a value that is one did not come from an answer.
  ['number', (v) => typeof v === 'number' && Number.isFinite(v)],
  ['integer', (v) => Number.isInteger(v)],
  ['boolean', (v) => typeof v === 'boolean'],
  ['array', (v) => Array.isArray(v)],
  ['object', (v) => v !== null && typeof v === 'object' && !Array.isArray(v)],
  ['null', (v) => v === null],
]);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);

/** "string", "string or null", "string, number or null". */
function listed(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/** The path of a property or an item: cues[2].priority, and ["odd key"] for a key that is not a plain word. */
function join(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  if (/^[A-Za-z_$][\w$]*$/.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${JSON.stringify(key)}]`;
}

function walk(value, schema, path, problems) {
  if (!isObject(schema)) return;
  // '$' stands for the whole answer, which has no path of its own.
  const say = (problem, at = path) => problems.push(`${at || '$'}: ${problem}`);

  if (schema.type !== undefined) {
    const names = (Array.isArray(schema.type) ? schema.type : [schema.type])
      .map((name) => String(name).toLowerCase())
      .filter((name) => TYPES.has(name));
    if (names.length && !names.some((name) => TYPES.get(name)(value))) {
      // The wrong type makes every other rule about this value meaningless: say it once.
      say(`expected ${listed(names)}`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    say(`expected one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) say(`expected at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) say(`expected at most ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) say(`expected at most ${schema.maxItems} items`);
    if (isObject(schema.items)) value.forEach((item, i) => walk(item, schema.items, join(path, i), problems));
    return;
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!own(value, key) || value[key] === undefined) say('missing', join(path, key));
    }
    for (const key of Object.keys(properties)) {
      if (own(value, key) && value[key] !== undefined) walk(value[key], properties[key], join(path, key), problems);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!own(properties, key)) say('not expected', join(path, key));
      }
    }
  }
}

/**
 * What is wrong with a value, by a JSON schema. [] when it fits.
 *
 * Understands `type` (string, number, integer, boolean, array, object, null,
 * or a list of them; upper case as Gemini writes them is read too),
 * `properties`, `required`, `items`, `enum`, `minimum`, `maximum`, `maxItems`
 * and `additionalProperties: false`. Any other keyword is ignored, and a
 * missing schema accepts everything.
 *
 * Each problem is "path: what was expected", in the order met:
 *   "cues[2].priority: expected integer"      a wrong type (nothing else is said about that value)
 *   "cues[0].kind: expected one of "visual", "text""
 *   "cues[0].priority: expected at most 3"    or "at least"
 *   "cues: expected at most 40 items"
 *   "cues[1].brief: missing"                  a required property
 *   "cues[1].colour: not expected"            with additionalProperties: false
 *   "$: expected object"                      the answer itself
 * @param {*} value    parsed JSON
 * @param {object} schema
 * @returns {string[]}
 */
export function check(value, schema) {
  const problems = [];
  walk(value, schema, '', problems);
  return problems;
}
