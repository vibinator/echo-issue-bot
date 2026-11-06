// Offline sanity test for grouping logic (no Discord needed): npm test
process.env.DB_PATH = ':memory:';
const assert = (await import('node:assert/strict')).default;
const { fileReport, splitReport, mergeIssues } = await import('./service.js');
const { issues } = await import('./db.js');

const g = 'guild1';
const file = (u, text) => fileReport({ guildId: g, userId: u, text });

const a = file('u1', 'The game crashes every time I join an Echo Arena match on Quest 3');
const b = file('u2', 'Echo VR crashed when joining arena match, Quest 3 freezes then closes');
const c = file('u3', 'My microphone is not working in voice chat, nobody can hear me');
const d = file('u4', 'Mic voice chat broken, people cannot hear me');
const e = file('u5', 'Huge lag and high ping in combat, rubberbanding everywhere');

assert.equal(a.created, true);
assert.equal(b.created, false, 'crash reports should group');
assert.equal(b.issue.id, a.issue.id);
assert.equal(c.created, true, 'mic issue is separate from crash');
assert.equal(d.issue.id, c.issue.id, 'mic reports should group');
assert.equal(e.created, true);
assert.equal(a.issue.category, 'Crash / Freeze');
assert.equal(c.issue.category, 'Audio / Voice');
assert.equal(e.issue.category, 'Network / Lag');

// typos are tolerated
const t1 = file('u7', 'micropone not wroking, voice chta broken');
assert.equal(t1.issue.id, c.issue.id, 'typo mic report should group with mic issue');
const t2 = file('u8', 'terrible laggg and hgih pnig during combat');
assert.equal(t2.issue.id, e.issue.id, 'typo lag report should group with lag issue');

// related pairs: a lag-ish crash report is linked, not merged
const { relatedIssues } = await import('./related.js');
const x = file('u9', 'Controller tracking drifts after boosting in arena on Quest 3');
assert.equal(x.created, true, 'tracking drift is its own issue');
const rel = relatedIssues(issues.get(x.issue.id), { min: 0.03 });
assert.ok(rel.some((r) => r.id === a.issue.id), 'shares arena/Quest 3 with the crash issue -> linked as related');

// fixed + new matching report => reopened
issues.setStatus(a.issue.id, 'fixed', 'dev');
const f = file('u6', 'Crash when joining arena match on Quest 3 again');
assert.equal(f.issue.id, a.issue.id);
assert.equal(f.reopened, true);
assert.equal(issues.get(a.issue.id).status, 'new');

// split + merge
const s = splitReport(b.reportId);
assert.notEqual(s.fresh.id, a.issue.id);
mergeIssues(s.fresh.id, a.issue.id);
assert.equal(issues.get(s.fresh.id), undefined);

// ---- known-problem answers (fuzzy) ----
const { matchKb } = await import('./kb.js');
const kbId = (t) => matchKb(t)?.entry.id ?? null;
assert.equal(kbId('Getting DXGI_ERROR_DEVICE_HUNG when the lobby loads'), 'gpu_hang');
assert.equal(kbId('INSTALL_FAILED_UPDATE_INCOMPATIBLE on my quest'), 'quest_incompatible');
assert.equal(kbId('game exits with code 78'), 'nevr_78');
assert.equal(kbId('my quest says the downlaod was corupted'), 'download_corrupted', 'typos still match');
assert.equal(kbId('no hapitcs rumble in my controllers on rift'), 'haptics', 'typo in haptics');
assert.equal(kbId('echoxr says no openxr runtime'), 'echoxr_exit');
assert.equal(kbId('the scoreboard colour is wrong after the round'), null, 'unrelated text gets no canned answer');

// ---- priority / owner / version / sorting ----
const { settings, reports } = await import('./db.js');
assert.equal(a.issue.priority, 'high', 'crash issues start at high priority');
assert.equal(c.issue.priority, 'normal');
issues.setPriority(e.issue.id, 'critical', 'dev');
issues.setOwner(c.issue.id, 'dev1');
assert.equal(issues.list(g)[0].id, e.issue.id, 'critical sorts first');
assert.deepEqual(issues.list(g, { owner: 'dev1' }).map((i) => i.id), [c.issue.id]);
assert.ok(!issues.list(g, { owner: 'none' }).some((i) => i.id === c.issue.id), 'owned issue is not unassigned');
const v = fileReport({ guildId: g, userId: 'u10', text: 'Menu text overlaps on the settings screen', version: '0.13.14' });
assert.deepEqual(reports.versions(v.issue.id), ['0.13.14']);
issues.setStatus(v.issue.id, 'fixed', 'dev', '0.13.15');
assert.equal(issues.get(v.issue.id).fixed_version, '0.13.15');
const v2 = fileReport({ guildId: g, userId: 'u11', text: 'Settings screen menu text overlaps', version: '0.13.15' });
assert.equal(v2.reopened, true);
assert.equal(v2.fixedVersion, '0.13.15');

// ---- cooldown lookup & report removal ----
assert.ok(reports.lastByUser(g, 'u11') > 0);
assert.equal(reports.lastByUser(g, 'nobody'), null);
reports.delete(v2.reportId);
assert.equal(reports.stats(v2.issue.id).total, 1);

// ---- settings: per-guild threshold ----
settings.set('g2', 'chan', 'role');
settings.update('g2', { threshold: 0.9, dev_channel_id: 'dev' });
assert.equal(settings.get('g2').threshold, 0.9);
const strict1 = fileReport({ guildId: 'g2', userId: 'a', text: 'Crash when joining arena on Quest 3', threshold: 0.9 });
const strict2 = fileReport({ guildId: 'g2', userId: 'b', text: 'Crash when joining arena on Quest 3 headset', threshold: 0.9 });
assert.notEqual(strict1.issue.id, strict2.issue.id, 'a strict threshold keeps near-duplicates separate');

// ---- duplicate review queue ----
const { duplicatePairs } = await import('./service.js');
const { decisions } = await import('./db.js');
const pairs = duplicatePairs('g2', 0.05);
assert.ok(pairs.some((p) => p.a === strict1.issue.id && p.b === strict2.issue.id), 'near-duplicates are queued for review');
decisions.keepSeparate('g2', strict2.issue.id, strict1.issue.id);
assert.ok(!duplicatePairs('g2', 0.05).some((p) => p.a === strict1.issue.id && p.b === strict2.issue.id), '"keep separate" removes the pair');

// ---- digest + CSV export ----
const { db: rawDb } = await import('./db.js');
const { buildDigest } = await import('./digest.js');
const { exportCsv } = await import('./export.js');
const digest = buildDigest(g, 7).toJSON();
assert.ok(digest.fields.length === 5 && digest.description.includes('open'));
issues.setStatus(a.issue.id, 'in_progress', 'dev');
db_ageIssue(a.issue.id, 10);
assert.ok(buildDigest(g, 7).toJSON().fields[3].value.includes(`#${a.issue.id}`), 'stale in-progress issue is flagged');
const csv = exportCsv(g);
assert.ok(csv.issues.toString().includes('title') && csv.reports.toString().includes('issue_title'));
const evil = fileReport({ guildId: 'g3', userId: 'x', text: '=HYPERLINK("http://evil") formula injection test text' });
assert.ok(exportCsv('g3').reports.toString().includes("'=HYPERLINK"), 'CSV cells are neutralised against formulas');

function db_ageIssue(id, days) {
  rawDb.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(Date.now() - days * 864e5, id);
}

// ---- evidence: links & files ----
const { extractLinks, kindOfFile, kindOfLink, linkName } = await import('./evidence.js');
assert.deepEqual(
  extractLinks('see https://youtu.be/abc123, and (https://imgur.com/a/xyz). also https://youtu.be/abc123 ftp://nope javascript:alert(1)'),
  ['https://youtu.be/abc123', 'https://imgur.com/a/xyz'], 'links are extracted, de-duplicated, cleaned; non-http schemes dropped');
assert.equal(extractLinks('a '.repeat(3) + Array.from({ length: 9 }, (_, n) => `https://x.io/${n}`).join(' ')).length, 5, 'max 5 links');
assert.equal(kindOfFile('crash.png', 'image/png'), 'image');
assert.equal(kindOfFile('clip.mp4', 'video/mp4'), 'video');
assert.equal(kindOfFile('output_log.txt', 'text/plain'), 'log');
assert.equal(kindOfFile('thing.bin', ''), 'file');
assert.equal(kindOfLink('https://www.youtube.com/watch?v=1'), 'video');
assert.equal(kindOfLink('https://i.imgur.com/a.png'), 'image');
assert.equal(kindOfLink('https://pastebin.com/xyz'), 'log');
assert.equal(linkName('https://www.youtube.com/watch'), 'youtube.com/watch');

const { attachEvidence, purgeEvidence } = await import('./service.js');
const { evidence } = await import('./db.js');
const { renderIssue } = await import('./render.js');
const sent = [];
let deleted = 0;
const thread = {
  id: 'thread1',
  send: async (m) => { sent.push(m); return { id: `msg${sent.length}`, url: `https://discord.com/channels/g/thread1/msg${sent.length}`, delete: async () => { deleted++; } }; },
  messages: { fetch: async () => ({ delete: async () => { deleted++; } }) },
};
const fakeClient = { channels: { fetch: async () => thread } };
const ev1 = fileReport({ guildId: 'g4', userId: 'p1', text: 'Voice chat is cut off when more than four players talk' });
issues.setThread(ev1.issue.id, 'thread1');
const n = await attachEvidence(fakeClient, ev1.issue, 'p1', ev1.reportId, {
  links: ['https://youtu.be/abc123'],
  files: [{ name: 'shot.png', url: 'https://cdn.discordapp.com/x/shot.png?ex=1', contentType: 'image/png' }, { name: 'output.log', url: 'https://cdn.discordapp.com/x/output.log', contentType: 'text/plain' }],
});
assert.equal(n, 3);
assert.equal(sent.length, 1, 'one thread message carries the links and the re-hosted files');
assert.equal(sent[0].files.length, 2);
assert.ok(sent[0].allowedMentions.parse.length === 0, 'evidence post never pings');
const rows = evidence.forIssue(ev1.issue.id);
assert.deepEqual(rows.map((r) => r.kind).sort(), ['image', 'log', 'video']);
assert.ok(rows.filter((r) => r.kind !== 'video').every((r) => r.url.startsWith('https://discord.com/channels/')), 'files point at the permanent thread message, not the expiring CDN link');
const embed = renderIssue(issues.get(ev1.issue.id)).embeds[0].toJSON();
assert.ok(embed.fields.some((f) => f.name.startsWith('📎 Evidence (3)')), 'evidence shows on the issue');
assert.equal(await attachEvidence(fakeClient, ev1.issue, 'p1', ev1.reportId, {}), 0);

// too-large files fall back to posting links; evidence still saved
const failing = { channels: { fetch: async () => ({ id: 'thread1', send: async (m) => { if (m.files?.length) throw new Error('413'); sent.push(m); return { id: 'm9', url: 'https://discord.com/channels/g/t/m9' }; } }) } };
const ev2 = fileReport({ guildId: 'g4', userId: 'p2', text: 'Screen goes black when switching between lobbies quickly' });
issues.setThread(ev2.issue.id, 'thread1');
assert.equal(await attachEvidence(failing, ev2.issue, 'p2', ev2.reportId, { files: [{ name: 'big.mp4', url: 'https://cdn.discordapp.com/big.mp4', contentType: 'video/mp4' }] }), 1);
assert.ok(sent.at(-1).content.includes('Could not re-host'));

// evidence follows its report on split, follows the issue on merge, and is purged with the report
const sp = splitReport(ev1.reportId);
assert.equal(evidence.forIssue(sp.fresh.id).length, 3, 'evidence moves with a split report');
const evTarget = fileReport({ guildId: 'g4', userId: 'p3', text: 'Completely different: scoreboard shows wrong team colours' });
mergeIssues(sp.fresh.id, evTarget.issue.id);
assert.equal(evidence.forIssue(evTarget.issue.id).length, 3, 'evidence moves on merge');
await purgeEvidence(fakeClient, ev1.reportId);
assert.equal(evidence.forReport(ev1.reportId).length, 0);
assert.ok(deleted >= 1, 'hosted thread message deleted when a report is removed');

// ---- recalculate match after a user edits their report ----
const { rematchReport } = await import('./service.js');
const { reports: R, events, watchers, articles, kbStats } = await import('./db.js');
const G = 'g5';
const mic = fileReport({ guildId: G, userId: 'm1', text: 'Microphone cuts out in voice chat when four people talk at once' });
const score = fileReport({ guildId: G, userId: 'm2', text: 'Scoreboard shows the wrong team colours after the round ends' });
const vague = fileReport({ guildId: G, userId: 'u2', text: 'Something is really wrong whenever I play this thing' });
assert.ok(vague.created, 'a vague report starts as its own issue');
R.update(vague.reportId, { text: 'My microphone cuts out in voice chat when many people talk', platform: 'Quest 3', version: '0.13.14' });
assert.ok(R.get(vague.reportId).edited_at, 'edits are timestamped');
const moved = rematchReport(vague.reportId, 'u2');
assert.equal(moved.action, 'moved', 'new details match the mic issue better');
assert.equal(moved.to.id, mic.issue.id);
assert.equal(moved.fromDeleted, true, 'the now-empty vague issue is removed');
assert.equal(issues.get(vague.issue.id), undefined);
assert.equal(rematchReport(vague.reportId, 'u2').action, 'same', 'a second recalculation changes nothing');
assert.ok(events.forIssue(mic.issue.id).some((e) => e.kind === 'rematched'), 'recalculation is recorded in the timeline');

const wander = fileReport({ guildId: G, userId: 'u4', text: 'Microphone voice chat cuts out when four people talk' });
assert.equal(wander.issue.id, mic.issue.id);
R.update(wander.reportId, { text: 'Texture on the arena floor flickers badly near the goals', platform: '', version: '' });
const split = rematchReport(wander.reportId, 'u4');
assert.equal(split.action, 'split', 'details that no longer fit are split into their own issue');
assert.notEqual(split.to.id, mic.issue.id);
assert.equal(R.get(wander.reportId).issue_id, split.to.id);
issues.setStatus(score.issue.id, 'fixed', 'dev', '0.13.15');
R.update(split.to ? wander.reportId : 0, { text: 'Scoreboard colours wrong for the teams after the round', platform: '', version: '' });
const toFixed = rematchReport(wander.reportId, 'u4');
assert.equal(toFixed.action, 'moved');
assert.equal(toFixed.reopened, true, 'moving into a fixed issue reopens it');

// ---- developer knowledge articles + denying suggestions ----
const { suggest } = await import('./kb.js');
const aid = articles.add({ guild_id: G, title: 'Launcher stuck in an update loop', symptoms: 'launcher keeps asking to update over and over\nupdate loop', phrases: 'update loop\nkeeps updating', body: 'Close the launcher from the tray, then reopen it.', link: 'https://example.com/fix', created_by: 'dev' });
const custom = articles.list(G, { enabledOnly: true });
const hit = suggest('my launcher keeps updating forever', custom);
assert.equal(hit[0].id, `a:${aid}`, 'custom article matched by its exact phrase');
assert.ok(hit[0].fix.includes('https://example.com/fix') && hit[0].custom);
const fuzzy = suggest('lanucher stuck updaeting loop', custom);
assert.equal(fuzzy[0]?.id, `a:${aid}`, 'custom article matched fuzzily despite typos');
articles.setEnabled(aid, false);
assert.ok(!suggest('launcher update loop', articles.list(G, { enabledOnly: true })).some((s) => s.custom), 'disabled articles are not suggested');
assert.equal(suggest('failed to load level', [], 3)[0].id, 'kb:failed_to_load_level');
assert.ok(suggest('quest installer wont work', [], 3).length <= 3, 'at most 3 suggestions');
kbStats.bump(G, `a:${aid}`, 'shown'); kbStats.bump(G, `a:${aid}`, 'denied'); kbStats.bump(G, `a:${aid}`, 'denied'); kbStats.bump(G, `a:${aid}`, 'helped');
assert.deepEqual(['shown', 'helped', 'denied', 'filed'].map((f) => kbStats.get(G, `a:${aid}`)[f]), [1, 1, 2, 0]);
assert.throws(() => kbStats.bump(G, 'x', 'bogus'));
articles.update(aid, { title: 'Updated title', symptoms: 'x', phrases: '', body: 'y', link: null });
assert.equal(articles.get(aid).title, 'Updated title');
articles.delete(aid);
assert.equal(articles.get(aid), undefined);

// ---- following, notifications, timeline ----
watchers.add(mic.issue.id, 'follower1');
assert.deepEqual(watchers.forUser(G, 'follower1'), [mic.issue.id]);
const dmd = [];
const dmClient = { users: { fetch: async (id) => ({ send: async () => { dmd.push(id); } }) } };
const { notifyReporters } = await import('./service.js');
await notifyReporters(dmClient, issues.get(mic.issue.id), 'update');
assert.ok(dmd.includes('follower1') && dmd.includes('m1'), 'followers and reporters are both notified');
watchers.remove(mic.issue.id, 'follower1');
assert.deepEqual(watchers.forUser(G, 'follower1'), []);
assert.ok(events.forIssue(mic.issue.id, 20).some((e) => e.kind === 'created'), 'creation is on the timeline');

// ---- developer board ----
const { boardPayload } = await import('./board.js');
const board = boardPayload(G);
assert.equal(board.embeds.length, 2);
const names = board.embeds.flatMap((e) => e.toJSON().fields.map((f) => f.name));
assert.deepEqual(names.map((n) => n.replace(/^\S+\s/, '').replace(/ \(\d+\)/, '')), ['New', 'Seen', 'Fix in progress', 'Fixed', 'Cannot reproduce', "Won't fix"]);
const newCol = board.embeds[0].toJSON().fields[0].value;
assert.ok(newCol.includes(`#${mic.issue.id}`), 'open issues appear as cards in their column');
assert.ok(board.components.length === 2, 'card picker + buttons');
const mineBoard = boardPayload(G, { owner: 'nobody', title: 'Mine' });
assert.ok(mineBoard.embeds[0].toJSON().fields.every((f) => f.value === '_empty_'), 'personal board only shows your cards');

// ---- ticket type: Install issue vs Bug in game ----
const K = 'g6';
const inst = fileReport({ guildId: K, userId: 'a1', kind: 'install', text: 'The installer on my Quest says problem parsing the package when I tap install' });
assert.equal(inst.issue.kind, 'install');
assert.equal(inst.issue.category, 'Install / Setup', 'install issues share one category');
const inst2 = fileReport({ guildId: K, userId: 'a2', kind: 'install', text: 'Quest installer: there was a problem parsing the package after I tap install' });
assert.equal(inst2.issue.id, inst.issue.id, 'install issues group with install issues');
const bugLookalike = fileReport({ guildId: K, userId: 'a3', kind: 'bug', text: 'Quest installer problem parsing the package after I tap install, then the game crashes' });
assert.equal(bugLookalike.created, true, 'a game bug is never merged into an install issue');
assert.equal(bugLookalike.issue.kind, 'bug');
assert.notEqual(bugLookalike.issue.category, 'Install / Setup', 'game bugs are never categorised as install issues');
assert.equal(issues.list(K).filter((x) => x.kind === 'install').length, 1);
// install how-to answers are hidden from "Bug in game" reports, but shown for install issues
const { suggest: sg } = await import('./kb.js');
assert.ok(sg('how do i install echo vr on pc', [], 3, 'install').some((s) => s.id === 'kb:pc_install_howto'));
assert.ok(!sg('how do i install echo vr on pc', [], 3, 'bug').some((s) => s.id === 'kb:pc_install_howto'));
assert.ok(sg('Failed To Load Level', [], 3, 'bug').some((s) => s.id === 'kb:failed_to_load_level'), 'non-install answers still show for bugs');
// splitting keeps the type
const keepKind = splitReport(inst2.reportId);
assert.equal(keepKind.fresh.kind, 'install');
assert.equal(keepKind.fresh.category, 'Install / Setup');

// ---- privacy: erase my data, DM opt-out, retention ----
const { eraseUser, purgeExpired } = await import('./service.js');
const { prefs } = await import('./db.js');
const { privacyPayload, termsPayload, erasePayload } = await import('./legal.js');
const P = 'g7';
const gone = [];
const eraseClient = {
  channels: { fetch: async () => ({ id: 't', delete: async () => gone.push('thread'), send: async () => ({ id: 'm', url: 'u' }), messages: { fetch: async () => ({ delete: async () => gone.push('msg'), edit: async () => {} }) } }) },
  users: { fetch: async (id) => ({ send: async () => { dmd.push(`P:${id}`); } }) },
};
const solo = fileReport({ guildId: P, userId: 'e1', text: 'My controller drifts to the left in combat every single round' });
const shared1 = fileReport({ guildId: P, userId: 'e2', text: 'Voice chat cuts out whenever four players talk at the same time' });
const shared2 = fileReport({ guildId: P, userId: 'e3', text: 'Voice chat cuts out when four players are talking at once' });
assert.equal(shared2.issue.id, shared1.issue.id);
const worked = fileReport({ guildId: P, userId: 'e4', text: 'Scoreboard shows wrong team colours after the round is over' });
issues.setStatus(worked.issue.id, 'in_progress', 'dev');
watchers.add(shared1.issue.id, 'e1'); prefs.setDmOff('e1', true);
await attachEvidence(eraseClient, solo.issue, 'e1', solo.reportId, { links: ['https://imgur.com/a/abc'] });

const r1 = await eraseUser(eraseClient, P, 'e1');
assert.deepEqual(r1, { removed: 1, anonymised: 0 });
assert.equal(issues.get(solo.issue.id), undefined, 'an untouched issue with only that report disappears');
assert.equal(evidence.forReport(solo.reportId).length, 0, 'evidence is removed');
assert.deepEqual(watchers.forUser(P, 'e1'), [], 'follows are removed');
assert.equal(prefs.dmOff('e1'), false, 'preferences are removed');

const r2 = await eraseUser(eraseClient, P, 'e2');
assert.deepEqual(r2, { removed: 1, anonymised: 0 });
assert.ok(issues.get(shared1.issue.id), 'an issue other people reported stays');
assert.ok(!issues.get(shared1.issue.id).title.includes('four players talk at the same time'), "the title taken from the erased report is re-derived from what's left");
assert.equal(R.byUser(P, 'e2').length, 0);

const r3 = await eraseUser(eraseClient, P, 'e4');
assert.deepEqual(r3, { removed: 0, anonymised: 1 }, "a worked-on issue keeps the developers' work");
const kept = issues.get(worked.issue.id);
assert.equal(kept.status, 'in_progress');
assert.ok(!kept.title.toLowerCase().includes('scoreboard'), 'the reporter\'s words leave the title');
const left = R.forIssue(worked.issue.id)[0];
assert.equal(left.user_id, '0');
assert.ok(left.text.startsWith('[removed'), 'report text is replaced');
assert.ok(events.forIssue(worked.issue.id).every((e) => e.actor_id !== 'e4'), 'the user is removed from the timeline');
assert.ok(renderIssue(kept).embeds[0].toJSON().fields.some((f) => f.value.includes('removed user')), 'shown as a removed user, not a broken mention');

// DM opt-out
watchers.add(shared1.issue.id, 'p1'); watchers.add(shared1.issue.id, 'p2');
prefs.setDmOff('p2', true);
dmd.length = 0;
await notifyReporters(eraseClient, issues.get(shared1.issue.id), 'status changed');
assert.ok(dmd.includes('P:p1') && !dmd.includes('P:p2'), 'users who turned DMs off are not messaged');
assert.ok(!dmd.includes('P:0'), 'removed users are never messaged');

// retention
const old = fileReport({ guildId: P, userId: 'e5', text: 'Textures flicker on the arena floor when I look at the goal' });
issues.setStatus(old.issue.id, 'fixed', 'dev', '1.0');
const fresh = fileReport({ guildId: P, userId: 'e6', text: 'Disc passes through the goal without counting a score' });
rawDb.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(Date.now() - 400 * 864e5, old.issue.id);
rawDb.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(Date.now() - 400 * 864e5, fresh.issue.id); // old but still open
assert.equal(await purgeExpired(eraseClient, P, 0), 0, 'retention 0 keeps everything');
assert.equal(await purgeExpired(eraseClient, P, 365), 1, 'only closed issues past the retention period are deleted');
assert.equal(issues.get(old.issue.id), undefined);
assert.equal(R.forIssue(old.issue.id).length, 0, 'their reports are deleted too');
assert.ok(issues.get(fresh.issue.id), 'open issues are never auto-deleted');

// legal texts render with the real builders and stay within Discord limits
for (const p of [privacyPayload('123', 365), privacyPayload(null, 0), termsPayload('123'), erasePayload()]) {
  const j = JSON.parse(JSON.stringify(p));
  assert.ok(j.components.length <= 5);
  for (const e of j.embeds) assert.ok(e.description.length <= 4096);
  for (const c of j.components.flatMap((r) => r.components)) assert.ok(c.label.length <= 80);
}
assert.ok(JSON.stringify(privacyPayload('123', 365)).includes('365 days'));
assert.ok(JSON.stringify(privacyPayload('123', 0)).includes('/PRIVACY.md'));

console.log('All tests passed.');
