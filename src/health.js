// "Is this answer actually helping?" – shared by the Results screen and the weekly digest.
import { articles, kbStats } from './db.js';
import { KB } from './kb.js';

const MIN_SHOWN = 5; // too few views to judge
const MIN_BAD = 3;   // …and at least this many "not my problem" / "didn't help" answers

/** The human title of a stats row's answer (built-in "kb:id" or one of the server's own "a:id"). */
export function answerTitle(articleId) {
  return (articleId.startsWith('kb:') ? KB.find((e) => `kb:${e.id}` === articleId)?.title : articles.get(Number(articleId.slice(2)))?.title) ?? '(deleted)';
}

/** Does this stats row look like an answer that isn't helping? */
export function isWeak(s) {
  const bad = s.denied + s.filed;
  return s.shown >= MIN_SHOWN && bad >= MIN_BAD && bad > s.helped;
}

/** Answers that were shown a lot but mostly end in "not my problem" or "send a report" – worst first. */
export function weakAnswers(guildId) {
  return kbStats.forGuild(guildId).filter(isWeak)
    .map((s) => ({ ...s, title: answerTitle(s.article_id), bad: s.denied + s.filed }))
    .filter((s) => s.title !== '(deleted)')
    .sort((a, b) => b.bad / b.shown - a.bad / a.shown);
}
