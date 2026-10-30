// Earlier questions about the same video, sent with a new one so that a
// follow-up ("and what is he holding?") is understood. At most ASK_HISTORY_MAX
// of the latest, each shortened; answers are marked as possibly wrong.

export const ASK_HISTORY_MAX = 3;

const text = (value, n) => (typeof value === 'string' ? value.trim().slice(0, n) : '');

/** Only well-formed { question, answer } pairs, the latest ASK_HISTORY_MAX, shortened. */
export function cleanAskHistory(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((h) => ({ question: text(h?.question, 300), answer: text(h?.answer, 500) }))
    .filter((h) => h.question && h.answer)
    .slice(-ASK_HISTORY_MAX);
}

/** The history as lines of a prompt, or '' when there is none. */
export function askHistoryText(list) {
  const items = cleanAskHistory(list);
  if (!items.length) return '';
  return [
    'Earlier questions from the same viewer about this video, oldest first (the answers were written by an AI and may be wrong). The new question may follow on from them:',
    ...items.map((h, i) => `${i + 1}. Q: ${h.question}\n   A: ${h.answer}`),
  ].join('\n');
}
