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

const TUTORIAL_TITLE = [
  /\b(tutorials?|how[ -]to|step[ -]by[ -]step|lessons?|lectures?|courses?|explained|explainer|for beginners|recipes?|diy)\b/i,
  /(教程|教学|讲解|入门|课程|详解|如何|手把手|演示|科普|做法|怎么做)/,
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

export function titleLooksLikeTutorial(title) {
  return typeof title === 'string' && TUTORIAL_TITLE.some((re) => re.test(title));
}

/** The type the watch page suggests, from its category and title. '' when it does not say. */
export function pageVideoType({ category, title, platform = 'youtube' } = {}) {
  if (platform === 'bilibili') return bilibiliCategoryType(category) || (titleLooksLikeTutorial(title) ? 'tutorial' : '');
  const c = normalizeCategory(category);
  if (CATEGORY_TYPES[c]) return CATEGORY_TYPES[c];
  if (titleLooksLikeTutorial(title)) return 'tutorial';
  return LOOSE_CATEGORY_TYPES[c] || '';
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
