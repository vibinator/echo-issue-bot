# Privacy Policy – Echo VR Issue Tracker (Discord bot)

_Last updated: 2026-11-06. This is a template written for a community-run bot; the person or team running the bot is the "operator" and should replace the contact details below and check it matches how they run the bot. It is not legal advice._

## Who is responsible
The bot is run by the operator of the Discord server it is installed in (the "server"). Contact the operator through the server's developers/moderators, or at: **[add an email or contact link here]**. The bot is community software. It is not made, run or endorsed by Discord.

## What the bot stores
Per server, in a database on the operator's own hardware:

| Data | Why |
|---|---|
| Your Discord **user ID** | to attribute reports, show you your own reports, and DM you about them |
| What you submit: description, headset/platform, last update / version number | to understand, group and fix the problem |
| **Links** you add and **files** you upload (screenshots, logs, video) | as evidence. Files are copied into a private folder on the operator's server (not posted in any channel or thread); links are stored as text. Files are limited in size (25 MB each by default) |
| Timestamps; whether a report was edited | to show history |
| Issues you **follow** | to DM you when they change |
| Your **DM preference** | so you can turn DMs off |
| Your **display name** | shown on issue cards instead of a numeric ID; deleted with your data |
| Each issue's status history and which developer made changes | to show progress and for developer coordination |

The bot does **not** read general messages in the server. It only receives the forms, buttons and menus people use and the `/setup` command. It does not request any privileged Discord intents.

## How the data is used
Only to run the issue tracker: group similar reports (word-similarity run locally), suggest known fixes, show developers a board and weekly summary, show you the progress of your reports, and **send you a direct message when an issue you reported or follow changes status or gets a developer note**. You can turn those DMs off (My issues → Turn DMs off). The bot sends no advertising and no unrelated messages.

The data is **not sold, shared with third parties, used for advertising, or used to train AI models**. No third-party analytics are used.

## Who can see it
- People who can see the server's issue channel see your mention and the text of your report. The issue only shows *how many* attachments it has.
- **Your attachments and links are shown only to you and to developers.** (The *requester* is the person who sent a report; each requester can open only their own files.) The bot checks who is asking every time someone opens them.
- Developers (the developer role, and members with Manage Server) can also see the history, and can export reports **including user IDs** as CSV.
- The operator can access the database and its backups.

## Backups and retention
The database is backed up daily on the operator's hardware (newest 14 backups kept). Uploaded files live in the bot's data folder (`data/evidence`) and are deleted together with their report. Data is kept until you erase it, a developer deletes it, or – if the operator enabled it with `/setup retention_days` – closed issues are deleted after that many days without activity. Erased data can remain in backups until those rotate out (up to 14 days).

## Your choices and rights
- **Edit, add to, or withdraw** your reports: panel → **My issues**.
- **Turn DMs off**: **My issues** → **Turn DMs off**.
- **Delete all my data**: panel → **Data & privacy** → **Delete my data**. This deletes your reports, the files you uploaded, your follows and settings. If yours is the only report on an issue developers have already worked on, the issue stays but your details are removed. Messages you wrote yourself in an issue thread, and DMs already sent, are separate Discord messages: ask a moderator to remove thread messages.
- Ask the operator for a copy of your data or to delete it, using the contact above.
- If you remove your account from Discord, ask the operator to delete your data; the bot cannot tell when an account has been closed.

## Please don't submit
Passwords, tokens, payment details, or other people's personal information. **Log files can contain your Windows user name, computer name or IP address** – remove those before uploading.

## Children
Discord requires users to be at least 13 (or the minimum age in their country). The bot is not designed for younger children and does not knowingly collect their data.

## Security
Keep the bot token secret and rotate it if exposed. Access to the database and exports is limited to the operator and developers. The operator will tell Discord and affected people about any breach affecting Discord user data as required.

## Changes
Changes are published in this file; the date above shows the latest update.
