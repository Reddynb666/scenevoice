# The film engine

Pure logic for SceneVoice 影院版 (the desktop app for films): who is on screen, what
their name is and when it may be spoken, where a description fits between lines of
dialogue, what is sent to a model and how its answer is checked. The plan is
`docs/plan-film-2026-11.zh-CN.md`.

## Rules for this folder

- ES modules with no dependencies. Imports are relative only, and reach only this
  folder and the pure modules of `src/shared` (`script.js`, `scheduler.js`,
  `dialogue.js`, `qwen.js`, `gemini.js`, `errors.js`, `usage.js`, `constants.js`,
  `voices.js`, `progress.js`). Nothing here touches `chrome`, `document`, `window`
  or `navigator`, and nothing imports `node:`, Electron or a package.
  `test/film-purity.test.js` enforces it.
- No translation lookups here: the extension's build scans all of `src/` for
  translation keys. Words the engine itself must produce (the forms of a name in
  Chinese and English) are data in the module that needs them; interface text comes
  from the caller.
- No clocks and no randomness: a function that needs the time takes it as an
  argument. Functions return new values and do not change their arguments.
- Each module has `test/film-<name>.test.js` (vitest).
- Nothing in `src/shared`, the extension or the web player changes for this folder.

## The idea

The model never writes a name. It writes a character token, `{P3}`, for the person
it means. Identity comes from a layer outside the model (`identity.js`): hand labels,
face clusters made on this computer, or, with no faces at all, a text list of people.
`namegate.js` fills each token with a visual label, an introduction or the name,
following the cast (`cast.js`) and the naming policy. `verify.js` refuses a token the
picture does not support. Renaming, merging or confirming a character is therefore a
re-render with no model call.

Types are in `types.js`.

## Modules and their contracts

### cast.js — the cast registry

A character is not a face cluster: one character may have several clusters (ages,
make-up), and the cast carries names and text only. Every function returns a new cast.

```
createCast({ policy }?) -> Cast                    policy defaults to DEFAULT_POLICY
validateCast(raw) -> Cast                          drops unknown fields; throws Error('bad-cast') when raw is not an object
getCharacter(cast, id) -> Character | undefined
addCharacter(cast, fields?) -> { cast, id }        id is 'P' + (highest number in use + 1); defaults: name null, level 0,
                                                   aliases [], descriptor {}, revealAt null, spoilerLock false,
                                                   neverName false, main false, screenSec 0, evidence [], clusters []
updateCharacter(cast, id, patch) -> Cast           only descriptor, say, main, screenSec, revealAt, spoilerLock, neverName, aliases, clusters
levelFromEvidence(evidence, { independentGapSec }) -> { name, level }
    a 'human' entry (not rejected) wins: its name, level 3 (the latest one when there are several);
    otherwise count, per name, the clues that are independent of each other: at least independentGapSec
    apart, or of different kinds; rejected entries do not count. 0 clues -> { name: null, level: 0 };
    the name with most independent clues -> level 1 (one) or 2 (two or more); a tie between two names -> level 1
    with the earlier-evidenced name.
addEvidence(cast, id, evidence) -> Cast            appends, then sets name and level from levelFromEvidence;
                                                   sets revealAt to the earliest clue time when it is null
confirmName(cast, id, { name, by, t }) -> Cast     adds { kind: 'human', by: 'ear'|'sight', name, t }; level 3. Also how a person renames.
rejectName(cast, id, name) -> Cast                 marks every entry for that name rejected (a human entry too), then recomputes
neverName(cast, id, on = true) -> Cast
mergeCharacters(cast, keepId, dropId) -> { cast, remap }   remap is { [dropId]: keepId }; evidence, aliases, clusters and
                                                   appearances move to keepId; the kept character's name and level are recomputed
                                                   (a confirmed name on either side survives; the kept side wins a conflict);
                                                   screenSec adds up; main is true if either was
setAppearance(cast, { char, from, outfit, scene?, src }) -> Cast
    the outfit a character wears from `from` on; closes that character's open appearance at `from`;
    no change when the outfit equals the one current at `from`
appearanceAt(cast, charId, t) -> Appearance | null
exportCast(cast) -> object                         for packages: per character { id, name, level, aliases: [text], say, descriptor,
                                                   revealAt, spoilerLock, neverName, main, confirmedBy: 'ear'|'sight'|null };
                                                   appearances; policy. No clusters, no evidence, no quotes, no constraints, no events.
```

### namegate.js — tokens into words

```
unlocked(character, t, policy, { demoted }?) -> boolean
    false when: no name; level < policy.minLevel; neverName; demoted;
    spoilerLock and (revealAt is null or t < revealAt);
    policy.naming is 'on-reveal' and revealAt is not null and t < revealAt.
renderScript(script, cast, policy?, { lang?, rate?, include?, fits? }?) -> { cues: RenderedCue[], report }
    Walks the cues in time order (those `include(cue)` accepts; default all) and fills every token.
    State kept per character: introduced, the outfit last said, the time last mentioned.
    The form of the first token of a character in a cue:
      'label'         not unlocked: the descriptor ("长发女人" / "the woman with long hair")
      'label-outfit'  not unlocked, and the outfit current at the cue has not been said yet (first mention, or it changed):
                      "长发女人，穿着红裙子，" / "the woman with long hair, in a red dress,"
      'intro'         unlocked and not yet introduced:
                        first-appearance: "马修，长发女人，穿着红裙子，" / "Matthew, a woman with long hair in a red dress,"
                        on-reveal:        "长发女人，马修，" / "the woman with long hair, Matthew,"
                      (the outfit part only when one is known)
      'reanchor'      unlocked, introduced, and the outfit changed since it was last said: "马修，换了灰大衣，" / "Matthew, now in a grey coat,";
                      or not mentioned for policy.reanchorAfterSec: "马修，长发女人，" / "Matthew, the woman with long hair,"
      'name'          otherwise: the name
    Later tokens of the same character in the same cue take the short form (the name when unlocked, else the descriptor).
    The three versions of a cue (brief, standard, detailed) are rendered from the same state; the state moves on once per cue.
    When the long form makes even the brief version too long for the slot (`fits(text, room)`, default
    estimateSeconds(text, rate) <= room from shared/script.js), the cue is rendered with short forms and the long form waits
    for the next cue that mentions the character (report.deferred).
    A descriptor that is missing in the language falls back to the other language, then to "某人" / "someone".
    English: the token at the start of a sentence is capitalised; descriptors are stored without an article
    ("woman with long hair"): label form adds "the", the introduction adds "a"/"an".
    Punctuation is not doubled: a form that ends in a comma swallows a comma that follows the token.
    A rendered text that still holds a brace or a bare id (P3) makes the cue `silent: true` (report.silenced).
    report: { introducedAt: { P3: cueId }, deferred: [cueId], silenced: [cueId] }
castIntro(cast, policy, { lang, maxChars = 200 }) -> string
    The spoken introduction before the film: main characters whose name is unlocked at time 0 and who have no spoilerLock,
    by screen time, as "主要人物：马修，长发女人；老陈，戴眼镜的男人。" / "Main characters: Matthew, a woman with long hair; …"
    '' when policy.introBeforeFilm is false or nobody qualifies. Never longer than maxChars: whole entries are dropped from the end.
whoIsOnScreen(visibleIds, cast, policy, t, { lang }) -> string
    The answer to "who is on screen": names for the unlocked, descriptors for the others
    ("画面里：马修；灰大衣男人。" / "On screen: Matthew; the man in the grey coat."); a sentence saying nobody is recognised when the list is empty.
hasResidue(text) -> boolean                        a brace or a bare character id is left in the text
```

### verify.js — what the picture supports

```
normalizeTokens(text) -> string                    full-width braces, inner spaces and lower case become {P3}
violations(cue, cast, { legendIds }) -> [{ type, detail, field }]
    'unknown-token'   a token whose id is not in the cast or not in this section's legend
    'bare-id'         an id or a mark named in the open: P3 without braces, "3 号人物", "红框", "the red box", "person 2"
    'name-leak'       a cast name or alias of two or more characters written in the text of a visual cue.
                      Not in a kind 'text' cue, not inside quotation marks, not inside the cue's onScreenText.
    Fields checked: brief, standard, detailed.
verifyCue(cue, { cast, visible, window = { before: 3, after: 1 }, legendIds, allowNamesWithoutTracks = false })
      -> { cue, status, demoted, violations, trackCheck }
    visible(t0, t1) returns the ids seen between t0 and t1, or null when the identity mode cannot tell.
    A token whose character is not seen in [start - before, end + after] is demoted: its entry in cue.people gets demoted: true
    (the name gate then uses the label). With visible() === null the check is 'n/a': nothing is demoted, and every
    person is demoted unless allowNamesWithoutTracks is true.
    cue.people is rebuilt from the tokens in the text (tracks kept where they were).
    status: 'needs-repair' when there are violations (the caller asks the model once more, then marks the cue 'needs-check'
    and does not speak it), else 'demoted' when someone was demoted, else 'ok'.
repairGeneric(cue, { cast, visibleIds, lang }) -> { cue, repaired, relapse }
    A generic person ("一个女人", "一名男子", "a man", "a woman", "someone") in the text while exactly one main character is
    visible in the cue's window: replaced by that character's token (repaired). With several or none: left alone, relapse true.
verifyScript(script, options) -> { script, report: { checked, demoted, needsRepair, relapses } }
```

### filmscript.js — the script of a film

```
createFilmScript({ filmId, lang, duration }) -> FilmScript
validateFilmScript(raw) -> FilmScript              throws Error('bad-film-script')
normalizeSection(raw, { slots, window, legendIds, lang, nextNumber }) -> { cues, sceneStarts, appearances, problems }
    raw is the model's JSON: { cues: [{ slot, start?, kind, priority, people?, brief, standard, detailed, onScreenText?, confidence? }],
    sceneStarts: [seconds], appearances: [{ char, outfit, from }] }.
    Each cue is bound to its slot (by id; a cue without a valid slot id takes the slot that contains its start; otherwise it is
    dropped with a problem), gets start = slot.start, end = slot.end, a fresh id ('q_' + six digits from nextNumber), status 'ai', by 'ai'.
    Tokens are normalised; people is derived from the tokens; at most one cue per slot (the more important wins);
    texts are trimmed and cut at the engine's hard limits; times outside the window are dropped.
    appearances keep only ids in legendIds and non-empty outfits.
mergeSection(script, section) -> FilmScript        cues sorted by start; a cue for a slot that already has one replaces it only when the existing one is by 'ai'
remapTokens(script, remap) -> FilmScript           after a merge of characters: {P7} becomes {P3} in every text and in people
editCue(script, id, patch) -> FilmScript           a person's edit: text fields, kind, priority, status; by becomes 'human'
toPlayerScript(renderedCues, { videoId, lang, duration }) -> object
    The extension's version-2 script shape, so the existing Playback can play it: { version: SCRIPT_VERSION, videoId, lang, duration,
    cues: [{ id, start, gap: room, gapMeasured: true, kind: 'visual'|'text', priority, brief, standard, detailed }], characters: [],
    completedUntil: duration, complete: true, model: 'film' }. Silent cues are left out; 'intro' and 'extended' become 'visual'.
textHash(text) -> string                           eight hex digits (FNV-1a), for telling that a recorded or synthesised clip is stale
staleClips(script, renderedCues) -> [cueId]        cues whose clip.textHash differs from the hash of the rendered text of clip.version
```

### timeline.js — where there is room

```
unionIntervals(a, b, join = 0) -> [{ start, end }]
speechFromLines(lines, { join = 0.3 }?) -> [{ start, end }]      subtitle lines to speech intervals (shared/dialogue.js speechIntervals)
budgetFor(room, lang, { rate = DEFAULT_RATE, speed = 1 }?) -> { units, brief, standard, detailed }
    How much can be said in `room` seconds: characters for Chinese, Japanese, Korean; words otherwise. The inverse of
    estimateSeconds. detailed is the full count, standard two thirds, brief one third (whole numbers, never below 0).
buildSlots(speech, duration, { minGap = 1, lead = 0.1, tail = 0.3, lang, rate, speed, src = 'subs' }?) -> Slot[]
    The pauses between speech intervals, from 0 to duration: a slot starts `lead` after speech ends and ends `tail` before it
    resumes; slots with less than minGap of room are left out. ids 'g_0001'… in time order.
slotAt(slots, t) -> Slot | null
slotsBetween(slots, start, end) -> Slot[]
```

### subs.js — subtitle files

```
parseSrt(text) / parseAss(text) / parseVtt(text) -> [{ start, end, text }]   sorted by start
    SRT: comma or full stop before the milliseconds, a byte order mark, CRLF, tags such as <i> removed.
    ASS/SSA: Dialogue lines only (not Comment); the text is everything after the ninth comma (the Format line's order is
    honoured when it differs); override blocks {\…} removed; \N and \n are line breaks; drawing lines (\p1) skipped.
    WebVTT: header, NOTE and STYLE blocks and cue settings ignored; hours optional.
parseSubtitle(text, fileName?) -> [{ start, end, text }]   by extension, else by what the text looks like
decodeSubtitle(bytes) -> string                    a byte order mark, then strict UTF-8, then GB18030 (TextDecoder)
```

### identity.js — who is on screen

```
groundTruthIdentity(labels, { hold = 1 }?) -> IdentityProvider
    labels: [{ t, box: [x, y, w, h], characterId, trackId? }] made by hand. A label counts for `hold` seconds either side of t.
faceClusterIdentity(tracks, characterOfCluster) -> IdentityProvider
    tracks: [{ id, cluster, samples: [{ t, box, conf }] }]; characterOfCluster: { [clusterId]: characterId }.
    A track is visible from its first to its last sample.
promptBankIdentity() -> IdentityProvider           no faces: visibleAt() is [], visibleBetween() is null
Every provider: mode, visibleAt(t) -> Visible[], visibleBetween(t0, t1) -> string[] | null, screenSeconds() -> { [characterId]: seconds }
```

### marks.js — numbered boxes and the legend

```
MARK_COLOURS: [{ id, name: { en, zh }, rgb: [r, g, b] }]   eight colours that stay apart for colour-blind readers
assignMarks(visible, { frame: { w, h }, minFaceArea = 4000 }) -> [{ char, colour, box, kind: 'face'|'person' }]
    One mark per visible character, colours in a stable order by character number; a face smaller than minFaceArea gets a
    person box (the face box widened three times and extended down to the frame's edge, clipped to the frame).
legendText(marks, cast, t, { lang, policy }) -> string
    One line per mark, for the model: "P3 (red box): woman with long hair; wearing: a red dress; confirmed name: Matthew".
    The name is given only when it is unlocked at t (it tells the model whom the dialogue means); the model still writes tokens.
drawMarks(rgb, width, height, marks, { thickness?, scale? }?) -> Uint8Array
    Draws on a copy of an RGB buffer (three bytes per pixel): a rectangle in the mark's colour and, at its top-left corner,
    a filled tag with the id ("P3") in a built-in 5×7 dot font, white on the colour. Everything is clipped to the frame.
    The command line tools and the app share this, so the test of the model (K1) measures what ships.
```

### prompts.js — what the model is asked

The prompts have the provider-neutral shape `src/shared/frames.js` uses
(`{ kind, system, jsonShape, frames: [{ time, data, label }], text, maxTokens, temperature }`), with wording of their own:
the extension's instructions let the model write names and guess pauses, the opposite of what a film section needs.

```
sectionPrompt({ film, lang, window, frames, legend, dialogue, slots, previous, synopsis, policy }) -> prompt
    frames: [{ time, data }] already marked; legend: the text of marks.legendText; dialogue: [{ start, end, text }];
    slots: Slot[] in the window; previous: the last cues' texts; synopsis: the story so far.
    The instructions: describe only what the frames show; refer to people only by their token; never write a name, an id
    in the open, or a colour of a box; outfits go in "appearances", not in the text; one cue per slot at most, within the slot's
    budget for each length; skip a slot when nothing new matters; on-screen text in its own 'text' cue; write in `lang`.
SECTION_SHAPE: string                              the answer format in words
SECTION_SCHEMA: object                             the same as a JSON schema
namesPrompt({ lang, window, lines }) -> prompt     text only: every name the dialogue gives a person, as
                                                   { names: [{ name, kind: 'vocative'|'self-intro'|'third-person', t, line }] }
bindingPrompt({ lang, frames, legend, lines, name }) -> prompt
    Which marked person is addressed or speaking when the name is said: { mark: 'P3' | null, role: 'addressed'|'speaker'|'unknown', confidence }
```

### models/ — many providers behind one table

```
catalog.js   MODELS: [{ id, provider, wire: 'openai'|'gemini', base, regions: ['cn'|'global'], input: ['text','image'],
               json: 'schema'|'object'|'prompt', maxImages, maxTokensField, longContext?: { above, inputX, outputX },
               tasks: ['triage'|'narrate'|'names'], prices: [{ from, currency, input, output }], verified: boolean,
               k1: null | { date, wrongPer100, pass } }]
             findModel(id), priceAt(model, isoDate), estimateCost(model, usage, isoDate), supportsCharacterLock(model),
             PRESETS: { cn: { triage, narrate, names }, global: { … } }
             Entries come from research and are unverified until a real key has run them: verified is false, k1 is null.
routing.js   route(task, { preset, characterLock }) -> { model, characterLock, reason }
             Narration with people goes only to a model whose K1 result passed; otherwise the model is still returned with
             characterLock false and a reason ('k1-not-run' | 'k1-failed'), and the caller uses labels only.
wire.js      buildRequest(model, prompt) -> { wire, body }
               'openai': chat completions with frames as image_url data URLs, response_format by model.json
               ('schema' -> json_schema, 'object' -> json_object, 'prompt' -> none, the shape in words in every case),
               the output limit under model.maxTokensField.
               'gemini': generateContent with inlineData parts and, for 'schema', responseSchema.
             complete(client, model, prompt, { signal, timeoutMs = 120000, retries = 2, sleep }) -> { text, usage, finishReason }
               client is a QwenClient (chat) or a GeminiClient (generate) from src/shared, used as they are.
               Each attempt has its own deadline; a timeout or a network error is tried again; other errors are thrown.
             readJson(text) -> object               the JSON in a reply (shared/script.js extractJson); throws ApiError('bad-json')
json.js      check(value, schema) -> string[]       a small JSON-schema checker (type, properties, required, items, enum)
```
