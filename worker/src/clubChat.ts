/**
 * Club chat rules, pure (no database): message text, @mentions, who deletes and who mutes.
 */
import type { ClubRole } from '../../shared/game';
import { isOfficer } from './clubRules';

export const CHAT_MESSAGE_MAX = 1000;
/** Messages per page (and of the latest page the app polls) */
export const CHAT_PAGE_SIZE = 50;
/** Messages older than this are deleted by the cron */
export const CHAT_RETENTION_DAYS = 90;
/** The only reactions (one tap each, toggled) */
export const CHAT_REACTIONS = ['👍', '❤️', '🔥', '😂', '👏', '💪'] as const;
/** Longest mute an officer can give (a week) */
export const MUTE_MAX_HOURS = 168;

/** Trimmed text with at most one blank line in a row, or null when empty or too long. */
export function normalizeMessage(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const body = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (body.length === 0 || body.length > CHAT_MESSAGE_MAX) return null;
  return body;
}

/** Members mentioned with @username (case-insensitive), without repeats or the author. */
export function parseMentions(body: string, members: Array<{ userId: string; username: string }>, authorId?: string): string[] {
  const byName = new Map(members.map((m) => [m.username.toLowerCase(), m.userId]));
  const found: string[] = [];
  for (const match of body.matchAll(/(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]{2,30})/gu)) {
    // A trailing dot or dash is punctuation ("@ana." / "@ana-"), not part of the name
    const name = match[2].replace(/[.-]+$/, '').toLowerCase();
    const userId = byName.get(name);
    if (userId && userId !== authorId && !found.includes(userId)) found.push(userId);
  }
  return found;
}

export function isReaction(emoji: unknown): emoji is (typeof CHAT_REACTIONS)[number] {
  return typeof emoji === 'string' && (CHAT_REACTIONS as readonly string[]).includes(emoji);
}

/** Authors delete their own messages; the leader and officers delete any (system ones too). */
export function canDeleteMessage(actorId: string, actorRole: ClubRole | null, message: { userId: string | null; kind: string }): boolean {
  if (isOfficer(actorRole)) return true;
  return message.kind === 'user' && message.userId === actorId;
}

/**
 * Officers mute ordinary members; only the leader mutes officers; nobody mutes the leader or
 * themselves.
 */
export function canMute(actorId: string, actorRole: ClubRole | null, targetId: string, targetRole: ClubRole | null): boolean {
  if (!isOfficer(actorRole) || !targetRole || actorId === targetId) return false;
  if (targetRole === 'owner') return false;
  if (targetRole === 'admin') return actorRole === 'owner';
  return true;
}

/** Mute length from the request: 1..168 hours, 0 lifts it; null when invalid. */
export function muteHours(value: unknown): number | null {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours < 0 || hours > MUTE_MAX_HOURS) return null;
  return Math.round(hours);
}
