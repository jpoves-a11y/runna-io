// Who can enter a club and who can invite: pure rules, shared by the club endpoints and the tests.
//
// Entry types (chosen by the leader and officers):
//   - open: listed in the search; anyone joins at once.
//   - approval: listed in the search; joining sends a request the leader or an officer approves.
//   - invite_only: not listed; only with the code, an invite link or a personal invite.
// Invite permission (chosen by the leader): everybody, or only the leader and the officers.
// Invites from ordinary members of an "approval" club go through approval too.
import type { ClubRole } from '../../shared/game';

export type EntryMode = 'open' | 'approval' | 'invite_only';
export type InvitePermission = 'all' | 'officers';
/** How someone reaches the club: its search card, its code, or an invite (link or personal). */
export type JoinVia = 'search' | 'code' | 'invite';
export type JoinDecision = 'join' | 'request' | 'forbidden';

export const ENTRY_MODES: EntryMode[] = ['open', 'approval', 'invite_only'];
export const CLUB_DESCRIPTION_MAX = 500;

export function isOfficer(role: ClubRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function parseEntryMode(value: unknown): EntryMode | null {
  return ENTRY_MODES.includes(value as EntryMode) ? (value as EntryMode) : null;
}

/** Older app versions send public / private. */
export function entryModeFromVisibility(visibility: unknown): EntryMode {
  return visibility === 'private' ? 'invite_only' : 'open';
}

/** Kept for older app versions: an invite-only club is "private", the others are listed ("public"). */
export function visibilityOf(entryMode: EntryMode): 'public' | 'private' {
  return entryMode === 'invite_only' ? 'private' : 'public';
}

/** Whether a member with `role` can invite (personal invites, links) and see the code. */
export function canInvite(role: ClubRole | null | undefined, permission: InvitePermission): boolean {
  if (!role) return false;
  return isOfficer(role) || permission === 'all';
}

/**
 * What happens when someone tries to enter a club.
 * `inviterRole` is the CURRENT role in the club of whoever made the invite or link (null if they
 * left it), checked when the invite is used.
 */
export function joinDecision(entryMode: EntryMode, via: JoinVia, permission: InvitePermission, inviterRole: ClubRole | null = null): JoinDecision {
  if (via === 'search') {
    if (entryMode === 'open') return 'join';
    if (entryMode === 'approval') return 'request';
    return 'forbidden';
  }
  if (via === 'code') {
    return entryMode === 'approval' ? 'request' : 'join';
  }
  // Invite (link or personal)
  if (isOfficer(inviterRole)) return 'join';
  // An ordinary member's invite: only valid while members may invite
  if (!inviterRole || permission !== 'all') return entryMode === 'invite_only' ? 'forbidden' : entryMode === 'approval' ? 'request' : 'join';
  return entryMode === 'approval' ? 'request' : 'join';
}
