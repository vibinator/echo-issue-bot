// Starter articles for answers that change often (known bugs, "no ETA yet"). They are added to each server's own
// knowledge articles ONCE, so developers can edit, switch off or delete them from the panel without a code update.
// A deleted starter never comes back: the ids already added are remembered per server.
import { articles, settings } from './db.js';

export const STARTERS = [
  {
    id: 'cosmetics_not_saving',
    title: 'Cosmetics not saving',
    symptoms: 'cosmetics not saving cosmetics wont save equipped cosmetics reset loadout not saved changes lost after restart equip cosmetic disappears customization not saving customisation settings dont stick',
    body: '- This is a **known bug** that stops some players from **saving their cosmetics** after equipping them.\n- Equip your cosmetics, exit the game and restart to see if the changes saved – but this doesn\'t always work. [Worth a try](https://discord.com/channels/779349159852769310/1094663636947054754/1558505195921604751)!\n- A fix [was deployed](https://discord.com/channels/779349159852769310/779349159852769313/1536839914371682344), but unfortunately it doesn\'t appear to have worked. **There is no ETA yet** for a fix.',
  },
];

/** Add any starter articles this server hasn't had yet. Returns how many were added. Never throws. */
export function seedArticles(guildId) {
  try {
    const cfg = settings.get(guildId);
    if (!cfg) return 0; // not set up yet
    let done;
    try { done = JSON.parse(cfg.seeded_articles ?? '[]'); } catch { done = []; }
    if (!Array.isArray(done)) done = [];
    const have = new Set(articles.list(guildId).map((a) => a.title.toLowerCase()));
    let added = 0;
    for (const s of STARTERS) {
      if (done.includes(s.id)) continue;
      if (!have.has(s.title.toLowerCase())) { articles.add({ guild_id: guildId, title: s.title, symptoms: s.symptoms, body: s.body }); added++; }
      done.push(s.id);
    }
    settings.update(guildId, { seeded_articles: JSON.stringify(done) });
    return added;
  } catch (e) {
    console.error('Could not add starter articles:', e.message);
    return 0;
  }
}
