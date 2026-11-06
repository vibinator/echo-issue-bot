# Echo VR Issue Tracker (Discord bot)

Players report problems from a button panel. Known problems get an instant suggested fix (which they can deny), similar reports are grouped into one issue (typo tolerant), and developers manage priority, owner and status on a Trello-style board. Everything is buttons, menus and modals; the only slash command is `/setup`.

**One public message.** The only message the bot keeps in the channel is the control panel; everything you open from it is private (only you see it) and navigates in place with Back buttons. Each issue is a **thread** under the issues channel, with its control card as the thread's first message – so the channel isn't flooded with one message per issue. Developer tools sit behind a single **🛠️ Developer** button. (Digest and changelog posts remain posts, as they are notifications.)

## Setup
1. Create an app at https://discord.com/developers/applications → **Bot** → copy the token. No privileged intents are needed.
2. Invite it with scopes `bot` + `applications.commands` and permissions: View Channels, Send Messages, Embed Links, Read Message History, **Create Public Threads**, **Send Messages in Threads**, Manage Threads.
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=326417599488`
3. Configure with environment variables (see `.env.example`, or the `environment:` block of `docker-compose.yml`): `DISCORD_TOKEN`, `GUILD_ID`, `REPORTER_ROLE_ID`, `STATUS_ROLE_ID`.
4. `npm install` then `npm start` (Node 22.5+; built-in SQLite, data in `data/issues.db`). On a NAS see **Docker** below.
5. In the channel where players should see the panel run `/setup issues_channel:#issues dev_role:@Developers` (optional: `reporter_role`, `status_role`, `retention_days`).
6. Developers press ⚙️ **Settings** on the panel for the digest/changelog channels, matching sensitivity, stale-days and report cooldown.

## Reporting
**📝 Report a problem** goes: 1) **🔧 Install issue** or **🐞 Bug in game** → 2) *"is your problem one of these?"* – a menu of known problems for that type (the server's own articles first) with the fix and **That fixed it / Not my problem / Still happening** → 3) only if none fit, the form (description, headset, version, links and up to 5 uploaded images/logs/videos) → 4) a second automatic check of what they wrote against the known fixes (typo tolerant) before anything is filed. A ticket is only opened when the player says the problem remains. The two types are never merged into each other (install issues share one *Install / Setup* category), and install how-to answers are hidden from game-bug reports.
Uploaded files are re-posted into the issue's thread (Discord's own upload links expire); very large videos should be pasted as links.

## My reports (players)
📌 **My reports** lists everything you reported or follow, with a personal progress card (status, who is on it, fixed-in version, developer note, timeline). From there: ✏️ **Edit report**, 📎 **Add evidence**, 🔄 **Recalculate match** (re-checks which issue your edited report belongs to – it can move it or split it out), 🗑️ **Withdraw**, 🔔/🔕 follow an issue, and 🔕 turn progress DMs off.

## Developer menu (roles below)
The panel's **🛠️ Developer** button opens a hidden menu: Board, Review duplicates, Knowledge articles, Settings, Digest, Export CSV, Back up now.
- **📌 Board** – a Trello-style board (columns New | Seen | Fix in progress, then Fixed | Cannot reproduce | Won't fix); ⏳ marks cards with no activity, 🙌 shows the owner, **My cards** filters to yours, the picker opens a card (with a Back button), **Refresh** redraws it. It is a private view, not a public message.
- On each issue: status (Fixed asks for the fixed-in version), priority, 🙌 assign to me, 💬 note, 🔀 merge, 🗑️ remove a spam report, 📜 history, 📚 **Make article** (turn a solved issue into a knowledge article).
- **📚 Knowledge articles** – add/edit/disable articles (how players describe it, optional exact error text, the answer, a link). **Results** shows how often each suggestion was shown, helped, denied, or still led to a report; **Test matching** previews what a sample report would get.
- 🔍 Review duplicates · 📊 Digest (posts to the digest channel) · 📤 Export CSV · 💾 Back up now · ⚙️ Settings.

## Roles
`REPORTER_ROLE_ID` – only this role (and developers) can create reports. `STATUS_ROLE_ID` – **only** this role can change status (Manage Server does not bypass it). The developer role from `/setup` (or Manage Server) can use the other tools. Leave a variable empty for the default (anyone can report / any developer can change status).

## Automatic
Weekly digest · changelog post when an issue is Fixed · daily DB backup (newest 14 kept) · report cooldown · regressions reopen Fixed issues · optional retention (`/setup retention_days:365` deletes closed issues with no activity for a year).

## Docker (QNAP Container Station etc.)
`docker-compose.yml` builds the image from this folder. To deploy from YAML only, use `node:24-alpine` with a `command` that downloads this repository's tarball, installs and starts it (see the project history); mount a folder on `/app/data` to keep the database. If the container can't resolve `discord.com`, add `dns: [1.1.1.1, 8.8.8.8]` or `network_mode: host`.

## Privacy, terms and Discord's rules
- The panel has **🔒 Data & privacy** and **📜 Terms of use** buttons. Full texts: [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md) – **fill in the contact lines and check they match how you run the bot**. Put their public URLs in the Developer Portal (General Information → Terms of Service URL / Privacy Policy URL); `PRIVACY_URL` / `TERMS_URL` override the in-bot links.
- Users can **erase their data** themselves (Data & privacy → Delete my data): reports, uploaded evidence, follows and settings are removed; if theirs is the only report on an issue developers already worked on, the issue stays with the details removed. They can also withdraw single reports and turn DMs off.
- DMs are sent only about issues the user reported or follows, never advertising, and can be switched off.
- The bot uses no privileged intents and doesn't read general messages. Data is not sold, shared, or used to train AI.
- Keep the bot token secret (rotate it if it was ever pasted anywhere), restrict who can see the issue channel/CSV exports, and tell Discord and affected users about any breach.
- These documents are templates, not legal advice. Re-check Discord's current [Developer Terms](https://discord.com/developers/docs/policies-and-agreements/developer-terms-of-service) and [Developer Policy](https://discord.com/developers/docs/policies-and-agreements/developer-policy) before relying on them, especially if the bot is added to many servers.

## Known-problem answers
`src/kb.js` (built-in, typo tolerant; vocabulary in `src/lexicon.js`) – edit them as the community tooling changes, or add per-server articles from the panel.

`npm test` runs the offline tests (grouping, typos, known-problem matching, ticket types, priority/owner/version, duplicates, digest, CSV, evidence, recalculation, articles, board, privacy/erase/retention).
