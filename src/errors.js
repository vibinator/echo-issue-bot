// Turns technical failures into a plain explanation of the reason (and what to do), so people never just see
// "something went wrong".
import { trunc } from './text.js';

const NEEDED_PERMISSIONS = 'View Channel, Send Messages, Embed Links, Read Message History, Create Public Threads, Send Messages in Threads and Manage Threads';

/** { reason, fix } for any error. `reason` completes "That didn't work because …". */
export function explainError(err) {
  const code = err?.code ?? err?.rawError?.code ?? err?.cause?.code;
  const text = String(err?.message ?? err ?? '');

  if (code === 50013 || /Missing Permissions/i.test(text)) {
    return { reason: "the bot isn't allowed to do that in this channel", fix: `Ask a server admin to give the bot these permissions there: ${NEEDED_PERMISSIONS}.` };
  }
  if (code === 50001 || /Missing Access/i.test(text)) {
    return { reason: "the bot can't see that channel", fix: 'Ask a server admin to let the bot view the channel (and its threads).' };
  }
  if (code === 10003 || code === 10008 || code === 10004) {
    return { reason: 'the channel or message it needed has been deleted', fix: 'Ask an admin to run `/setup` again to put things back.' };
  }
  if (code === 10062 || code === 40060) {
    return { reason: 'this menu expired or was already used', fix: 'Press the button on the panel again to start over.' };
  }
  if (code === 50035 || /Invalid Form Body/i.test(text)) {
    return { reason: 'Discord rejected part of what was sent (something was too long or in the wrong format)', fix: 'Try again with shorter text, or tell a developer.' };
  }
  if (code === 50007 || /Cannot send messages to this user/i.test(text)) {
    return { reason: "that person's DMs are closed", fix: 'They can turn on DMs from server members in their privacy settings.' };
  }
  if (err?.status === 429 || /rate ?limit/i.test(text)) {
    return { reason: 'Discord is asking the bot to slow down', fix: 'Wait a few seconds and try again.' };
  }
  if (['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return { reason: "the bot couldn't reach Discord for a moment (a network problem)", fix: 'Try again in a minute.' };
  }
  if (code === 'ENOSPC') {
    return { reason: "the server the bot runs on is out of disk space", fix: 'Tell a developer so they can free up space.' };
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { reason: "the bot isn't allowed to write to its data folder", fix: 'Tell a developer to check the folder permissions.' };
  }
  if (/SQLITE|database is locked|no such (table|column)/i.test(text) || String(code).startsWith('ERR_SQLITE')) {
    return { reason: "the bot's database had a problem", fix: 'Try again in a moment. If it keeps happening, tell a developer.' };
  }
  return { reason: `of an unexpected problem (${trunc(text.replace(/\s+/g, ' ') || 'no details', 160)})`, fix: "Try again; if it keeps happening, tell a developer and share this message." };
}

/** The message shown to the person who pressed the button. */
export function errorMessage(err) {
  const { reason, fix } = explainError(err);
  return `⚠️ That didn't work because ${reason}. ${fix}`;
}

/** Why an uploaded file couldn't be saved, in plain words (reason codes come from evidenceStore). */
export function fileFailureReason(reason, maxMb) {
  if (reason === 'too large') return `it's over the ${maxMb} MB limit`;
  if (reason === 'not a Discord attachment') return "it didn't come from Discord";
  const m = /^download failed \((\d+)\)/.exec(reason);
  if (m) return `Discord wouldn't let the bot download it (error ${m[1]})`;
  if (/aborted|timeout/i.test(reason)) return 'the download took too long';
  return `the download failed (${trunc(reason, 80)})`;
}
