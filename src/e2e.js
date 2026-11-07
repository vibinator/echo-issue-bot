// End-to-end test: drives the bot's REAL handlers through a simulated Discord (see sim.js) – journeys for each kind of
// user, then a crawler that presses every button and menu option it can reach. Run with: npm run e2e
process.env.EMBEDDINGS = 'off'; // the e2e run never downloads or runs the meaning model
process.env.DB_PATH = ':memory:';
const { mkdtempSync, existsSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
process.env.EVIDENCE_DIR = mkdtempSync(join(tmpdir(), 'evr-e2e-'));
process.env.EVIDENCE_MAX_MB = '1';
process.env.BACKUP_DIR = mkdtempSync(join(tmpdir(), 'evr-e2e-backups-'));
process.env.ROLE_PING_GAP_MIN = '0'; // the once-per-10-minutes ping limit would hide the pings these tests look for
process.env.DM_GAP_MS = '0';
delete process.env.REPORTER_ROLE_ID; delete process.env.ARTICLE_ROLE_ID;

const ocr = await import('./ocr.js');
ocr.setRecognizer(async () => ''); // tests never run the real OCR engine; a block below plugs in a fake reader
const ui = await import('./index.js');
const S = await import('./sim.js');
const db = await import('./db.js');
const { KB } = await import('./kb.js');
const { sim, FakeChannel, interaction, outcome, person, plain, textOf, embedChars, buttonsOf } = S;
const { client, handleInteraction } = ui;
const { renderIssue } = await import('./render.js');
S.installClient(client);

// ---------------------------------------------------------------- bookkeeping
const failures = [];
const check = (cond, message) => { if (!cond) failures.push(message); return !!cond; };
const logged = [];
const realError = console.error;
console.error = (...a) => { logged.push(a.map(String).join(' ')); };
let interactions = 0; let worstAck = 0;

globalThis.fetch = async (url) => {
  const body = Buffer.from(`file:${String(url).split('/').pop()}`);
  return { ok: true, status: 200, headers: { get: () => String(body.length) }, arrayBuffer: async () => body };
};

const ROLE = { dev: 'R_DEV', users: 'R_USERS', editor: 'R_EDITOR' };
const admin = person('admin', { manageGuild: true });
const dev = person('dev', { roles: [ROLE.dev] });
const editor = person('editor', { roles: [ROLE.editor] });
const alice = person('alice', { roles: [ROLE.users] });
const bob = person('bob', { roles: [ROLE.users] });
const carol = person('carol', { roles: [ROLE.users] });
const outsider = person('outsider');

const panelCh = new FakeChannel('panel', 'panel'); sim.registry.set('panel', panelCh);
const issuesCh = new FakeChannel('issues', 'issues'); sim.registry.set('issues', issuesCh);
const digestCh = new FakeChannel('digest', 'digest'); sim.registry.set('digest', digestCh);

let screenSeq = 0;
/** Runs one interaction through the real handler and checks the rules every interaction must obey. */
async function run(i, label = i.customId ?? i.commandName) {
  const before = logged.length;
  interactions++;
  await handleInteraction(i);
  const out = outcome(i);
  const failed = logged.slice(before).filter((l) => /^Interaction .* failed/.test(l));
  check(out.responded, `[${label}] the bot never answered (Discord would show "This interaction failed")`);
  check(!i.lateAck, `[${label}] answered after ${i.ackAfterMs} ms – too late for Discord's 3 s limit`);
  check(failed.length === 0, `[${label}] the handler failed: ${failed[0] ?? ''}`);
  if (i.ackAfterMs !== null) worstAck = Math.max(worstAck, i.ackAfterMs);
  for (const r of i.responses) {
    if (!r.payload) continue;
    check(embedChars(r.payload.embeds) <= 6000, `[${label}] embeds total ${embedChars(r.payload.embeds)} characters (Discord's limit is 6000)`);
    const ids = buttonsOf(r.payload).map((c) => c.custom_id).filter(Boolean);
    check(new Set(ids).size === ids.length, `[${label}] duplicate custom ids on one message: ${ids.filter((x, n) => ids.indexOf(x) !== n)}`);
  }
  return out;
}

/** The message a person is looking at after an interaction (ephemeral replies create a new one; updates keep it). */
function nextScreen(prev, i, out) {
  if (!out.payload) return prev;
  const reused = out.type !== 'reply' && prev;
  return { payload: out.payload, ephemeral: reused ? prev.ephemeral : true, id: reused ? prev.id : `S${++screenSeq}` };
}
const fresh = (payload, ephemeral = true) => ({ payload, ephemeral, id: `S${++screenSeq}` });

async function press(who, screen, customId) {
  const i = interaction({ kind: 'button', customId, who, screen, channel: panelCh });
  const out = await run(i);
  return { i, out, screen: nextScreen(screen, i, out) };
}
async function choose(who, screen, customId, values, kind = 'select') {
  const i = interaction({ kind, customId, who, values, screen, channel: panelCh });
  const out = await run(i);
  return { i, out, screen: nextScreen(screen, i, out) };
}
async function submit(who, screen, customId, fields, files = []) {
  const i = interaction({ kind: 'modal', customId, who, fields, files, screen, channel: panelCh });
  const out = await run(i);
  return { i, out, screen: nextScreen(screen, i, out) };
}
const labelsOf = (payload) => buttonsOf(payload).map((c) => c.label).filter(Boolean);
const has = (payload, re) => re.test(textOf(payload));
/** The issue card as a private screen (what Known issues shows). `viewer` filters the controls; without it every control is present. */
const cardOf = (iid, viewer) => ({ payload: plain(renderIssue(db.issues.get(iid), viewer ? { back: 'browse', viewer } : {})), ephemeral: true, id: `CARD${iid}` });

// ================================================================= 1. admin sets the bot up
console.log('1. /setup');
let panelScreen;
{
  const setup = (channel = issuesCh) => interaction({ kind: 'command', commandName: 'setup', who: admin, channel: panelCh,
    options: { issues_channel: channel, dev_role: { id: ROLE.dev }, reporter_role: { id: ROLE.users }, article_role: { id: ROLE.editor } } });
  let i = setup();
  let out = await run(i, '/setup');
  check(has(out.payload, /All set/), 'setup confirms it is done');
  check(has(out.payload, new RegExp(`<@&${ROLE.editor}>`)), 'setup names the article editor role');
  const panelMsg = panelCh.sent.at(-1);
  check(panelMsg && labelsOf(plain(panelMsg.payload)).includes('Report a problem'), 'the control panel was posted');
  panelScreen = { payload: plain(panelMsg.payload), ephemeral: false, id: panelMsg.id };
  check(panelCh.messages.map.size === 1, 'exactly one panel message exists');

  i = setup(); out = await run(i, '/setup again');
  check(panelCh.messages.map.size === 1, 're-running /setup replaces the panel instead of adding a second one');
  check(has(out.payload, /Existing data found|All set/), 'second setup still succeeds');
  const p2 = panelCh.sent.at(-1); panelScreen = { payload: plain(p2.payload), ephemeral: false, id: p2.id };

  const noThreads = new FakeChannel('nothreads', 'nothreads', { permissionsMissing: ['EmbedLinks'] });
  sim.registry.set('nothreads', noThreads);
  out = await run(setup(noThreads), '/setup with missing permissions');
  check(has(out.payload, /missing permissions.*Embed Links/s), 'setup names the missing permissions');
  out = await run(setup(issuesCh), '/setup restored');
  const p3 = panelCh.sent.at(-1); panelScreen = { payload: plain(p3.payload), ephemeral: false, id: p3.id };
  check(db.settings.get('G').channel_id === 'issues', 'issues channel saved');
}
const cfgSet = (patch) => db.settings.update('G', patch);
cfgSet({ cooldown_sec: 60 });

// ================================================================= 2. who may do what at the front door
console.log('2. access control on the panel');
{
  let r = await press(outsider, panelScreen, 'report');
  check(has(r.out.payload, /limited to members with the/), 'someone without the reporter role is told why they cannot report');
  check(!r.out.modal && buttonsOf(r.out.payload).length === 0, '…and is not offered the report buttons');
  r = await press(outsider, panelScreen, 'browse');
  check(has(r.out.payload, /issues|No issues match/), 'but they can still browse');
  r = await press(outsider, panelScreen, 'dev:menu');
  check(has(r.out.payload, /developers only/), 'a stranger cannot open the Developer menu');
  r = await press(alice, panelScreen, 'dev:menu');
  check(has(r.out.payload, /developers only/), 'a normal player cannot open the Developer menu');
  r = await press(alice, panelScreen, 'dev:articles');
  check(has(r.out.payload, /can only be changed by developers/), 'a normal player cannot open the article tools');
  r = await press(editor, panelScreen, 'dev:menu');
  check(JSON.stringify(labelsOf(r.out.payload)) === JSON.stringify(['Knowledge articles']), 'an article editor sees only the article tools');
  for (const id of ['dev:settings', 'dev:board', 'dev:export', 'dev:backup', 'dev:digest', 'dev:dups']) {
    r = await press(editor, panelScreen, id);
    check(has(r.out.payload, /developers only/), `an article editor cannot use ${id}`);
  }
  r = await press(dev, panelScreen, 'dev:menu');
  check(labelsOf(r.out.payload).length >= 7, 'a developer sees the full developer menu');
}

// ================================================================= 3. a player reports a problem (the whole path)
console.log('3. reporting');
let aliceIssueId; let aliceReportId;
{
  let r = await press(alice, panelScreen, 'report');
  check(labelsOf(r.out.payload).join() === 'Install issue,Bug in game', 'step 1 offers Install issue / Bug in game');
  r = await press(alice, r.screen, 'rtype:install');
  check(r.out.modal && /faqq:install/.test(JSON.stringify(r.out.modal)), 'step 2 opens the one-line description box');
  r = await submit(alice, r.screen, 'faqq:install', { text: 'problem parsing the package when i tap install on my quest' });
  const select = buttonsOf(r.out.payload).find((c) => c.custom_id === 'faq:install');
  check(select && select.options[0].value === 'kb:quest_parse_package', 'the closest known problem is listed first');
  check(select?.options[0].emoji?.name === '⭐', '…and marked as the closest match');
  r = await choose(alice, r.screen, 'faq:install', ['kb:quest_parse_package']);
  check(has(r.out.payload, /Package Installer/), 'picking it shows the fix');
  const back = await press(alice, r.screen, 'faqno:install:kb:quest_parse_package');
  check(buttonsOf(back.out.payload).some((c) => c.custom_id === 'faq:install'), '"That\'s not my problem" returns to the list');
  const fixed = await press(alice, r.screen, 'faqok:install:kb:quest_parse_package');
  check(has(fixed.out.payload, /No report was needed/), '"That fixed it!" ends without creating a report');
  check(db.issues.list('G').length === 0, 'no issue was created when the fix worked');

  r = await press(alice, back.screen, 'rform:install');
  check(r.out.modal && /report:install/.test(JSON.stringify(r.out.modal)), '"None of these" opens the report form');
  const form = plain(r.out.modal);
  check(form.components.length <= 5 && form.components.some((c) => c.component?.type === 19), 'the form has a file upload box');
  const files = [{ name: 'crash log.txt', url: 'https://cdn.discordapp.com/a/crash.txt', size: 12, contentType: 'text/plain' }];
  r = await submit(alice, back.screen, 'report:install', { text: 'Problem parsing the package when I tap install on my Quest', platform: 'Quest 3', version: '0.13.14', links: 'https://youtu.be/abc123' }, files);
  check(has(r.out.payload, /report has been sent/), 'the confirmation says the report was sent');
  check(has(r.out.payload, /only you and the developers/), '…and says who can see the attachments');
  check(r.i.responses[0].type === 'deferUpdate', 'the form answers Discord immediately (defers) before the slow work');
  const issue = db.issues.list('G')[0];
  aliceIssueId = issue?.id; aliceReportId = db.reports.forIssue(issue.id)[0].id;
  check(issue.kind === 'install' && issue.category === 'Install / Setup', 'stored as an install issue');
  check(issuesCh.threadsList.length === 0 && issuesCh.sent.length === 0, 'the issue posted nothing in the issues channel and made no thread');
  const card = cardOf(issue.id);
  check(buttonsOf(card.payload).some((c) => c.custom_id === `status:${issue.id}`), 'the issue opens as a card with its controls');
  const cardText = textOf(card.payload);
  check(/Requested by[\s\S]*(?:<@alice>|\*\*[^*]+\*\*)/.test(cardText), 'the card names the requester');
  check(!/youtu\.be|crash log/.test(cardText), 'the public card does not reveal attachment names or links');
  check(/2 attached/.test(cardText), 'the public card only counts the attachments');
  check(existsSync(join(process.env.EVIDENCE_DIR, String(aliceReportId))), 'the uploaded file was saved privately on disk');
  check(textOf(card.payload).length > 0 && embedChars(card.payload.embeds) <= 6000, 'the card fits Discord limits');
}

// ================================================================= 4. a second player hits the same problem
console.log('4. similar report → joins, can be separated');
let bobReportId; let bobR;
{
  sim.t += 61_000; // past alice's cooldown… (bob has his own anyway)
  bobR = await submit(bob, panelScreen, 'report:install', { text: 'Quest installer says problem parsing the package after I tap install', platform: '', version: '', links: '' });
  const t = textOf(bobR.out.payload);
  check(/similar issue/i.test(t), 'a matching report is shown as joining an existing issue');
  check(/\d+%/.test(t), '…with how alike they are');
  const btns = labelsOf(bobR.out.payload);
  check(btns.includes('Yes, same problem') && btns.includes('Make it a separate issue'), '…offering to keep it or separate it');
  check(db.issues.list('G').length === 1, 'no duplicate issue was created');
  bobReportId = db.reports.forIssue(aliceIssueId).find((x) => x.user_id === 'bob')?.id;
  check(/(?:<@alice>|\*\*[^*]+\*\*) \+ 1 other/.test(textOf(cardOf(aliceIssueId).payload)), 'the card still names alice as requester, "+ 1 other"');
  check(issuesCh.threadsList.length === 0, 'still no thread');

  let r = await press(bob, bobR.screen, `keep:${bobReportId}`);
  check(has(r.out.payload, /stays with/), '"Yes, same problem" confirms');
  r = await press(carol, bobR.screen, `split:${bobReportId}`);
  check(has(r.out.payload, /only change your own reports/), 'someone else cannot separate bob\'s report');
  r = await press(bob, bobR.screen, `split:${bobReportId}`);
  check(has(r.out.payload, /now its own issue/), 'bob can make it a separate issue');
  check(r.i.responses[0].type === 'deferUpdate', 'separating answers Discord first');
  check(db.issues.list('G').length === 2, 'a second issue exists after separating');
  check(db.reports.forIssue(aliceIssueId).every((x) => x.user_id === 'alice'), 'alice\'s issue lost bob\'s report');
  check(issuesCh.threadsList.length === 0 && db.issues.list('G').length === 2, 'the separated issue is simply another entry in Known issues');
}

// ================================================================= 5. cooldown
console.log('5. cooldown');
{
  let r = await press(alice, panelScreen, 'report');
  check(/Hang on a moment|Install issue/.test(textOf(r.out.payload)), 'cooldown message or type screen shown');
  r = await submit(alice, panelScreen, 'report:install', { text: 'Another install problem happening right now on my quest headset', platform: '', version: '', links: '' });
  check(has(r.out.payload, /Hang on a moment/), 'sending a second report too fast is paused, with a reason');
  r = await press(dev, panelScreen, 'report');
  check(labelsOf(r.out.payload).includes('Install issue'), 'developers are not slowed by the cooldown');
}

// ================================================================= 6. private attachments
console.log('6. attachment privacy');
{
  const cardScreen = cardOf(aliceIssueId);
  let r = await press(alice, cardScreen, `evall:${aliceIssueId}`);
  check(r.i.responses[0].type === 'deferReply', 'viewing attachments answers Discord first');
  check(r.i.responses.some((x) => x.type === 'editReply' && /crash log|crash\.txt/.test(JSON.stringify(x.payload))) || has(r.out.payload, /crash log/), 'the requester can open their own attachments');
  r = await press(bob, cardScreen, `evall:${aliceIssueId}`);
  check(has(r.out.payload, /private/), 'another player is told attachments are private');
  check(!/crash/.test(textOf(r.out.payload)), '…and sees none of them');
  r = await press(outsider, cardScreen, `evall:${aliceIssueId}`);
  check(has(r.out.payload, /private/), 'an outsider is told attachments are private');
  r = await press(bob, panelScreen, `evview:${aliceReportId}`);
  check(has(r.out.payload, /only open the attachments of your own/), 'bob cannot open alice\'s report attachments directly either');
  r = await press(dev, cardScreen, `evall:${aliceIssueId}`);
  check(/requested by <@alice>/.test(textOf(r.out.payload)) && /crash log/.test(JSON.stringify(r.i.responses)), 'a developer can open everyone\'s attachments, labelled with the requester');
  r = await press(alice, panelScreen, `evview:${aliceReportId}`);
  check(r.i.responses[0].type === 'deferReply', 'My attachments also answers first');
}

// ================================================================= 7. My issues
console.log('7. My issues');
{
  let r = await press(alice, panelScreen, 'mine');
  check(buttonsOf(r.out.payload).some((c) => c.custom_id === 'mine_view'), 'My issues lists alice\'s report');
  check(buttonsOf(r.out.payload).some((c) => c.custom_id === 'dm:toggle'), '…with the update-messages switch');
  let s = await choose(alice, r.screen, 'mine_view', [String(aliceIssueId)]);
  const lab = labelsOf(s.out.payload);
  check(['Edit my report', 'Add screenshots / logs', 'Recalculate match', 'Withdraw'].every((x) => lab.includes(x)), 'the personal card offers edit / add / recalculate / withdraw');
  check(lab.some((x) => /My attachments \(2\)/.test(x)), '…and My attachments');
  const e = await press(alice, s.screen, `edit:${aliceReportId}`);
  check(e.out.modal && /Edit your report/.test(JSON.stringify(e.out.modal)), 'Edit opens the pre-filled form');
  check(plain(e.out.modal).components[0].component.value.includes('Problem parsing'), 'the form is pre-filled with the report');
  const ed = await submit(alice, s.screen, `edit:${aliceReportId}`, { text: 'Problem parsing the package when I tap install on my Quest (updated, also on Quest 2)', platform: 'Quest 3', version: '0.13.15', links: '' });
  check(has(ed.out.payload, /report was updated/), 'saving an edit confirms it');
  check(ed.i.responses[0].type === 'deferUpdate', 'the edit replaces the personal card in place');
  const rm = await press(alice, ed.screen, `rematch:${aliceReportId}`);
  check(has(rm.out.payload, /still fits best|moved|own issue/), 'Recalculate match answers with a clear result');
  check(rm.i.responses[0].type === 'deferUpdate', 'Recalculate answers first');
  let f = await press(carol, panelScreen, `follow:${aliceIssueId}`);
  check(has(f.out.payload, /now following/), 'a non-reporter can follow an issue');
  f = await press(carol, panelScreen, `follow:${aliceIssueId}`);
  check(has(f.out.payload, /stopped following/), '…and unfollow');
  f = await press(alice, panelScreen, `follow:${aliceIssueId}`);
  check(has(f.out.payload, /already get its updates/), 'a reporter is told they already get updates');
  const dmOff = await press(alice, r.screen, 'dm:toggle');
  check(has(dmOff.out.payload, /off/), 'turning updates off is reflected');
  await press(alice, dmOff.screen, 'dm:toggle');
}

// ================================================================= 8. developer workflow
console.log('8. developer workflow');
{
  const cardScreen = () => cardOf(aliceIssueId);
  const blocked = [['status:%', 'select', ['seen'], /developers only/], ['prio:%', 'select', ['high'], /developers only/], ['assign:%', 'button', null, /developers only/],
    ['note:%', 'button', null, /developers only/], ['merge:%', 'button', null, /developers only/], ['rmrep:%', 'button', null, /developers only/]];
  for (const [pattern, kind, values, re] of blocked) {
    const id = pattern.replace('%', aliceIssueId);
    const r = kind === 'select' ? await choose(alice, cardScreen(), id, values) : await press(alice, cardScreen(), id);
    check(re.test(textOf(r.out.payload)), `a player cannot use ${pattern.replace('%', '…')} (and is told why)`);
  }
  let r = await press(alice, cardScreen(), `mkart:${aliceIssueId}`);
  check(has(r.out.payload, /can only be changed by developers/), 'a player cannot turn an issue into an article');

  // status → DM to the reporter, ack first
  sim.dms.length = 0;
  r = await choose(dev, cardScreen(), `status:${aliceIssueId}`, ['in_progress']);
  check(r.i.responses[0].type === 'deferUpdate', 'a status change answers Discord first');
  check(db.issues.get(aliceIssueId).status === 'in_progress', 'status saved');
  await new Promise((res) => setTimeout(res, 20));
  check(sim.dms.some((d) => d.to === 'alice' && /started working/.test(d.content)), 'the reporter is messaged, in plain words');
  check(!sim.dms.some((d) => d.to === 'bob'), 'bob left that issue, so he is not messaged');
  check(db.issues.get(aliceIssueId).handled_by === 'dev', 'the card records who changed the status');

  // DM opt-out respected
  db.prefs.setDmOff('alice', true); sim.dms.length = 0;
  await choose(dev, cardScreen(), `status:${aliceIssueId}`, ['seen']);
  await new Promise((res) => setTimeout(res, 20));
  check(!sim.dms.some((d) => d.to === 'alice'), 'turning updates off stops the messages');
  db.prefs.setDmOff('alice', false);

  // priority + assign
  r = await choose(dev, cardScreen(), `prio:${aliceIssueId}`, ['critical']);
  check(db.issues.get(aliceIssueId).priority === 'critical' && r.i.responses[0].type === 'deferUpdate', 'priority changes (answering first)');
  r = await press(dev, cardScreen(), `assign:${aliceIssueId}`);
  check(db.issues.get(aliceIssueId).owner_id === 'dev', 'assign-to-me works');
  r = await press(dev, cardScreen(), `assign:${aliceIssueId}`);
  check(db.issues.get(aliceIssueId).owner_id === null, 'pressing it again un-assigns');

  // note
  r = await press(dev, cardScreen(), `note:${aliceIssueId}`);
  check(r.out.modal, 'the note button opens a form');
  r = await submit(dev, cardScreen(), `note:${aliceIssueId}`, { text: 'Reproduced on Quest 3, fix is on the beta channel' });
  check(db.issues.get(aliceIssueId).dev_note?.includes('beta channel') && r.i.responses[0].type === 'deferReply', 'the note is saved (answering first)');

  // set channels through the settings menus, then fix with a version
  const settingsScreen = (await press(dev, panelScreen, 'dev:settings')).screen;
  r = await choose(dev, settingsScreen, 'set_devch', ['digest'], 'channelselect');

  // developer hub: a live board message plus one developer-only thread per open issue
  const hubCh = digestCh;
  check(db.settings.get('G').board_channel_id === 'digest' && hubCh.sent.filter((m) => m.payload.embeds?.length === 2).length === 1, 'choosing a hub channel posts the live board there');
  const boardMsg = hubCh.sent.find((m) => m.payload.embeds?.length === 2);
  const liveBoard = { payload: plain(boardMsg.payload), ephemeral: false, id: boardMsg.id };
  r = await choose(dev, liveBoard, 'bfb', [String(aliceIssueId)]);
  check(r.i.responses[0].type === 'reply', 'opening a card from the live board answers privately and leaves the board message alone');
  r = await choose(alice, liveBoard, 'bfb', [String(aliceIssueId)]);
  check(has(r.out.payload, /developers only/), 'a player cannot use the live board');
  r = await press(alice, cardScreen(), `talk:${aliceIssueId}`);
  check(has(r.out.payload, /developers only/), 'a player cannot open the developer thread');
  const openIssues = db.issues.list('G').filter((x) => ['new', 'seen', 'in_progress'].includes(x.status));
  check(openIssues.length > 0 && openIssues.every((x) => x.talk_thread_id), 'choosing the hub gives every New / Seen / Being fixed issue its own thread');
  r = await press(dev, panelScreen, 'dev:threads');
  check(has(r.out.payload, /already has its thread and history/), 'the process-previous button has nothing left to do once everything is processed');
  const histOf = (iid) => hubCh.threadsList.find((t) => t.id === db.issues.get(iid).talk_thread_id).sent.filter((m) => /History so far/.test(JSON.stringify(plain(m.payload)))).length;
  check(histOf(aliceIssueId) === 1, 'a new thread starts with the issue history (the earlier reports)');
  db.db.prepare('UPDATE issues SET talk_history = 0 WHERE id = ?').run(aliceIssueId);
  r = await press(dev, panelScreen, 'dev:threads');
  check(has(r.out.payload, /Process 1 previous request/), 'the process-previous button counts issues whose history is not in the thread yet');
  r = await press(dev, r.screen, 'dev:threadsok');
  check(histOf(aliceIssueId) === 2 && has(r.out.payload, /history posted for \*\*1\*\*/), 'processing posts the history into the existing thread');
  r = await press(dev, panelScreen, 'dev:threads');
  check(has(r.out.payload, /already has its thread and history/), 'and it is not posted twice');
  const talkId = db.issues.get(aliceIssueId).talk_thread_id;
  const talk = hubCh.threadsList.find((t) => t.id === talkId);
  check(talk && talk.memberIds.size === 0, 'players are not added to the developer thread');
  r = await press(dev, cardScreen(), `talk:${aliceIssueId}`);
  check(has(r.out.payload, new RegExp(talkId)), 'the Developer thread button shows the thread');
  check(talk.locked && /Players are not in this thread|Locked/.test(JSON.stringify(plain(talk.sent[0].payload))), 'the thread is locked so only people with Manage Threads can write');
  check(JSON.stringify(plain(talk.sent[0].payload)).includes(`note:${aliceIssueId}`) && JSON.stringify(plain(talk.sent[0].payload)).includes(`merge:${aliceIssueId}`), 'the thread has buttons to send a note to the requesters and to merge');
  const threadCount = hubCh.threadsList.length;
  r = await press(dev, cardScreen(), `talk:${aliceIssueId}`);
  check(hubCh.threadsList.length === threadCount && has(r.out.payload, new RegExp(talkId)), 'pressing it again opens the same thread instead of making another');
  {
    const sv = await import('./service.js');
    const n = sv.fileReport({ guildId: 'G', userId: 'zed', threshold: 0.99, text: 'Totally unrelated: fireworks never stop playing in the lobby' });
    await sv.syncTalkThread(client, n.issue, 'zed');
    const nt = hubCh.threadsList.find((t) => t.id === db.issues.get(n.issue.id).talk_thread_id);
    check(nt && nt.memberIds.size === 0, 'a new issue gets its own developer thread automatically, with no players in it');
    await sv.syncTalkThread(client, n.issue, 'zed');
    check(hubCh.threadsList.filter((t) => t.id === nt.id).length === 1 && db.issues.get(n.issue.id).talk_thread_id === nt.id, 'syncing again does not make a second thread');
    db.issues.setStatus(n.issue.id, 'fixed', 'dev', '1.0');
    await sv.syncTalkThread(client, n.issue);
    check(nt.archived, 'a closed issue has its thread archived');
    db.issues.setStatus(n.issue.id, 'new', null);
    await sv.syncTalkThread(client, n.issue);
    check(!nt.archived, 'a reopened issue has its thread opened again');
    const beforeSay = nt.sent.length;
    await sv.threadSay(client, n.issue, 'A player edited their report');
    check(nt.sent.length === beforeSay + 1, 'player activity is posted in the developer thread');
    // merging joins the threads; a developer can add any person
    const aliceThread = db.issues.get(aliceIssueId).talk_thread_id;
    await sv.carryTalkOnMerge(client, n.issue, db.issues.get(aliceIssueId));
    const joined = hubCh.threadsList.find((t) => t.id === aliceThread);
    check(db.issues.get(n.issue.id).talk_thread_id === null || nt.archived, 'merging archives the merged-away issue thread');
    check(joined.sent.some((m) => /merged into this one/.test(JSON.stringify(plain(m.payload)))), 'the surviving thread notes the merge');
  }
  r = await choose(dev, settingsScreen, 'set_thr', ['0.35']);
  check(db.settings.get('G').threshold === 0.35, 'matching strictness can be changed'); await choose(dev, settingsScreen, 'set_thr', ['0.25']);

  sim.dms.length = 0;
  r = await choose(dev, cardScreen(), `status:${aliceIssueId}`, ['fixed']);
  check(r.out.modal && /Mark fixed/.test(JSON.stringify(r.out.modal)), 'choosing Fixed asks for the version');
  r = await submit(dev, cardScreen(), `fixed:${aliceIssueId}`, { version: '0.13.20', text: 'Fixed in the new installer' });
  check(r.i.responses[0].type === 'deferUpdate', 'marking fixed answers first');
  check(db.issues.get(aliceIssueId).status === 'fixed' && db.issues.get(aliceIssueId).fixed_version === '0.13.20', 'fixed + version saved');
  await new Promise((res) => setTimeout(res, 20));
  check(sim.dms.some((d) => d.to === 'alice' && /0\.13\.20/.test(d.content)), 'the reporter is told which version has the fix');

  // the fix proposes a knowledge article: a draft players can't see, announced to developers, published by a person
  const draft = db.articles.forIssue(aliceIssueId);
  check(draft && draft.draft === 1 && draft.enabled === 0 && /new installer/.test(draft.body) && /0\.13\.20/.test(draft.body), 'marking fixed with a note proposes a draft article from the resolution');
  check(!db.articles.list('G', { enabledOnly: true }).some((a) => a.id === draft.id), 'a draft is not shown to players');
  const proposal = digestCh.sent.find((m) => /proposed/.test(JSON.stringify(plain(m.payload))));
  check(proposal && labelsOf(plain(proposal.payload)).join('|').includes('Publish'), 'the proposal is posted to the developer channel with Publish / Review / Discard');
  check(has((await press(dev, panelScreen, 'art:drafts')).out.payload, /Drafts to review/), 'the Drafts list opens');
  r = await press(dev, panelScreen, `art:dpub:${draft.id}`);
  check(db.articles.get(draft.id).enabled === 1 && db.articles.get(draft.id).draft === 0, 'Publish turns the draft into a live article');
  await submit(dev, cardScreen(), `fixed:${aliceIssueId}`, { version: '0.13.20', text: 'Fixed in the new installer' });
  check(db.articles.list('G').filter((a) => a.source_issue_id === aliceIssueId).length === 1, 'an issue never gets a second proposed article');

  // a new report on the fixed issue reopens it, and separating it puts it back
  db.settings.update('G', { cooldown_sec: 0 });
  const reopen = await submit(carol, panelScreen, 'report:install', { text: 'Problem parsing the package when I tap install on my Quest again', platform: '', version: '0.13.20', links: '' });
  check(has(reopen.out.payload, /already been fixed/) && labelsOf(reopen.out.payload).some((l) => /Still happening/.test(l)) && labelsOf(reopen.out.payload).some((l) => /That fixed it/.test(l)), 'a report that matches a fixed issue first says it was fixed, with the choice to send it anyway');
  check(db.issues.get(aliceIssueId).status === 'fixed' && !db.reports.forIssue(aliceIssueId).some((x) => x.user_id === 'carol'), 'nothing is filed until the player chooses');
  const sent = await press(carol, reopen.screen, `fxsend:${aliceIssueId}`);
  check(db.issues.get(aliceIssueId).status === 'new', 'choosing Still happening files the report and reopens the fixed issue');
  const carolReport = db.reports.forIssue(aliceIssueId).find((x) => x.user_id === 'carol');
  const undo = await press(carol, sent.screen, `split:${carolReport.id}`);
  check(db.issues.get(aliceIssueId).status === 'fixed', 'separating that report puts the issue back to Fixed');
  db.settings.update('G', { cooldown_sec: 60 });
}

// ================================================================= 9. knowledge articles
console.log('9. knowledge articles');
{
  let r = await press(editor, panelScreen, 'dev:menu');
  r = await press(editor, r.screen, 'dev:articles');
  check(labelsOf(r.out.payload).includes('New article'), 'the editor reaches the article manager');
  const m = await press(editor, r.screen, 'art:new');
  check(m.out.modal, 'New article opens a form');
  const created = await submit(editor, r.screen, 'art:save:new', { title: 'Why am I suspended', symptoms: 'i am suspended\nmy account is banned\nwhy am i banned', phrases: 'account suspended', body: 'Check the rules channel, then appeal.', link: 'https://example.com/appeal' });
  const art = db.articles.list('G').find((a) => a.title === 'Why am I suspended');
  check(art && art.created_by === 'editor', 'the article is saved with its author');
  check(has(created.out.payload, /Why am I suspended/), 'the article view is shown');
  // players now see it, ranked first for a matching sentence
  let p = await press(bob, panelScreen, 'report'); sim.t += 61_000;
  p = await press(bob, p.screen, 'rtype:bug');
  p = await submit(bob, p.screen, 'faqq:bug', { text: 'why am i banned from the game' });
  const sel = buttonsOf(p.out.payload).find((c) => c.custom_id === 'faq:bug');
  check(sel.options[0].value === `a:${art.id}` && sel.options[0].emoji.name === '⭐', 'the new article is the closest match for a player describing it');
  p = await choose(bob, p.screen, 'faq:bug', [`a:${art.id}`]);
  check(has(p.out.payload, /rules channel/) && has(p.out.payload, /example\.com\/appeal/), 'the article answer and link are shown');
  await press(bob, p.screen, `faqno:bug:a:${art.id}`);
  check(db.kbStats.get('G', `a:${art.id}`).shown >= 1 && db.kbStats.get('G', `a:${art.id}`).denied === 1, 'views and "not my problem" are counted');
  // edit, disable, test, delete
  const view = await choose(editor, created.screen, 'art_pick', [String(art.id)]);
  const tog = await press(editor, view.screen, `art:tog:${art.id}`);
  check(db.articles.get(art.id).enabled === 0, 'an article can be disabled');
  const fl = await press(bob, panelScreen, 'report');
  const test = await press(editor, r.screen, 'art:test');
  check(test.out.modal, 'Test matching opens a form');
  const tr = await submit(editor, r.screen, 'art:testm', { sample: 'i keep getting banned' });
  check(has(tr.out.payload, /full list|first/), 'Test matching reports what a player would see');
  await press(editor, tog.screen, `art:tog:${art.id}`);
  const del = await press(editor, tog.screen, `art:del:${art.id}`);
  check(has(del.out.payload, /Delete/), 'delete asks to confirm');
  const gone = await press(editor, del.screen, `art:delok:${art.id}`);
  check(db.articles.get(art.id) === undefined, 'the article is deleted');
  const stranger = await press(alice, view.screen, `art:delok:${art.id}`);
  check(has(stranger.out.payload, /can only be changed by developers/), 'a player cannot delete articles');
}

// ================================================================= 9b. screenshot text → known fixes
console.log('9b. screenshot text');
{
  ocr.setRecognizer(async () => 'There was a problem parsing the package\n@@ ## ..\nINSTALL_FAILED_UPDATE_INCOMPATIBLE');
  db.settings.update('G', { cooldown_sec: 0 });
  const png = [{ name: 'quest error.png', url: 'https://cdn.discordapp.com/a/quest-error.png', size: 12, contentType: 'image/png' }];
  const r = await submit(carol, panelScreen, 'report:install', { text: 'my install keeps failing, see the screenshot', platform: 'Quest 3', version: '', links: '' }, png);
  check(r.i.responses.some((x) => x.type === 'editReply'), 'the report is confirmed first');
  await new Promise((res) => setTimeout(res, 100));
  const order = r.i.responses.map((x) => x.type);
  const follow = r.i.responses.find((x) => x.type === 'followUp');
  check(follow && /problem parsing|Files/i.test(JSON.stringify(plain(follow.payload))) && /read the text in your screenshot/.test(JSON.stringify(plain(follow.payload))), 'the player is privately shown the known fix that matches the text in their screenshot');
  check(order.indexOf('followUp') > order.indexOf('editReply'), 'the fix arrives after the confirmation, never before it');
  check(follow.payload.flags !== undefined, 'the suggestion is private (ephemeral)');
  const ev = db.evidence.forIssue(db.issues.list('G').find((x) => db.reports.forIssue(x.id).some((y) => y.user_id === 'carol')).id).find((e) => e.kind === 'image');
  check(ev && /INSTALL_FAILED/.test(ev.ocr_text) && !/@@/.test(ev.ocr_text), 'the text is stored with the screenshot, symbol-only junk lines removed');
  const dv = await press(dev, panelScreen, `evall:${ev.issue_id}`);
  check(/Text read from the image/.test(JSON.stringify(dv.i.responses)), 'developers see the text next to the screenshot');
  check(!/INSTALL_FAILED/.test(textOf(cardOf(ev.issue_id).payload)), 'the public card never shows text from a screenshot');

  // nothing readable (or OCR unavailable) → no suggestion, report unaffected
  ocr.setRecognizer(async () => '');
  const r2 = await submit(carol, panelScreen, 'report:bug', { text: 'weird flicker in the lobby after the update', platform: 'PC', version: '', links: '' }, png);
  await new Promise((res) => setTimeout(res, 50));
  check(has(r2.out.payload, /report has been sent|added to/) && !r2.i.responses.some((x) => x.type === 'followUp'), 'a screenshot with no readable text changes nothing');
  ocr.setRecognizer(async () => { throw new Error('engine crashed'); });
  const r3 = await submit(carol, panelScreen, 'report:bug', { text: 'another unrelated hiccup with voice chat cutting out', platform: 'PC', version: '', links: '' }, png);
  await new Promise((res) => setTimeout(res, 50));
  check(has(r3.out.payload, /report has been sent|added to/), 'an OCR failure never breaks reporting');
  ocr.setRecognizer(async () => '');
  db.settings.update('G', { cooldown_sec: 60 });
}

// ================================================================= 9a. developers can't miss open problems
console.log('9a. attention');
{
  db.settings.update('G', { cooldown_sec: 0 });
  const before = digestCh.sent.length;
  await submit(bob, panelScreen, 'report:bug', { text: 'the whole game crashes and freezes my headset every time the lobby loads', platform: 'PC', version: '', links: '' });
  await new Promise((res) => setTimeout(res, 30));
  const alert = digestCh.sent.slice(before).find((m) => /New issue/.test(JSON.stringify(plain(m.payload))));
  check(alert && /alert:open:/.test(JSON.stringify(plain(alert.payload))), 'a new issue posts an alert with an Open card button in the developer channel');
  check(alert && /<@&R_DEV>/.test(JSON.stringify(plain(alert.payload))), 'a high-priority (crash) issue pings the developer role');
  const open = db.issues.list('G').find((x) => x.status === 'new');
  const o = await press(dev, panelScreen, `alert:open:${open.id}`);
  check(o.i.responses.some((x) => x.type === 'reply'), 'a developer can open the issue straight from the alert');
  const no = await press(alice, panelScreen, `alert:open:${open.id}`);
  check(/developer/i.test(JSON.stringify(no.i.responses)), 'a player pressing that button is refused');
  const panel = ui.panelPayload('G');
  check(buttonsOf(plain(panel)).some((c) => /need attention/.test(c.label ?? '') && c.style === 4), 'the Developer button on the panel turns red and shows how many need attention');
  const waitingN = db.issues.list('G').filter((x) => x.status === 'new').length;
  const answeredN = db.issues.list('G').filter((x) => ['seen', 'fixed', 'cannot_reproduce', 'wont_fix'].includes(x.status)).length;
  const workingN = db.issues.list('G').filter((x) => x.status === 'in_progress').length;
  const kbN = db.articles.list('G').filter((a) => !a.draft).length;
  const panelText = JSON.stringify(plain(panel));
  check(panelText.includes(`**${waitingN}** waiting for a developer reply`) && panelText.includes(`**${answeredN}** answered by a developer`) && panelText.includes(`**${workingN}** being worked on`), `the panel shows ${waitingN} waiting and ${answeredN} answered`);
  check(panelText.includes(`**${kbN}** written by the team`) && panelText.includes(`**${KB.length}** built-in answers`), `the panel shows ${kbN} stored knowledge articles`);
  const menu = await press(dev, panelScreen, 'dev:menu');
  check(has(menu.out.payload, /Needs attention/) && labelsOf(menu.out.payload).some((l) => /Board \(\d+ new\)/.test(l)), 'the developer menu says what needs attention and the Board button shows the new count');
  db.settings.update('G', { cooldown_sec: 60 });
}

// ================================================================= 10. duplicates, merge, board, digest, export, backup
console.log('10. dev tools');
{
  const { fileReport } = await import('./service.js');
  fileReport({ guildId: 'G', userId: 'x1', threshold: 0.99, text: 'Arena crashes with a black screen when joining on Quest 3 headset' });
  fileReport({ guildId: 'G', userId: 'x2', threshold: 0.99, text: 'Arena crashes with a black screen when joining the match on Quest 3' });
  const [i1, i2] = db.issues.list('G').filter((x) => x.kind === 'bug').slice(0, 2);
  for (const x of [i1, i2]) await (await import('./service.js')).syncMessage(client, x, 'issues');
  let r = await press(dev, panelScreen, 'dev:dups');
  check(has(r.out.payload, /same problem/), 'the duplicate review shows a pair');
  const pairBtns = buttonsOf(r.out.payload).map((c) => c.custom_id);
  const keep = pairBtns.find((x) => x?.startsWith('dupk:'));
  const k = await press(dev, r.screen, keep);
  check(k.i.responses[0].type === 'deferUpdate', 'a duplicate decision answers first');
  r = await press(dev, panelScreen, 'dev:board');
  check(r.out.payload.embeds.length === 2 && embedChars(r.out.payload.embeds) <= 6000, 'the board shows its two columns sets within limits');
  r = await press(dev, r.screen, 'board:mine');
  check(has(r.out.payload, /Your cards/), '"Only mine" filters the board');
  r = await press(dev, panelScreen, 'dev:digest');
  check(has(r.out.payload, /digest was posted/) && digestCh.sent.filter((m) => !/proposed|New issue|Reopened|Developer board/.test(JSON.stringify(plain(m.payload)))).length === 1, 'the digest is posted to the digest channel');
  r = await press(dev, panelScreen, 'dev:export');
  check(r.i.responses.some((x) => x.type === 'reply') && has(r.out.payload, /user IDs/), 'the export warns it contains user IDs');
  r = await press(dev, panelScreen, 'dev:backup');
  check(has(r.out.payload, /Backup saved/), 'a backup can be made on demand');
  // merge i2 into i1 from the issue card
  const c2 = cardOf(i2.id);
  const mergedUsers = [...new Set(db.reports.forIssue(i2.id).map((x) => x.user_id))].filter((u) => !db.reports.forIssue(i1.id).some((x) => x.user_id === u) && !db.prefs.dmOff(u));
  db.issues.setStatus(i1.id, 'fixed', null, '9.9.9'); db.issues.setNote(i1.id, 'Reinstall the launcher', null);
  sim.dms.length = 0;
  r = await press(dev, c2, `merge:${i2.id}`);
  r = await choose(dev, r.screen, `mergeto:${i2.id}`, [String(i1.id)]);
  await new Promise((res) => setTimeout(res, 50));
  check(mergedUsers.length > 0 && mergedUsers.every((u) => sim.dms.some((d) => d.to === u && /merged into/.test(d.content) && /now fixed/.test(d.content) && /9\.9\.9/.test(d.content) && /Reinstall the launcher/.test(d.content))), 'people merged into an already fixed issue are told the fix, version and developer note');
  db.issues.setStatus(i1.id, 'new', null);
  check(db.issues.get(i2.id) === undefined && r.i.responses[0].type === 'deferUpdate', 'merge works (answering first)');
  check(issuesCh.threadsList.length === 0 && issuesCh.sent.length === 0, 'merging posts nothing in the channel');
}

// ================================================================= 11. withdraw & erase my data
console.log('11. withdraw and erase');
{
  const bobsIssue = db.issues.list('G').find((x) => db.reports.forIssue(x.id).some((r) => r.user_id === 'bob'));
  const bobRep = db.reports.forIssue(bobsIssue.id).find((r) => r.user_id === 'bob');
  let r = await press(bob, panelScreen, `wd:${bobRep.id}`);
  check(has(r.out.payload, /Take back your report|already working/), 'withdraw asks for confirmation (or explains why it cannot)');
  const priv = await press(bob, panelScreen, 'legal:privacy');
  check(has(priv.out.payload, /Data & privacy/) && labelsOf(priv.out.payload).includes('Delete my data'), 'the privacy notice offers Delete my data');
  const ask = await press(bob, priv.screen, 'legal:erase');
  check(has(ask.out.payload, /can't be undone/), 'erasing asks for confirmation');
  const done = await press(bob, ask.screen, 'legal:eraseok');
  check(has(done.out.payload, /Done/), 'erasing confirms');
  check(db.reports.byUser('G', 'bob').length === 0, 'none of bob\'s reports remain');
  const terms = await press(bob, panelScreen, 'legal:terms');
  check(has(terms.out.payload, /Terms of use/), 'the terms are available');
}

// ================================================================= 12. robustness
console.log('12. robustness');
{
  // two people report the same new problem at the same moment → still one issue
  db.settings.update('G', { cooldown_sec: 0 });
  const issuesBefore = db.issues.list('G').length;
  const text = 'Spectator camera jitters badly whenever the disc is near the goal in arena';
  await Promise.all([carol, alice].map((who) => submit(who, panelScreen, 'report:bug', { text, platform: '', version: '', links: '' })));
  check(db.issues.list('G').length === issuesBefore + 1, 'two simultaneous matching reports make ONE issue');
  check(issuesCh.threadsList.length === 0 && issuesCh.sent.length === 0, 'and nothing is posted in the channel');

  // stale buttons (things that were deleted since the menu was drawn) fail politely
  for (const [kind, id, who, values] of [['button', 'evall:99999', dev], ['button', 'follow:99999', alice], ['select', 'status:99999', dev, ['seen']], ['button', 'assign:99999', dev],
    ['button', 'wd:99999', alice], ['button', 'rematch:99999', alice], ['button', 'edit:99999', alice], ['button', 'split:99999', alice], ['button', 'keep:99999', alice],
    ['button', 'trk:99999', alice], ['select', 'mine_view', alice, ['99999']], ['select', 'bfv', alice, ['99999']], ['button', 'art:edit:99999', dev], ['button', 'dupm:99999:99998', dev],
    ['select', 'faq:bug', alice, ['kb:does_not_exist']], ['button', 'history:99999', alice], ['button', 'mkart:99999', dev]]) {
    const r = kind === 'select' ? await choose(who, panelScreen, id, values) : await press(who, panelScreen, id);
    check(r.out.responded && !/TypeError|undefined|Cannot read/.test(textOf(r.out.payload)), `a stale ${id} gets a polite answer, not a crash`);
  }

  // the bot being too slow: every Discord call 2 s → handlers that did work before answering would be late
  sim.LATENCY = 2000;
  const slow = await choose(dev, cardOf(aliceIssueId), `prio:${aliceIssueId}`, ['high']);
  check(slow.i.ackAfterMs <= 3000, 'even on a very slow network a priority change is acknowledged in time');
  sim.LATENCY = 700;
}

// ================================================================= 12b. security and unusual input
console.log('12b. security and unusual input');
{
  const before = JSON.stringify(db.settings.get('G'));
  const setupAs = (who, devRole = { id: ROLE.dev }) => interaction({ kind: 'command', commandName: 'setup', who, channel: panelCh,
    options: { issues_channel: issuesCh, dev_role: devRole } });
  let out = await run(setupAs(alice), '/setup by a player');
  check(has(out.payload, /Manage Server/), 'a player cannot run /setup even if Discord lets them see the command');
  out = await run(setupAs(dev), '/setup by a developer without Manage Server');
  check(has(out.payload, /Manage Server/), 'a developer role alone is not enough to run /setup');
  check(JSON.stringify(db.settings.get('G')) === before, 'a refused /setup changed nothing');
  out = await run(setupAs(admin, { id: 'G' }), '/setup with @everyone as the developer role');
  check(has(out.payload, /@everyone.*can't be the developer/), '@everyone cannot be chosen as the developer role');
  check(JSON.stringify(db.settings.get('G')) === before, '…and nothing changed');

  check(Array.isArray(client.options.allowedMentions?.parse) && client.options.allowedMentions.parse.length === 0, 'the bot cannot ping anyone by accident (@everyone in a title, etc.)');

  const listAdmin = person('listadmin', { roles: [ROLE.dev] }); listAdmin.rolesAsList = true;
  let r = await press(listAdmin, panelScreen, 'dev:menu');
  check(labelsOf(r.out.payload).length >= 7, 'roles supplied as a plain list of ids still make someone a developer');

  const dm = interaction({ kind: 'command', commandName: 'setup', who: admin, channel: panelCh, guildId: null });
  await handleInteraction(dm);
  check(dm.responses.length === 1 && /inside a server/.test(JSON.stringify(dm.responses[0].payload)), 'using the command in a private message gets a polite answer, not silence');

  // unusual report text: mentions, emoji at the cut-off, very long words, other languages
  db.settings.update('G', { cooldown_sec: 0 });
  const odd = [
    '@everyone @here <@&123> this is a test of mentions in a report title that should never ping anybody at all',
    `${'x'.repeat(86)}😀😀😀😀 emoji sits right where the title gets cut`,
    `${'verylongwordwithoutspaces'.repeat(12)} and some more words after it`,
    'El juego se cierra cuando entro en la arena con mi Quest, la música desaparece también',
    '日本語のテキストだけのレポートです。ゲームが起動しません。',
    '```code block``` and **bold** and [link](https://example.com) and `ticks` all in one report body',
  ];
  for (const text of odd) {
    const res = await submit(carol, panelScreen, 'report:bug', { text, platform: '', version: '', links: '' });
    check(has(res.out.payload, /report has been|similar issue/), `an unusual report is accepted: ${text.slice(0, 30)}…`);
  }
  for (const it of db.issues.list('G')) {
    check(!/\ud[89ab][0-9a-f]{2}(?!\ud[c-f])/i.test(JSON.stringify(plain(renderIssue(it)))), 'no half-emoji ended up in a card');
  }
}

// ================================================================= 13. crawler: press every reachable control
console.log('13. crawling every button, menu option and form');
const SKIP = [/^legal:eraseok/, /^wdok:/, /^art:delok:/, /^dupm:/, /^mergeto:/, /^rmsel:/, /^dev:backup/, /^dev:export/, /^dev:digest/, /^board:/, /^set_/];
const FIELD = (c) => {
  if (c.type === 19) return null;
  const min = c.min_length ?? 0;
  return (c.value && c.value.length >= min ? c.value : 'Sample text for testing this form properly').padEnd(min, 'x').slice(0, c.max_length ?? 4000);
};
async function crawl(who, name) {
  const seen = new Set(); const screens = new Set();
  // start from the public panel AND from a public issue card (so every card button is pressed as every kind of user)
  const queue = [{ screen: panelScreen, depth: 0 }, { screen: cardOf(db.issues.list('G')[0].id), depth: 0 }];
  let pressed = 0;
  while (queue.length) {
    const { screen, depth } = queue.shift();
    for (const c of buttonsOf(screen.payload)) {
      if (!c.custom_id || c.style === 5) continue;
      const targets = c.type === 3 ? (c.options ?? []).slice(0, 3).map((o) => o.value) : c.type === 5 ? ['bob'] : [null];
      for (const value of targets) {
        const key = `${name}|${screen.id}|${c.custom_id}|${value}`;
        const loose = `${name}|${c.custom_id}|${value}`;
        if (seen.has(key) || seen.has(loose) || SKIP.some((re) => re.test(c.custom_id))) continue;
        seen.add(key); seen.add(loose); pressed++;
        const i = interaction({ kind: c.type === 3 ? 'select' : c.type === 8 ? 'channelselect' : c.type === 5 ? 'userselect' : 'button', customId: c.custom_id, who, values: value ? [value] : undefined, screen, channel: panelCh });
        const out = await run(i, `${name}: ${c.custom_id}${value ? ` = ${value}` : ''}`);
        let next = nextScreen(screen, i, out);
        if (out.modal) {
          const comps = plain(out.modal).components.map((x) => x.component ?? x.components?.[0]);
          const fields = Object.fromEntries(comps.filter((x) => x && x.type === 4).map((x) => [x.custom_id, FIELD(x)]));
          if (!/^(report:|faqq:)/.test(out.modal.custom_id)) {
            const mi = interaction({ kind: 'modal', customId: out.modal.custom_id, who, fields, screen, channel: panelCh });
            const mo = await run(mi, `${name}: form ${out.modal.custom_id}`);
            next = nextScreen(screen, mi, mo);
          }
        }
        const sig = JSON.stringify([textOf(next.payload).slice(0, 200), buttonsOf(next.payload).map((x) => x.custom_id)]);
        if (next.payload && depth < 5 && !screens.has(sig)) { screens.add(sig); queue.push({ screen: next, depth: depth + 1 }); }
      }
    }
  }
  return pressed;
}
const counts = {};
db.settings.update('G', { cooldown_sec: 0 });
for (const [who, name] of [[outsider, 'outsider'], [alice, 'player'], [editor, 'editor'], [dev, 'developer']]) counts[name] = await crawl(who, name);

// ================================================================= result
console.error = realError;
const unexpected = logged.filter((l) => /Unhandled|TypeError|ReferenceError|Cannot read|is not a function|failed because of an unexpected/.test(l));
for (const l of unexpected) failures.push(`unexpected error in the log: ${l.slice(0, 220)}`);
console.log(`\nran ${interactions} interactions · slowest acknowledgement ${worstAck} ms (limit 3000) · pressed ${Object.entries(counts).map(([k, v]) => `${v} controls as ${k}`).join(', ')}`);
if (failures.length) {
  console.log(`\n${failures.length} PROBLEM${failures.length === 1 ? '' : 'S'}:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('End-to-end test passed.');
