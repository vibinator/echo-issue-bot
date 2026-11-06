// In-bot Data & Privacy notice and Terms of Use (shown from the panel buttons).
// The full versions live in PRIVACY.md / TERMS.md in the repository – edit those and the lines below together.
// Set PRIVACY_URL / TERMS_URL in the environment if you host the documents somewhere else.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

const REPO = 'https://github.com/vibinator/echo-issue-bot/blob/main';
export const PRIVACY_URL = process.env.PRIVACY_URL || `${REPO}/PRIVACY.md`;
export const TERMS_URL = process.env.TERMS_URL || `${REPO}/TERMS.md`;

const contact = (devRoleId) => (devRoleId ? `a member of <@&${devRoleId}> in this server` : 'a server moderator');

export function privacyPayload(devRoleId, retentionDays) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🔒 Data & privacy')
    .setDescription([
      'This community tool helps developers collect, group and fix problems with Echo VR. It is run by this server, not by Discord.',
      '',
      '**What is stored (in this server)**',
      '• Your Discord user ID and the issues you report or follow',
      '• What you write: description, headset/platform, game/launcher version',
      '• Links you add, and files you upload (screenshots, logs, video – re-posted in the issue\'s thread in this server)',
      '• When you reported or edited, your DM preference, and each issue\'s status history',
      '',
      '**Why:** to group and fix problems, show you progress, and DM you when an issue you reported or follow changes. Nothing else.',
      '',
      '**Who can see it:** anyone who can see the issue channel sees your mention and report text. Developers also see a CSV export that includes user IDs.',
      '',
      '**Not done:** no selling or sharing, no ads, no third-party analytics, no AI training. Matching uses simple word similarity run on our own server.',
      '',
      `**How long:** until you erase it or developers delete it${retentionDays ? `; closed issues are deleted automatically after **${retentionDays} days** without activity` : ''}.`,
      '',
      '**Your choices:** ✏️ edit or 🗑️ withdraw a report under **My reports**; 🔕 turn DMs off there; or erase everything below.',
      '',
      '⚠️ **Don\'t submit** passwords, tokens, payment details or other people\'s personal info. Logs can contain your Windows user name or IP address – remove it before uploading.',
      '',
      `Questions or requests: ask ${contact(devRoleId)}.`,
    ].join('\n'))
    .setFooter({ text: 'Not affiliated with or endorsed by Discord.' });
  return {
    content: '',
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Full policy').setEmoji('📄').setStyle(ButtonStyle.Link).setURL(PRIVACY_URL),
      new ButtonBuilder().setCustomId('legal:erase').setLabel('Delete my data').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('mine').setLabel('My reports & DM settings').setEmoji('📌').setStyle(ButtonStyle.Secondary),
    )],
  };
}

export function termsPayload(devRoleId) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('📜 Terms of use')
    .setDescription([
      'By sending a report or using this tool you agree to:',
      '',
      '• Report real problems with Echo VR, in good faith. No spam, jokes, advertising or repeated duplicate reports.',
      '• Follow [Discord\'s Terms of Service](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines). No hateful, sexual, harassing, illegal or malicious content, and no links to malware or scams.',
      '• Only upload files you own or may share, with personal information removed.',
      '• Accept that developers may edit, merge, reprioritise, close or remove issues and reports, and may restrict access to anyone who misuses the tool.',
      '• Understand that reports are visible to people who can see the issue channel, and that sending a report is not a promise of a fix or a reply.',
      '',
      'This is a community-run tool provided as is. It is not made or endorsed by Discord. See the **Data & privacy** notice for how your information is handled.',
      '',
      `Questions: ask ${contact(devRoleId)}.`,
    ].join('\n'));
  return {
    content: '',
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Full terms').setEmoji('📄').setStyle(ButtonStyle.Link).setURL(TERMS_URL),
      new ButtonBuilder().setCustomId('legal:privacy').setLabel('Data & privacy').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
    )],
  };
}

export function erasePayload() {
  return {
    content: '**Delete all my data in this server?**\nThis removes your reports, attachments you uploaded, follows and settings. If yours is the only report on an issue developers have already worked on, the issue stays but your details are removed from it. This can\'t be undone. DMs already sent can\'t be recalled.',
    embeds: [],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('legal:eraseok').setLabel('Yes, delete my data').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('legal:privacy').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  };
}
