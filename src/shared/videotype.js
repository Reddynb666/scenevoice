// What kind of video this is, and the mode, detail and density that suit it.
// No browser APIs here, so everything is unit-testable.
//
// Entertainment (films, music, vlogs, games) is best left flowing: describe in
// the gaps, briefly, only what is needed to follow, and leave quiet moments
// quiet. Tutorials and explainers (lessons, how-to demonstrations, science,
// news with charts) show things that must not be missed: pause, and describe
// in detail. The type comes from what SceneVoice already has, with no
// extra request:
//   1. Gemini's own judgement, returned with the descriptions (it has seen the video);
//   2. the category the uploader chose, from the watch page that is fetched
//      anyway for caption timing (available before any description exists);
//   3. words such as "tutorial" in the title, when the category says little.
// On Bilibili the category is the video's section (分区, "tname").

import { VIDEO_TYPES } from './constants.js';
import { CHOICES } from './settings.js';

/** YouTube's categories. Chinese names too, in case a page gives them localized. */
const CATEGORY_TYPES = {
  'film & animation': 'entertainment',
  music: 'entertainment',
  gaming: 'entertainment',
  comedy: 'entertainment',
  entertainment: 'entertainment',
  sports: 'entertainment',
  'pets & animals': 'entertainment',
  'travel & events': 'entertainment',
  'short movies': 'entertainment',
  movies: 'entertainment',
  shows: 'entertainment',
  trailers: 'entertainment',
  education: 'tutorial',
  'howto & style': 'tutorial',
  'science & technology': 'tutorial',
  'news & politics': 'tutorial',
  电影和动画: 'entertainment',
  音乐: 'entertainment',
  游戏: 'entertainment',
  喜剧: 'entertainment',
  娱乐: 'entertainment',
  体育: 'entertainment',
  宠物和动物: 'entertainment',
  旅游和活动: 'entertainment',
  教育: 'tutorial',
  'diy 和生活百科': 'tutorial',
  科学和技术: 'tutorial',
  新闻和政治: 'tutorial',
};

/** People & Blogs is YouTube's default for new uploads: mostly vlogs, but the title gets a say first. */
const LOOSE_CATEGORY_TYPES = {
  'people & blogs': 'entertainment',
  人物和博客: 'entertainment',
};

/**
 * The same categories by YouTube's numeric id (the Data API's videoCategories
 * list), which a watch page may carry next to the name. The id is the same in
 * every page language, so it is preferred when present. 30–44 are film genres.
 * Left out, like their names: Autos & Vehicles (2), Nonprofits (29),
 * Documentary (35); the title decides for those.
 */
const CATEGORY_ID_TYPES = {
  1: 'entertainment', // Film & Animation
  10: 'entertainment', // Music
  15: 'entertainment', // Pets & Animals
  17: 'entertainment', // Sports
  18: 'entertainment', // Short Movies
  19: 'entertainment', // Travel & Events
  20: 'entertainment', // Gaming
  23: 'entertainment', // Comedy
  24: 'entertainment', // Entertainment
  25: 'tutorial', // News & Politics
  26: 'tutorial', // Howto & Style
  27: 'tutorial', // Education
  28: 'tutorial', // Science & Technology
  30: 'entertainment', // Movies
  31: 'entertainment', // Anime/Animation
  32: 'entertainment', // Action/Adventure
  33: 'entertainment', // Classics
  34: 'entertainment', // Comedy (film)
  36: 'entertainment', // Drama
  37: 'entertainment', // Family
  38: 'entertainment', // Foreign
  39: 'entertainment', // Horror
  40: 'entertainment', // Sci-Fi/Fantasy
  41: 'entertainment', // Thriller
  42: 'entertainment', // Shorts
  43: 'entertainment', // Shows
  44: 'entertainment', // Trailers
};

/** Videoblogging (21) and People & Blogs (22): the title gets a say first. */
const LOOSE_CATEGORY_ID_TYPES = { 21: 'entertainment', 22: 'entertainment' };

/**
 * Words in a title that mark a lesson or a demonstration. One pattern per
 * script: \b only works between ASCII letters, so the Latin-script languages
 * share one and the others match bare, as phrases long enough not to be found
 * inside unrelated words.
 */
const TUTORIAL_TITLE = [
  // English
  /\b(tutorials?|how[ -]to|step[ -]by[ -]step|lessons?|lectures?|courses?|explained|explainer|for beginners|recipes?|diy)\b/i,
  // Spanish, Portuguese, French, German
  /\b(tutoriales|tutoriais|tutoriels?|tutos?|c[oó]mo (hacer|usar|instalar|preparar)|como (fazer|usar|instalar|preparar)|comment (faire|utiliser|installer|pr[ée]parer)|paso a paso|passo a passo|pas [àa] pas|schritt f[üu]r schritt|lecci[oó]n(es)?|li[çc][ãa]o|li[çc][õo]es|aulas?|le[çc]ons?|lektion(en)?|cursos?|cours|kurs(e|us)?|explicad[oa]|explicaci[oó]n|explica[çc][ãa]o|expliqu[ée]e?s?|explication|erkl[äa]rt|erkl[äa]rung|anleitung|so geht'?s|para (principiantes|iniciantes)|pour d[ée]butants|f[üu]r anf[äa]nger|recetas?|receitas?|recettes?|rezepte?)\b/i,
  // Indonesian
  /\b(cara (membuat|menggunakan|memasang|mengatasi|belajar|install|setting)|langkah demi langkah|belajar|pelajaran|kursus|penjelasan|untuk pemula|resep)\b/i,
  // Vietnamese
  /(hướng dẫn|cách làm|cách sử dụng|cách cài|từng bước|bài học|bài giảng|khóa học|giải thích|cho người mới|công thức)/i,
  // Chinese
  /(教程|教学|讲解|入门|课程|详解|如何|手把手|演示|科普|做法|怎么做)/,
  // Japanese
  /(講座|解説|入門|やり方|作り方|使い方|初心者向け|初心者|チュートリアル|レシピ)/,
  // Korean
  /(강의|강좌|입문|하는 법|하는법|만드는 법|만들기|초보자|초보|튜토리얼|레시피|설명)/,
  // Russian
  /(урок|обучени|инструкци|как сделать|как настроить|как установить|пошагов|объясн|для начинающих|рецепт|разбор|гайд|туториал)/i,
  // Arabic
  /(شرح|درس|دروس|دورة|تعليم|تعلم|كيف|خطوة بخطوة|للمبتدئين|وصفة|طريقة)/,
  // Hindi
  /(ट्यूटोरियल|सीखें|सीखो|सीखिए|कैसे बनाएं|कैसे बनाये|कैसे करें|तरीका|पाठ|कोर्स|शुरुआती|रेसिपी|समझाया)/,
];

/**
 * Bilibili's sections, matched by keyword: there are many sub-sections and
 * their names change (待确认 against the current list). Teaching words win, so
 * "音乐教学" is a tutorial and "音乐现场" entertainment.
 */
const BILIBILI_TUTORIAL = /(知识|科普|科学|学习|校园|职业|职场|技能|教程|教学|课程|财经|商业|社科|法律|心理|人文|历史|计算机|软件|编程|数码|科技|设计|手工|绘画|美食制作|汽车知识|健身)/;
const BILIBILI_ENTERTAINMENT = /(游戏|音乐|演奏|翻唱|MV|舞蹈|宅舞|动画|番剧|国创|鬼畜|影视|电影|电视剧|综艺|娱乐|明星|搞笑|日常|vlog|萌宠|动物|运动|体育|赛事|旅游|出行|美妆|穿搭|时尚|ASMR)/i;

/** The type a Bilibili section suggests, or ''. */
export function bilibiliCategoryType(name) {
  if (typeof name !== 'string' || !name.trim()) return '';
  if (BILIBILI_TUTORIAL.test(name)) return 'tutorial';
  return BILIBILI_ENTERTAINMENT.test(name) ? 'entertainment' : '';
}

function normalizeCategory(category) {
  if (typeof category !== 'string') return '';
  return category.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A YouTube category id as the table's key ("27", from 27 or "27"), or '' for anything else. */
function normalizeCategoryId(id) {
  const s = typeof id === 'number' ? String(id) : typeof id === 'string' ? id.trim() : '';
  return /^\d{1,3}$/.test(s) ? String(Number(s)) : '';
}

export function titleLooksLikeTutorial(title) {
  return typeof title === 'string' && TUTORIAL_TITLE.some((re) => re.test(title));
}

/**
 * The type the watch page suggests, from its category (by id when the page
 * gives one, else by name) and title. '' when it does not say.
 */
export function pageVideoType({ category, categoryId, title, platform = 'youtube' } = {}) {
  if (platform === 'bilibili') return bilibiliCategoryType(category) || (titleLooksLikeTutorial(title) ? 'tutorial' : '');
  const id = normalizeCategoryId(categoryId);
  if (CATEGORY_ID_TYPES[id]) return CATEGORY_ID_TYPES[id];
  const c = normalizeCategory(category);
  if (CATEGORY_TYPES[c]) return CATEGORY_TYPES[c];
  if (titleLooksLikeTutorial(title)) return 'tutorial';
  return LOOSE_CATEGORY_ID_TYPES[id] || LOOSE_CATEGORY_TYPES[c] || '';
}

/** A type SceneVoice has settings for, or ''. */
export function knownType(type) {
  return VIDEO_TYPES.includes(type) ? type : '';
}

/** Gemini's judgement when the descriptions carry one, otherwise the watch page's. */
export function resolveVideoType({ scriptType, pageType } = {}) {
  return knownType(scriptType) || knownType(pageType);
}

/** The setting that holds a type's mode, detail or density: ('tutorial', 'mode') → 'tutorialMode'. */
export const typeSettingKey = (type, key) => `${type}${key[0].toUpperCase()}${key.slice(1)}`;

/**
 * The mode, detail and density to use for a video of this type instead of the
 * user's settings: only those that differ, and never one the user picked
 * themselves. Empty when adjusting is off or the type is unknown.
 * @returns {{mode?: string, detail?: string, density?: string}}
 */
export function typeAdjustments(settings, type) {
  const out = {};
  if (!settings?.autoByType || !knownType(type)) return out;
  for (const key of CHOICES) {
    if (settings[`${key}Chosen`]) continue;
    const value = settings[typeSettingKey(type, key)];
    if (value && value !== settings[key]) out[key] = value;
  }
  return out;
}
