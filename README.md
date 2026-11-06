# Echo VR Issue Tracker (Discord bot)

Players report problems from a button panel. Known problems get an instant suggested fix, similar reports are grouped into one issue (typo tolerant), and developers manage priority, owner and status. Everything is buttons, menus and modals; the only slash command is `/setup`.

## Setup
1. Create an app at https://discord.com/developers/applications → **Bot** → copy the token.
2. Invite it with scopes `bot` + `applications.commands` and permissions: View Channels, Send Messages, Embed Links, **Create Public Threads**, **Send Messages in Threads**, Manage Threads (to lock merged threads).
3. `copy .env.example .env`, fill in `DISCORD_TOKEN` (and `GUILD_ID` for instant command registration while testing).
4. `npm install` then `npm start` (Node 22.5+; built-in SQLite, data in `data/issues.db`).
5. In the channel where players should see the panel run `/setup issues_channel:#echo-issues dev_role:@Developers`.
6. Developers press ⚙️ **Settings** on the panel to set the digest channel, changelog channel, matching sensitivity, stale-days and report cooldown.

## Who can report
Only members with the **reporter role** (plus developers) can create reports – this covers 📝 Report a problem, 🙋 I have this too, and the "Still happening – file my report" button. Everyone can still browse issues. Set the role with `/setup reporter_role:@Role`, or via `REPORTER_ROLE_ID` in `.env` (the example file has it preset); leave both empty to allow everyone.

## Who can change status
Only members with the **status role** can set a ticket's status (Seen / Fix in progress / Fixed / …) – Manage Server does *not* bypass it. Set it with `/setup status_role:@Role` or `STATUS_ROLE_ID` in `.env` (preset in the example file); if neither is set, any developer can. Other developer actions (priority, owner, notes, merge, settings) still use the developer role from `/setup`.

## Player flow
- 📝 **Report a problem** → form (description, headset, version). If it matches a *known problem* the bot shows the fix first (**That fixed it** / **Still happening – file my report**); otherwise it joins or creates an issue.
- 📋 **Browse issues** → filter by status, category, owner; pick an issue to open it. Highest priority and most affected first.
- On any issue: 🙋 **I have this too**. After an auto-match, **Not the same problem** splits it out.
- Reporters get a DM when their issue moves to in progress / fixed / cannot reproduce / won't fix (fixed DMs say which version to update to).

## Developer flow (dev role or Manage Server)
On each issue message: status menu (choosing *Fixed* asks for the fixed-in version + note), priority menu (🔴 Critical / 🟠 High / 🟡 Normal / 🟢 Low – crashes start High), 🙌 **Assign to me** (toggle), 💬 **Dev note**, 🔀 **Merge into…** (similar issues listed first), 🗑️ **Remove report** (spam).
Each issue gets a **discussion thread** for logs and screenshots. Merged issues keep a pointer message and a locked thread.

Panel tools: ⚙️ **Settings**, 🔍 **Review duplicates** (pairs the matcher didn't merge: Merge / Keep separate / Skip), 📊 **Digest** (post now), 📤 **Export CSV** (`issues.csv`, `reports.csv`), 💾 **Back up now**.

## Automatic
- **Weekly digest** in the developer channel: new, top 5 by affected players, fixed, stale (New / Fix in progress with no activity for N days), critical/high with no owner.
- **Changelog**: when an issue becomes Fixed, a release-note style embed is posted to the changelog channel.
- **Backups**: `data/backups/` daily, newest 14 kept (consistent snapshots via `VACUUM INTO`).
- **Cooldown**: non-developers must wait N seconds between reports (default 60s, configurable/off).
- **Regressions**: a new matching report on a Fixed issue reopens it and notes the version it was fixed in.

## Known-problem answers (`src/kb.js`)
Typo-tolerant matches for common errors (GPU hang `DXGI_ERROR_DEVICE_HUNG`, Quest APK/install errors, EchoXR exit codes, nEVR exit codes 78/64, Proton crashes, haptics, server hosting, Discord sign-in, …). Written from the READMEs and release notes of EchoVR_Launcher, EchoXR, EchoVR-Installer, nevr-runtime, EchoVR-Haptics and EchoVR-Windows-Hosts-Resources as of November 2026 – those projects change, so review and edit the entries as fixes ship. Add an entry by giving it `symptoms` (player wording) and optionally a `pattern` (exact error text).

`npm test` runs the offline tests (grouping, typos, known-problem matching, priority/owner/version, duplicates queue, digest, CSV).
