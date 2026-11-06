// Offline sanity test for grouping logic (no Discord needed): npm test
process.env.DB_PATH = ':memory:';
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
process.env.EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'evr-evidence-')); // uploaded test files go here, not into the project
process.env.EVIDENCE_MAX_MB = '1';
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
const { EVIDENCE_DIR, readStored } = await import('./evidenceStore.js');
const { existsSync } = await import('node:fs');
const posted = []; // anything the bot would post into Discord – must stay empty: attachments are private
const fakeClient = { channels: { fetch: async () => ({ send: async (m) => { posted.push(m); return { id: 'x' }; } }) } };
const downloads = [];
globalThis.fetch = async (url) => {
  downloads.push(String(url));
  const big = String(url).includes('huge');
  const body = Buffer.from(big ? 'x'.repeat(2 * 1024 * 1024) : `bytes of ${String(url).split('/').pop()}`);
  return { ok: !String(url).includes('missing'), status: String(url).includes('missing') ? 404 : 200, headers: { get: () => String(body.length) }, arrayBuffer: async () => body };
};

const ev1 = fileReport({ guildId: 'g4', userId: 'p1', text: 'Voice chat is cut off when more than four players talk' });
const first = await attachEvidence(fakeClient, ev1.issue, 'p1', ev1.reportId, {
  links: ['https://youtu.be/abc123'],
  files: [{ name: 'shot.png', url: 'https://cdn.discordapp.com/x/shot.png?ex=1', size: 10, contentType: 'image/png' }, { name: 'output log.txt', url: 'https://cdn.discordapp.com/x/output.txt', size: 10, contentType: 'text/plain' }],
});
assert.deepEqual([first.saved, first.failed.length], [3, 0]);
assert.equal(posted.length, 0, 'nothing is posted in Discord: attachments stay private');
const rows = evidence.forIssue(ev1.issue.id);
assert.deepEqual(rows.map((r) => r.kind).sort(), ['image', 'log', 'video']);
const stored = rows.filter((r) => r.path);
assert.equal(stored.length, 2, 'uploaded files are saved on disk');
assert.ok(stored.every((r) => r.path.startsWith(`${ev1.reportId}/`) && !/\s/.test(r.path)), 'one private folder per report, with a safe file name');
assert.equal(readStored(stored[0].path).toString(), 'bytes of shot.png?ex=1');
assert.equal(readStored('../../etc/passwd'), null, 'stored files cannot be read from outside the evidence folder');
assert.equal(readStored(`${ev1.reportId}/nope.png`), null);
const embed1 = renderIssue(issues.get(ev1.issue.id)).embeds[0].toJSON();
const evField = embed1.fields.find((f) => f.name.startsWith('📎'));
assert.ok(evField && evField.value.startsWith('3 attached') && !evField.value.includes('youtu.be') && !evField.value.includes('shot.png'),
  'the public card shows only a count – no names and no links');
assert.ok(!JSON.stringify(renderIssue(issues.get(ev1.issue.id)).embeds).includes('youtu.be'), 'no evidence link appears anywhere on the public card');
assert.deepEqual(await attachEvidence(fakeClient, ev1.issue, 'p1', ev1.reportId, {}), { saved: 0, failed: [] });

// later additions don't overwrite earlier files
const more = await attachEvidence(fakeClient, ev1.issue, 'p1', ev1.reportId, { files: [{ name: 'shot.png', url: 'https://cdn.discordapp.com/x/shot2.png', size: 10, contentType: 'image/png' }] });
assert.equal(more.saved, 1);
assert.equal(new Set(evidence.forReport(ev1.reportId).filter((r) => r.path).map((r) => r.path)).size, 3, 'same file name twice -> two separate files');

// refusals: too big, not from Discord, download error – the rest is still saved
const ev2 = fileReport({ guildId: 'g4', userId: 'p2', text: 'Screen goes black when switching between lobbies quickly' });
const mixed = await attachEvidence(fakeClient, ev2.issue, 'p2', ev2.reportId, {
  links: ['https://pastebin.com/xyz'],
  files: [
    { name: 'big.mp4', url: 'https://cdn.discordapp.com/huge.mp4', size: 10, contentType: 'video/mp4' },          // body exceeds the limit
    { name: 'declared.mp4', url: 'https://cdn.discordapp.com/ok.mp4', size: 5 * 1024 * 1024, contentType: 'video/mp4' }, // declared size exceeds the limit
    { name: 'evil.png', url: 'https://evil.example.com/x.png', size: 10, contentType: 'image/png' },                // not Discord
    { name: 'gone.png', url: 'https://cdn.discordapp.com/missing.png', size: 10, contentType: 'image/png' },        // 404
    { name: 'fine.png', url: 'https://cdn.discordapp.com/fine.png', size: 10, contentType: 'image/png' },
  ],
});
assert.equal(mixed.saved, 2, 'the link and the good file are saved');
assert.deepEqual(mixed.failed.map((f) => f.name).sort(), ['big.mp4', 'declared.mp4', 'evil.png', 'gone.png']);
assert.equal(mixed.failed.find((f) => f.name === 'big.mp4').reason, 'too large');
assert.ok(!downloads.some((u) => u.includes('evil.example.com')), 'nothing is ever downloaded from a non-Discord host');

// evidence follows its report on split, follows the issue on merge, and is deleted (files too) with the report
const sp = splitReport(ev1.reportId);
assert.equal(evidence.forIssue(sp.fresh.id).length, 4, 'evidence moves with a split report');
const evTarget = fileReport({ guildId: 'g4', userId: 'p3', text: 'Completely different: scoreboard shows wrong team colours' });
mergeIssues(sp.fresh.id, evTarget.issue.id);
assert.equal(evidence.forIssue(evTarget.issue.id).length, 4, 'evidence moves on merge');
const folder = `${EVIDENCE_DIR}/${ev1.reportId}`;
assert.ok(existsSync(folder));
await purgeEvidence(fakeClient, ev1.reportId);
assert.equal(evidence.forReport(ev1.reportId).length, 0);
assert.ok(!existsSync(folder), 'the stored files are deleted from disk with the report');
assert.equal(posted.length, 0, 'still nothing posted in Discord');

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
assert.deepEqual(names.map((n) => n.replace(/^\S+\s/, '').replace(/ \(\d+\)/, '')), ['New', 'Seen', 'Being fixed', 'Fixed', "Can't reproduce", "Won't fix"]);
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

// ---- answers offered before a ticket form opens ----
const { faqEntries } = await import('./kb.js');
const installList = faqEntries('install');
const bugList = faqEntries('bug');
assert.ok(installList.some((e) => e.id === 'kb:quest_install_howto') && !installList.some((e) => e.id === 'kb:failed_to_load_level'));
assert.ok(bugList.some((e) => e.id === 'kb:failed_to_load_level') && !bugList.some((e) => e.id === 'kb:quest_install_howto'));
assert.ok(installList.length > 5 && bugList.length > 5);
const withOwn = faqEntries('bug', [{ id: 9, title: 'Mine', body: 'Do X', link: 'https://example.com', symptoms: 's' }]);
assert.equal(withOwn[0].id, 'a:9', "the server's own articles come first");
assert.ok(withOwn[0].fix.includes('https://example.com'));
assert.ok(new Set([...installList, ...bugList].map((e) => e.id)).size === installList.length + bugList.length, 'every answer is in exactly one list');

// ---- one public message: new issues post nothing in the channel ----
const { syncMessage } = await import('./service.js');
const channelMsgs = [];
const threadMsgs = [];
const edits = [];
const unarchived = [];
let isArchived = false;
const thr = {
  id: 'th1',
  get archived() { return isArchived; },
  setArchived: async (v) => { isArchived = v; unarchived.push(v); },
  send: async (p) => { threadMsgs.push(p); return { id: `card${threadMsgs.length}`, url: 'u' }; },
  messages: { edit: async (_id, p) => { edits.push(p); } },
};
const parentChan = { id: 'chan', threads: { create: async () => { throw new Error('threads must not be created'); } }, send: async (p) => { channelMsgs.push(p); return { id: 'pub1' }; } };
const tClient = { channels: { fetch: async (id) => (id === 'th1' ? thr : parentChan) } };
const T = fileReport({ guildId: 'g8', userId: 't1', text: 'Disc sometimes disappears right after a goal is scored' });
await syncMessage(tClient, T.issue, 'chan');
const fresh8 = issues.get(T.issue.id);
assert.equal(channelMsgs.length + threadMsgs.length, 0, 'a new issue posts nothing in Discord');
assert.ok(!fresh8.thread_id && !fresh8.message_id, 'and has no thread or card');
// an older issue that still has a thread keeps its card edited in place (and the thread reopened)
issues.setMessage(fresh8.id, 'th1', 'card1');
issues.setThread(fresh8.id, 'th1');
isArchived = true;
await syncMessage(tClient, issues.get(fresh8.id), 'chan');
assert.equal(edits.length, 1, 'an older issue card is edited rather than a new one posted');
assert.deepEqual(unarchived, [false], 'an archived thread is reopened so the card can be edited');
// back button on cards opened from a hidden menu
const withBack = renderIssue(issues.get(T.issue.id), { back: 'browse' });
assert.equal(withBack.components.length, 5);
const lastRowIds = (p) => p.components[4].toJSON().components.map((c) => c.custom_id);
assert.deepEqual(lastRowIds(withBack), [`evall:${T.issue.id}`, 'browse'], 'a menu card gets Back next to View attachments');
assert.deepEqual(lastRowIds(renderIssue(issues.get(T.issue.id))), [`evall:${T.issue.id}`], 'no Back button on the public card');
// controls the viewer can't use are left out
const idsOf = (p) => p.components.flatMap((r) => r.toJSON().components.map((c) => c.custom_id.split(':')[0]));
const asPlayer = idsOf(renderIssue(issues.get(T.issue.id), { viewer: { dev: false, report: true, article: false, userId: 'someone' } }));
assert.ok(asPlayer.includes('plus') && asPlayer.includes('follow'));
assert.ok(!asPlayer.includes('addev'), 'adding attachments is offered only on issues you reported');
assert.ok(!['status', 'prio', 'assign', 'note', 'merge', 'rmrep', 'mkart', 'editmine'].some((x) => asPlayer.includes(x)), 'a player sees no developer controls (and no edit on a report that is not theirs)');
const asOwner = idsOf(renderIssue(issues.get(T.issue.id), { viewer: { dev: false, report: true, article: false, userId: 't1' } }));
assert.ok(asOwner.includes('editmine'), 'the reporter can edit their own report');
assert.ok(asOwner.includes('addev'), 'and add attachments to it');
const asReadOnly = idsOf(renderIssue(issues.get(T.issue.id), { viewer: { dev: false, report: false, article: false, userId: 'x' } }));
assert.ok(!['plus', 'addev', 'editmine'].some((x) => asReadOnly.includes(x)) && asReadOnly.includes('history'), 'someone who cannot report only reads');
assert.ok(!asPlayer.includes('evall') && !asReadOnly.includes('evall'), 'someone with no attachments of their own is not offered View attachments');
const evT = evidence.add({ issue_id: T.issue.id, report_id: reports.forIssue(T.issue.id)[0].id, user_id: 't1', kind: 'link', name: 'clip', url: 'https://example.com/c' });
assert.ok(idsOf(renderIssue(issues.get(T.issue.id), { viewer: { dev: false, report: true, article: false, userId: 't1' } })).includes('evall'), 'the person who attached something can open it');
assert.ok(!idsOf(renderIssue(issues.get(T.issue.id), { viewer: { dev: false, report: true, article: false, userId: 'someone' } })).includes('evall'), 'and nobody else is offered it');
const asDev = idsOf(renderIssue(issues.get(T.issue.id), { viewer: { dev: true, report: true, article: true, userId: 'd' } }));
assert.ok(['status', 'prio', 'assign', 'note', 'merge', 'rmrep', 'mkart'].every((x) => asDev.includes(x)), 'a developer sees everything');

// ---- recovery: re-run /setup keeps settings; a re-created bot reuses existing threads ----
const { settings: S2, summary } = await import('./db.js');
S2.set('g9', 'chanA', 'roleA');
S2.update('g9', { threshold: 0.33, retention_days: 90, dev_channel_id: 'devch', status_role_id: 'sr', panel_message_id: 'pm' });
S2.set('g9', 'chanB', 'roleB'); // what /setup does when run again
const kept9 = S2.get('g9');
assert.equal(kept9.channel_id, 'chanB');
assert.deepEqual([kept9.threshold, kept9.retention_days, kept9.dev_channel_id, kept9.status_role_id], [0.33, 90, 'devch', 'sr'], 're-running /setup keeps every other setting');
const R9 = fileReport({ guildId: 'g9', userId: 'z1', text: 'Voice chat is very quiet for everyone in the lobby' });
assert.deepEqual(summary('g9'), { issues: 1, reports: 1, articles: 0 });

issues.setThread(R9.issue.id, 'oldthread');
issues.setMessage(R9.issue.id, 'oldthread', 'oldcard');
let created9 = 0; const sent9 = [];
const oldThread = {
  id: 'oldthread', archived: false, setArchived: async () => {},
  send: async (p) => { sent9.push(p); return { id: 'newcard' }; },
  // a different (previous) bot account wrote the card, so this bot is not allowed to edit it
  messages: { edit: async () => { throw Object.assign(new Error('Cannot edit a message authored by another user'), { code: 50005 }); } },
};
const parent9 = { id: 'chanB', threads: { create: async () => { created9++; return oldThread; } }, send: async () => ({ id: 'x' }) };
await syncMessage({ channels: { fetch: async (id) => (id === 'oldthread' ? oldThread : parent9) } }, issues.get(R9.issue.id), 'chanB');
assert.equal(created9, 0, 'no duplicate thread is created');
assert.equal(sent9.length, 1, 'a fresh card is posted inside the existing thread');
assert.equal(issues.get(R9.issue.id).message_id, 'newcard', 'and remembered for later edits');
assert.equal(issues.get(R9.issue.id).thread_id, 'oldthread');
// if the thread itself is gone, nothing new is posted (the issue is still in Known issues)
let made9 = 0;
const parent10 = { id: 'chanB', threads: { create: async () => { made9++; return { id: 'brandnew', send: async () => ({ id: 'c2' }) }; } }, send: async () => { made9++; return { id: 'x' }; } };
await syncMessage({ channels: { fetch: async (id) => { if (id === 'chanB') return parent10; throw new Error('Unknown Channel'); } } }, issues.get(R9.issue.id), 'chanB');
assert.equal(made9, 0, 'a vanished thread is not replaced');

// ---- the pre-form description ranks the menu (fuzzy), nothing is searched after submit ----
assert.equal(sg('game crashes when the lobby loads, d3d device removed', [], 25, 'bug')[0].id, 'kb:gpu_hang');
assert.equal(sg('my controllers do not vibrate', [], 25, 'bug')[0].id, 'kb:haptics');
assert.equal(sg('instaler says problem parsing the packge', [], 25, 'install')[0].id, 'kb:quest_parse_package', 'typos still rank the right fix first');
assert.equal(sg('zzz nothing relevant here', [], 25, 'bug').length, 0, 'no close match -> the plain list is shown');
assert.ok(sg('download stuck on quest', [], 25, 'install').length <= 25);

// ---- errors say WHY, in plain words ----
const { explainError, errorMessage, fileFailureReason } = await import('./errors.js');
const mk = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
assert.match(errorMessage(mk(50013, 'Missing Permissions')), /isn't allowed to do that in this channel.*View Channel.*Read Message History/s);
assert.match(errorMessage(mk(50001, 'Missing Access')), /can't see that channel/);
assert.match(errorMessage(mk(10062, 'Unknown interaction')), /expired or was already used.*Press the button/s);
assert.match(errorMessage(mk('EAI_AGAIN', 'getaddrinfo EAI_AGAIN discord.com')), /couldn't reach Discord.*network problem/s);
assert.match(errorMessage(mk(50035, 'Invalid Form Body')), /too long or in the wrong format/);
assert.match(errorMessage(mk('ENOSPC', 'no space left on device')), /out of disk space/);
assert.match(errorMessage(mk(undefined, 'database is locked')), /database had a problem/);
assert.match(errorMessage(new TypeError("Cannot read properties of undefined (reading 'x')")), /unexpected problem \(Cannot read properties of undefined/, 'unknown errors still give the actual reason');
for (const e of [mk(50013, 'x'), mk(1, 'y'), new Error('')]) {
  assert.ok(!/something went wrong/i.test(errorMessage(e)), 'never the vague "something went wrong"');
  assert.ok(explainError(e).reason && explainError(e).fix);
}
assert.equal(fileFailureReason('too large', 25), "it's over the 25 MB limit");
assert.equal(fileFailureReason('not a Discord attachment', 25), "it didn't come from Discord");
assert.match(fileFailureReason('download failed (404)', 25), /error 404/);

// ---- every screen and form builds, and fits Discord's limits (label/description lengths, 5 rows, 5 fields…) ----
const ui = await import('./index.js');
const fi = { guildId: 'g5', user: { id: 'viewer' } };
const sampleIssue = issues.list('g5')[0];
const sampleReport = R.forIssue(sampleIssue.id)[0];
const screens = {
  panel: ui.panelPayload(), devMenu: ui.devMenuPayload(), type: ui.reportTypePayload(),
  quickBug: ui.quickModal('bug'), quickInstall: ui.quickModal('install'), reportBug: ui.reportModal('bug'), reportInstall: ui.reportModal('install', 'prefilled text'),
  meToo: ui.meTooModal(sampleIssue), edit: ui.editModal(sampleReport), addEvidence: ui.addEvidenceModal(sampleReport), note: ui.noteModal(sampleIssue), fixed: ui.fixedModal(sampleIssue),
  faqBug: ui.faqPayload('g5', 'bug'), faqInstall: ui.faqPayload('g5', 'install'), browse: ui.browsePayload(fi, { s: '-', c: '-', o: '-' }),
  settings: ui.settingsPayload('g5'), dups: ui.dupPayload(fi), mine: ui.minePayload(fi), track: ui.trackPayload(fi, sampleIssue),
  articles: ui.articlesPayload('g5'), articleNew: ui.articleModal(null), card: renderIssue(sampleIssue), cardBack: renderIssue(sampleIssue, { back: 'browse' }),
  privacy: privacyPayload('1', 90), terms: termsPayload('1'), erase: erasePayload(), board: boardPayload('g5'), slash: ui.commands,
};
for (const [name, screen] of Object.entries(screens)) {
  const json = JSON.parse(JSON.stringify(screen)); // runs the Discord builders' validation
  const rowsOf = json.components ?? [];
  assert.ok(rowsOf.length <= 5, `${name}: at most 5 rows/fields`);
  assert.ok(rowsOf.every((r) => !r.components || r.components.length <= 5), `${name}: at most 5 buttons per row`);
}
const reportForm = JSON.parse(JSON.stringify(screens.reportBug));
for (const field of reportForm.components) {
  assert.ok(field.label.length <= 45, `form label fits: ${field.label}`);
  assert.ok((field.description ?? '').length <= 100, `form hint fits: ${field.description}`);
}

// ---- the requester is named on the card; a wrongly matched report can be separated and the issue restored ----
const reqA = fileReport({ guildId: 'g10', userId: 'requesterA', text: 'Hand tracking drifts upward whenever I hold the disc near my chest' });
const reqCard = (id) => renderIssue(issues.get(id)).embeds[0].toJSON().fields.find((f) => f.name === 'Requested by').value;
assert.equal(reqCard(reqA.issue.id), '<@requesterA>');
issues.setStatus(reqA.issue.id, 'fixed', 'dev', '2.0');
const reqB = fileReport({ guildId: 'g10', userId: 'requesterB', text: 'Hand tracking drifts upward when I hold the disc near my chest' });
assert.equal(reqB.issue.id, reqA.issue.id, 'a similar report joins the existing issue');
assert.ok(reqB.score > 0.25 && !reqB.created, 'the match score is reported so the player can be shown how alike it was');
assert.equal(reqB.reopened, true);
assert.equal(reqCard(reqA.issue.id), '<@requesterA> + 1 other', 'the requester stays the first person who asked');
const undo = splitReport(reqB.reportId);
assert.equal(issues.get(reqA.issue.id).status, 'fixed', 'separating the report puts the fixed issue back to fixed');
assert.equal(undo.fresh.status, 'new', 'and the separated report is its own new issue');
assert.equal(reqCard(undo.fresh.id), '<@requesterB>');

// ---- matcher quality: realistic sentences (typos, loose wording) find the right answer; look-alikes find nothing ----
const top = (text, kind) => sg(text, [], 3, kind)[0]?.id?.replace('kb:', '') ?? null;
const SHOULD_FIND = [
  ['problm parseing the pakage on my qest', 'quest_parse_package', 'install'],
  ['my quest keeps saying it cant parse the package when installing', 'quest_parse_package', 'install'],
  ['i pressed install then the box went away and nothing installed', 'quest_install_vanishes', 'install'],
  ['pressing install does nothing the dialog just closes', 'quest_install_vanishes', 'install'],
  ['the download of the game files is not moving', 'quest_data_stuck', 'install'],
  ['game data download sits at the same number for ages', 'quest_data_stuck', 'install'],
  ['whats the way to get echo onto my quest', 'quest_install_howto', 'install'],
  ['guide to install echo vr on windows', 'pc_install_howto', 'install'],
  ['i installed the beta and want to go back to stable', 'beta_to_stable', 'install'],
  ['stuck on beta how to return to stable', 'beta_to_stable', 'install'],
  ['launcher eats my gpu even when i am not playing', 'idle_cpu', 'bug'],
  ['launcher running hot using cpu constantly in the background', 'idle_cpu', 'bug'],
  ['do i choose echoxr if i use steam vr', 'steam_players', 'bug'],
  ['the controllers do not shake or vibrate anymore', 'haptics', 'bug'],
  ['hapitc feedbak is missing', 'haptics', 'bug'],
  ['echoxr error code 5 no openxr', 'echoxr_exit', 'bug'],
  ['crash during lobby load, error says the d3d device was removed', 'gpu_hang', 'bug'],
  ['discord login doesnt work in echo', 'login', 'bug'],
  ['game exited with code 78 after update', 'nevr_78', 'bug'],
];
const missed = SHOULD_FIND.filter(([t, want, kind]) => top(t, kind) !== want).map(([t, want, kind]) => `${t} → ${top(t, kind)} (wanted ${want})`);
assert.deepEqual(missed, [], 'realistic sentences find the right known-problem answer');
for (const t of ['goal sound plays twice', 'my avatar is stuck in a t pose', 'vote kick is abused', 'the shop prices are too high', 'emote wheel opens slowly',
  'players clip through walls', 'the intro video cannot be skipped', 'spectator camera is jittery', 'hit detection is off on goalie saves', 'i love this game so much']) {
  assert.equal(top(t, 'bug'), null, `no answer is suggested for "${t}"`);
}
// platform awareness: asking about Quest must not rank the PC guide first, and the other way round
assert.equal(top('how to install echo on quest step by step', 'install'), 'quest_install_howto');
assert.equal(top('how do i install echo on my pc', 'install'), 'pc_install_howto');
// issue grouping understands everyday rewordings
const GDOCS = [{ id: 0, text: 'Game crashes every time I join an arena match on Quest 3' }, { id: 1, text: 'Microphone cuts out in voice chat when four people talk at once' }, { id: 2, text: 'Huge lag and high ping in combat, rubberbanding everywhere' }];
const { rankSimilar } = await import('./similarity.js');
const joins = (t) => { const b = rankSimilar(t, GDOCS)[0]; return b.score >= 0.25 ? b.id : -1; };
assert.equal(joins('the game keeps closing itself when i enter arena on my quest'), 0);
assert.equal(joins('it freezes and then quits when i load into an arena game'), 0);
assert.equal(joins('voice chat randomly drops out when lots of players are speaking'), 1);
assert.equal(joins('really bad ping and rubber banding while fighting'), 2);
assert.equal(joins('the disc passes through the goal without scoring'), -1, 'unrelated reports are not grouped');
// words that merely look like known terms are not "corrected" into them
assert.equal(joins('after the patch the beta build lost the same match'), -1);

// ---- learning from reactions: boosted answers rank higher, "not my problem" ones lower ----
const base = sg('launcher uses lots of cpu', [], 3, 'bug');
const up = sg('launcher uses lots of cpu', [], 3, 'bug', new Map([[base[0].id, 1.2]]));
const down = sg('launcher uses lots of cpu', [], 3, 'bug', new Map([[base[0].id, 0.8]]));
assert.ok(up[0].score > base[0].score && down[0].score < base[0].score, 'feedback nudges the score up or down');
assert.ok(up[0].score <= 1);

// ---- who may manage knowledge articles: developers, plus an optional editor role that unlocks nothing else ----
const fakeMember = (roleIds, manageGuild = false) => ({
  guildId: 'gA',
  memberPermissions: { has: () => manageGuild },
  member: { roles: { cache: { has: (id) => roleIds.includes(id) } } },
});
S2.set('gA', 'chan', 'devrole');
const devUser = fakeMember(['devrole']);
const admin = fakeMember([], true);
const editor = fakeMember(['editorrole']);
const player = fakeMember(['playerrole']);
assert.ok(ui.canManageArticles(devUser) && ui.canManageArticles(admin), 'developers can manage articles');
assert.ok(!ui.canManageArticles(editor), 'an editor role that is not configured gives nothing');
S2.update('gA', { article_role_id: 'editorrole' });
assert.ok(ui.canManageArticles(editor), 'members of the editor role can manage articles');
assert.ok(!ui.canManageArticles(player), 'other members still cannot');
assert.ok(!ui.isDev(editor), 'being an editor does not make someone a developer (board, settings, export… stay locked)');
const editorMenu = JSON.parse(JSON.stringify(ui.articleMenuPayload()));
assert.deepEqual(editorMenu.components.flatMap((r) => r.components.map((c) => c.custom_id)), ['dev:articles'], 'the editor menu holds only the article tools');

// ---- a failed reply must never stop the bot (this crashed the live bot: "Unknown interaction" 10062) ----
const botClient = ui.client;
const fakeClick = (customId, reply) => ({
  guildId: 'gX', customId, user: { id: 'clicker' }, replied: false, deferred: false,
  isChatInputCommand: () => false, isButton: () => true, isModalSubmit: () => false, isStringSelectMenu: () => false, isChannelSelectMenu: () => false,
  reply, followUp: async () => {},
});
let unhandled = 0;
const onUnhandled = () => { unhandled++; };
process.on('unhandledRejection', onUnhandled);
const clientErrors = [];
botClient.on('error', (e) => clientErrors.push(e));
const quiet = console.error; console.error = () => {};
const tooLate = Object.assign(new Error('Unknown interaction'), { code: 10062 });
botClient.emit('interactionCreate', fakeClick('mine', async () => { throw tooLate; }));
const told = [];
let attempts = 0;
botClient.emit('interactionCreate', fakeClick('mine', async (m) => { if (attempts++ === 0) throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); told.push(m.content); }));
await new Promise((resolve) => setTimeout(resolve, 50));
console.error = quiet;
process.off('unhandledRejection', onUnhandled);
assert.equal(unhandled, 0, 'a failed reply is handled instead of escaping as an unhandled rejection');
assert.equal(clientErrors.length, 0, "no stray 'error' event reaches the client (which would crash Node)");
assert.equal(told.length, 1, 'when Discord still allows it, the person is told what went wrong');
assert.match(told[0], /isn't allowed to do that in this channel/, 'and the message gives the reason');

// ---- speed guards (very generous limits – they only catch a return to the old, seconds-long behaviour) ----
{
  const PG = 'gPerf';
  settings.set(PG, 'c', 'r');
  const subjects = ['arena', 'lobby', 'combat', 'scoreboard', 'voice chat', 'controller', 'disc', 'goal', 'menu', 'launcher'];
  const faults = ['crashes randomly', 'is very laggy', 'shows the wrong colours', 'freezes for a few seconds', 'drifts to the left', 'flickers constantly'];
  for (let n = 0; n < 250; n++) {
    fileReport({ guildId: PG, userId: `p${n % 40}`, threshold: 0.99, text: `The ${subjects[n % 10]} ${faults[(n * 7) % 6]} on ${['Quest 3', 'Rift S', 'Index'][n % 3]} unique detail number ${n} ${n * 31}` });
  }
  const timed = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  const target = issues.list(PG)[5];
  assert.ok(issues.list(PG).length >= 200, 'the speed test really has hundreds of issues');
  assert.ok(timed(() => duplicatePairs(PG)) < 1500, 'the duplicate review over hundreds of issues takes well under a couple of seconds');
  assert.ok(timed(() => renderIssue(issues.get(target.id))) < 250, 'drawing an issue card is quick');
  assert.ok(timed(() => fileReport({ guildId: PG, userId: 'speed', text: 'The arena crashes randomly on Quest 3 again', threshold: 0.99 })) < 250, 'filing a report is quick');
  assert.ok(timed(() => sg('problm parseing the pakage on my qest', [], 25, 'install')) < 100, 'looking up known problems is quick');
}

// ---- shortening text never splits an emoji; other languages keep their letters and still group ----
const { trunc: safeTrunc } = await import('./text.js');
for (let n = 90; n <= 100; n++) {
  const cut = safeTrunc(`${'a'.repeat(94)}😀😀😀😀😀😀😀😀`, n);
  assert.ok(cut.isWellFormed() && cut.length <= n, `shortened to ${n} characters without half an emoji`);
}
assert.equal(safeTrunc('short', 10), 'short');
const { tokenize } = await import('./similarity.js');
assert.ok(tokenize('La música se corta en el chat de voz').includes('música'), 'accented letters are kept (not split into "m sica")');
const es = rankSimilar('la música se corta en el chat de voz', [
  { id: 1, text: 'La música se corta en el chat de voz cuando hablan muchos jugadores' },
  { id: 2, text: 'el marcador muestra colores incorrectos al final de la ronda' },
]);
assert.equal(es[0].id, 1);
assert.ok(es[0].score > 0.25 && es[1].score < 0.25, 'Spanish reports group with each other and not with unrelated ones');
assert.ok(tokenize('Привет мир').length >= 2, 'Cyrillic words are kept');

console.log('All tests passed.');
