# Echo VR Issue Tracker (Discord bot)

Players report problems from a button panel. Known problems get an instant suggested fix (which they can deny), similar reports are grouped into one issue (typo tolerant), and developers manage priority, owner and status on a Trello-style board. Everything is buttons, menus and modals; the only slash command is `/setup`.

**One public message.** The only message the bot keeps in the channel is the control panel; everything you open from it is private (only you see it) and navigates in place with Back buttons. Each issue is a **thread** under the issues channel, with its control card as the thread's first message – so the channel isn't flooded with one message per issue. Developer tools sit behind a single **🛠️ Developer** button. (Digest and changelog posts remain posts, as they are notifications.)

## Setup
1. Create an app at https://discord.com/developers/applications → **Bot** → copy the token. No privileged intents are needed.
2. Invite it with scopes `bot` + `applications.commands` and permissions: View Channels, Send Messages, Embed Links, Read Message History, **Create Public Threads**, **Send Messages in Threads**, Manage Threads.
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=326417599488`
3. Configure with environment variables (see `.env.example`, or the `environment:` block of `docker-compose.yml`): `DISCORD_TOKEN`, `GUILD_ID`, `REPORTER_ROLE_ID`.
4. `npm install` then `npm start` (Node 22.5+; built-in SQLite, data in `data/issues.db`). On a NAS see **Docker** below.
5. In the channel where players should see the panel run `/setup issues_channel:#issues dev_role:@Developers` (optional: `reporter_role`, `retention_days`).
6. Developers press ⚙️ **Settings** on the panel for the digest/changelog channels, matching sensitivity, stale-days and report cooldown.

## Reporting
**📝 Report a problem** goes: 1) **🔧 Install issue** or **🐞 Bug in game** → 2) an optional one-line box, *"Describe the problem briefly"* → 3) *"is your problem one of these?"* – a menu of the known problems for that type, with the closest fuzzy (typo tolerant) matches to what they wrote listed first (⭐), then the server's own articles, then the rest; each shows the fix with **That fixed it / Not my problem / Still happening** → 4) **None of these – report it** (or *Still happening*) opens the full form (description pre-filled with their line, headset, version, links and up to 5 uploaded images/logs/videos) and the report is filed. **Nothing is searched after the form is submitted**: once someone says the list doesn't help, the bot doesn't second-guess them. The one-line description is kept in memory for 15 minutes only and never stored. The two types are never merged into each other (install issues share one *Install / Setup* category), and install how-to answers are hidden from game-bug reports.
**Attachments are private.** Uploaded files are copied to the bot's own folder (`data/evidence`, 25 MB each by default – `EVIDENCE_MAX_MB`) and are never posted in a channel or thread; links are stored as text. The public issue card shows only a count and who the **requester** is (the person who sent the first report; others are counted as "+ N others"). Only the requester of an attachment (**My reports → My attachments**, or **View attachments** on the issue) and developers can open it; the bot checks who is asking each time. Files are deleted with their report (withdraw, erase my data, retention). Very large videos should be pasted as links. Back up `data/evidence` along with the database if you want attachments in your backups.

## My reports (players)
📌 **My reports** lists everything you reported or follow, with a personal progress card (status, who is on it, fixed-in version, developer note, timeline). From there: ✏️ **Edit report**, 📎 **Add evidence**, 🔄 **Recalculate match** (re-checks which issue your edited report belongs to – it can move it or split it out), 🗑️ **Withdraw**, 🔔/🔕 follow an issue, and 🔕 turn progress DMs off.

## Developer menu (roles below)
The panel's **🛠️ Developer** button opens a hidden menu: Board, Review duplicates, Knowledge articles, Settings, Digest, Export CSV, Back up now.
- **📌 Board** – a Trello-style board (columns New | Seen | Being fixed, then Fixed | Can't reproduce | Won't fix); ⏳ marks cards with no activity, 🙌 shows the owner, **My cards** filters to yours, the picker opens a card (with a Back button), **Refresh** redraws it. It is a private view, not a public message.
- On each issue: status (Fixed asks for the fixed-in version), priority, 🙌 assign to me, 💬 note, 🔀 merge, 🗑️ remove a spam report, 📜 history, 📚 **Make article** (turn a solved issue into a knowledge article).
- **📚 Knowledge articles** – add/edit/disable articles (how players describe it, optional exact error text, the answer, a link). **Results** shows how often each suggestion was shown, helped, denied, or still led to a report; **Test matching** previews what a sample report would get.
- 🔍 Review duplicates · 📊 Digest (posts to the digest channel) · 📤 Export CSV · 💾 Back up now · ⚙️ Settings.

## Roles
There are three roles. **Knowledge article editors** (optional: `/setup article_role:@Role`, or `ARTICLE_ROLE_ID`) can create, edit, enable/disable and delete knowledge articles, see how well they work and use Test matching – through the same **🛠️ Developer** button, which shows them only the article tools – and use **Make knowledge article** on an issue. They get nothing else: no board, settings, export, status changes or attachments. **Developers** (the `dev_role` from `/setup`, or anyone with Manage Server) can do everything on the developer side: change an issue's status, priority and owner, add notes, merge, manage articles and use the Developer menu. `REPORTER_ROLE_ID` (optional) – only this role, plus developers, can send reports; leave it empty to let everyone report. Everyone can browse issues and manage their own reports.

## Automatic
Weekly digest · changelog post when an issue is Fixed · daily DB backup (newest 14 kept) · report cooldown · regressions reopen Fixed issues · optional retention (`/setup retention_days:365` deletes closed issues with no activity for a year).

## Docker (QNAP Container Station etc.)
`docker-compose.yml` builds the image from this folder. To deploy from YAML only, use `node:24-alpine` with a `command` that downloads this repository's tarball, installs and starts it (see the project history); mount a folder on `/app/data` to keep the database. If the container can't resolve `discord.com`, add `dns: [1.1.1.1, 8.8.8.8]` or `network_mode: host`.

## If something gets deleted
Everything (issues, reports, evidence links, knowledge articles, settings, the panel/thread ids) lives in **one database file**: `data/issues.db`. The container and the bot account hold nothing, so:

| What was deleted | What happens |
|---|---|
| The container / application | Recreate it with the same YAML; it reuses the database in the mounted data folder. Nothing is lost and `/setup` isn't even needed. |
| The bot (kicked, or re-invited / a new bot application with a new token) | Settings and issues are keyed by server, so they are kept. Run `/setup` again: it keeps every saved setting, takes a safety backup first, replaces the panel, and tells you how much existing data it found. Cards the old bot account wrote can't be edited by the new one, so it posts a fresh card **inside each issue's existing thread** (no duplicate threads). |
| The panel message | Run `/setup` again. |
| The data folder (database) | If a backup survives, the bot **restores the newest one automatically on start** and logs it. Keep backups somewhere separate (below). |

**Keep backups separate from the database.** Set `BACKUP_DIR` to a folder on a different share (ideally another disk) and mount it, e.g. in the YAML:
```yaml
    volumes:
      - /share/Container/echo-issue-bot/data:/app/data
      - /share/Backups/echo-issue-bot:/app/backups      # a different share
    environment:
      BACKUP_DIR: "/app/backups"
```
A backup is made daily (newest 14 kept), whenever a developer presses **Back up now**, and before every `/setup`. To restore a specific backup by hand: stop the container, copy that `.db` file over `data/issues.db`, start it again.

## Privacy, terms and Discord's rules
- The panel has **🔒 Data & privacy** and **📜 Terms of use** buttons. Full texts: [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md) – **fill in the contact lines and check they match how you run the bot**. Put their public URLs in the Developer Portal (General Information → Terms of Service URL / Privacy Policy URL); `PRIVACY_URL` / `TERMS_URL` override the in-bot links.
- Users can **erase their data** themselves (Data & privacy → Delete my data): reports, uploaded evidence, follows and settings are removed; if theirs is the only report on an issue developers already worked on, the issue stays with the details removed. They can also withdraw single reports and turn DMs off.
- DMs are sent only about issues the user reported or follows, never advertising, and can be switched off.
- The bot uses no privileged intents and doesn't read general messages. Data is not sold, shared, or used to train AI.
- Keep the bot token secret (rotate it if it was ever pasted anywhere), restrict who can see the issue channel/CSV exports, and tell Discord and affected users about any breach.
- These documents are templates, not legal advice. Re-check Discord's current [Developer Terms](https://discord.com/developers/docs/policies-and-agreements/developer-terms-of-service) and [Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy) before relying on them, especially if the bot is added to many servers.

## How the matching works
Used for the "is it one of these?" menu, for grouping similar reports, and for the duplicate review. No AI service – plain word comparison that runs on your own server:
- **Typos** are fixed against a vocabulary of Echo VR terms (`src/lexicon.js`: EchoXR, nEVR, Quest, SteamVR, Proton, haptics…) and against words already used in existing issues, while ordinary words like "patch" or "beta" are left alone.
- **Everyday phrasing** is understood: "won't start", "doesn't work", "black screen", "log in / sign in", "went away", "not moving", "game files", "steam vr", "cuts out / drops out", plus word endings (connect / connecting / connection) and synonym groups (crash, freeze, quits, closes; lag, ping, rubber banding…).
- **Platform-aware**: someone who mentions Quest isn't pointed at the PC guide first, and vice versa.
- **Learns from reactions**: an answer that often gets "That fixed it!" ranks a little higher, one that keeps getting "That's not my problem" a little lower (after 5 views, never by more than 20%).
- Measured on sample player sentences (typos and loose wording, plus look-alike problems that have no answer): the original matcher found the right answer first 40–63% of the time; this one does 70–100% depending on how loosely the sentences are worded, with almost no wrong suggestions. A match only re-orders the menu, so a wrong guess never blocks anyone. Add words or phrases to `src/lexicon.js` and `PHRASES` in `src/similarity.js` as you see what players really write.

## Known-problem answers
`src/kb.js` (built-in, typo tolerant; vocabulary in `src/lexicon.js`) – edit them as the community tooling changes, or add per-server articles from the panel.

`npm test` runs the offline tests (grouping, typos, known-problem matching, ticket types, priority/owner/version, duplicates, digest, CSV, evidence, recalculation, articles, board, privacy/erase/retention).
