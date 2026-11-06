import { issues } from './db.js';
import { rankSimilar } from './similarity.js';

/**
 * Other issues in the same guild that look similar to `issue` (fuzzy text match), best first.
 * Used to show "possibly related" pairs and to suggest merge targets.
 */
export function relatedIssues(issue, { limit = 3, min = 0.12 } = {}) {
  const all = issues.withText(issue.guild_id);
  const self = all.find((d) => d.id === issue.id);
  if (!self) return [];
  return rankSimilar(self.text, all.filter((d) => d.id !== issue.id))
    .filter((r) => r.score >= min)
    .slice(0, limit);
}
