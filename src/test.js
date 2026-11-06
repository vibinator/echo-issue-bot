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

console.log('All tests passed.');
