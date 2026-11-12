import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canDeleteMessage, canMute, isReaction, muteHours, normalizeMessage, parseMentions, CHAT_MESSAGE_MAX } from '../src/clubChat';

test('messages: trimmed, one blank line at most, 1 to 1000 characters', () => {
  assert.equal(normalizeMessage('  Hola  '), 'Hola');
  assert.equal(normalizeMessage('a\r\n\r\n\r\n\r\nb'), 'a\n\nb');
  assert.equal(normalizeMessage('línea   \nsiguiente'), 'línea\nsiguiente');
  assert.equal(normalizeMessage('   \n  '), null);
  assert.equal(normalizeMessage(42), null);
  assert.equal(normalizeMessage('x'.repeat(CHAT_MESSAGE_MAX)), 'x'.repeat(CHAT_MESSAGE_MAX));
  assert.equal(normalizeMessage('x'.repeat(CHAT_MESSAGE_MAX + 1)), null);
});

test('mentions: club members by username, any letter case, once, never the author', () => {
  const members = [
    { userId: 'u-ana', username: 'ana' },
    { userId: 'u-ben', username: 'Ben_R' },
    { userId: 'u-eva', username: 'eva.m' },
  ];
  assert.deepEqual(parseMentions('@ana y @ben_r, ¿salimos? @ANA', members), ['u-ana', 'u-ben']);
  assert.deepEqual(parseMentions('Gracias @eva.m.', members), ['u-eva']);
  assert.deepEqual(parseMentions('@nadie @ana', members, 'u-ana'), []);
  // An email is not a mention
  assert.deepEqual(parseMentions('escribe a ana@ana.com', members), []);
  assert.deepEqual(parseMentions('(@eva.m) vale', members), ['u-eva']);
});

test('reactions: only the six of the chat', () => {
  assert.equal(isReaction('👍'), true);
  assert.equal(isReaction('💪'), true);
  assert.equal(isReaction('💩'), false);
  assert.equal(isReaction(undefined), false);
});

test('deleting: authors their own messages, leader and officers any', () => {
  const mine = { userId: 'me', kind: 'user' };
  const other = { userId: 'x', kind: 'user' };
  const system = { userId: null, kind: 'system' };
  assert.equal(canDeleteMessage('me', 'member', mine), true);
  assert.equal(canDeleteMessage('me', 'member', other), false);
  assert.equal(canDeleteMessage('me', 'member', system), false);
  assert.equal(canDeleteMessage('me', 'admin', other), true);
  assert.equal(canDeleteMessage('me', 'owner', system), true);
});

test('muting: officers mute members, only the leader mutes officers, nobody mutes the leader or themselves', () => {
  assert.equal(canMute('a', 'admin', 'm', 'member'), true);
  assert.equal(canMute('o', 'owner', 'm', 'member'), true);
  assert.equal(canMute('a', 'admin', 'b', 'admin'), false);
  assert.equal(canMute('o', 'owner', 'b', 'admin'), true);
  assert.equal(canMute('a', 'admin', 'o', 'owner'), false);
  assert.equal(canMute('m', 'member', 'n', 'member'), false);
  assert.equal(canMute('a', 'admin', 'a', 'admin'), false);
  assert.equal(canMute('a', 'admin', 'x', null), false);
});

test('mute length: 0 lifts it, 1 to 168 hours', () => {
  assert.equal(muteHours(0), 0);
  assert.equal(muteHours('24'), 24);
  assert.equal(muteHours(168), 168);
  assert.equal(muteHours(169), null);
  assert.equal(muteHours(-1), null);
  assert.equal(muteHours('mucho'), null);
});
