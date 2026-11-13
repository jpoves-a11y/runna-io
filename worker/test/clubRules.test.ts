import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinDecision, canInvite, entryModeFromVisibility, visibilityOf, parseEntryMode, sameCity, cityRefusal, normalizeCity } from '../src/clubRules';

test('entering from the search: open joins, approval asks, invite-only is not reachable', () => {
  assert.equal(joinDecision('open', 'search', 'all'), 'join');
  assert.equal(joinDecision('approval', 'search', 'all'), 'request');
  assert.equal(joinDecision('invite_only', 'search', 'all'), 'forbidden');
});

test('the code: joins, except in approval clubs where it asks', () => {
  assert.equal(joinDecision('open', 'code', 'all'), 'join');
  assert.equal(joinDecision('approval', 'code', 'officers'), 'request');
  assert.equal(joinDecision('invite_only', 'code', 'officers'), 'join');
});

test('invites from the leader or an officer always let you in', () => {
  for (const mode of ['open', 'approval', 'invite_only'] as const) {
    for (const permission of ['all', 'officers'] as const) {
      assert.equal(joinDecision(mode, 'invite', permission, 'owner'), 'join', `${mode} ${permission}`);
      assert.equal(joinDecision(mode, 'invite', permission, 'admin'), 'join', `${mode} ${permission}`);
    }
  }
});

test("an ordinary member's invite: needs approval in approval clubs, invalid once only officers may invite", () => {
  assert.equal(joinDecision('open', 'invite', 'all', 'member'), 'join');
  assert.equal(joinDecision('approval', 'invite', 'all', 'member'), 'request');
  assert.equal(joinDecision('invite_only', 'invite', 'all', 'member'), 'join');
  // The leader changed who can invite after the invite was made
  assert.equal(joinDecision('invite_only', 'invite', 'officers', 'member'), 'forbidden');
  assert.equal(joinDecision('approval', 'invite', 'officers', 'member'), 'request');
  // The inviter left the club
  assert.equal(joinDecision('invite_only', 'invite', 'all', null), 'forbidden');
  assert.equal(joinDecision('open', 'invite', 'all', null), 'join');
});

test('who can invite', () => {
  assert.equal(canInvite('owner', 'officers'), true);
  assert.equal(canInvite('admin', 'officers'), true);
  assert.equal(canInvite('member', 'officers'), false);
  assert.equal(canInvite('member', 'all'), true);
  assert.equal(canInvite(null, 'all'), false);
});

test('older app versions: public / private map to the entry types and back', () => {
  assert.equal(entryModeFromVisibility('private'), 'invite_only');
  assert.equal(entryModeFromVisibility('public'), 'open');
  assert.equal(visibilityOf('approval'), 'public');
  assert.equal(visibilityOf('invite_only'), 'private');
  assert.equal(parseEntryMode('approval'), 'approval');
  assert.equal(parseEntryMode('closed'), null);
});

test('base city: same city whatever the accents, case or spaces; clubs from before the rule accept anyone', () => {
  const club = { city: 'Zaragoza', countryCode: 'ES' };
  assert.equal(sameCity({ city: ' zaragoza ', countryCode: 'ES' }, club), true);
  assert.equal(sameCity({ city: 'Zaragozá', countryCode: 'es' }, club), true);
  assert.equal(sameCity({ city: 'Huesca', countryCode: 'ES' }, club), false);
  // Same name in another country
  assert.equal(sameCity({ city: 'Zaragoza', countryCode: 'MX' }, club), false);
  assert.equal(sameCity({ city: 'Huesca', countryCode: 'ES' }, { city: null, countryCode: null }), true);
});

test('base city: why someone cannot join', () => {
  const club = { city: 'Zaragoza', countryCode: 'ES' };
  assert.equal(cityRefusal({ city: 'Zaragoza', countryCode: 'ES' }, club), null);
  assert.match(cityRefusal({ city: null, countryCode: null }, club) ?? '', /Elige tu ciudad base/);
  assert.match(cityRefusal({ city: 'Huesca', countryCode: 'ES' }, club) ?? '', /Solo pueden unirse corredores de Zaragoza/);
  assert.equal(normalizeCity('  San   Sebastián '), 'san sebastian');
});
