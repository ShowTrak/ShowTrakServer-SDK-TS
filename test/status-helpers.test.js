// The two exported pure helpers integrations use to paint their own surfaces.
// They must agree with how the server UI paints a tile, so the precedence rules
// are pinned explicitly here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ClientLabel, DeriveClientStatus } from '../dist/index.js';
import { makeClient } from './helpers/fake-server.js';

test('DeriveClientStatus: unassigned reads as idle regardless of connectivity', () => {
  const status = DeriveClientStatus(makeClient({ Unassigned: true, Online: true, Degraded: true }));
  assert.equal(status, 'IDLE');
});

test('DeriveClientStatus: offline beats degraded', () => {
  assert.equal(DeriveClientStatus(makeClient({ Online: false, Degraded: true })), 'OFFLINE');
});

test('DeriveClientStatus: online + warnings is degraded', () => {
  assert.equal(DeriveClientStatus(makeClient({ Online: true, Degraded: true })), 'DEGRADED');
});

test('DeriveClientStatus: online and clean is online', () => {
  assert.equal(DeriveClientStatus(makeClient({ Online: true, Degraded: false })), 'ONLINE');
});

test('DeriveClientStatus: missing flags are treated as offline', () => {
  assert.equal(DeriveClientStatus({ Type: 'client', UUID: 'u', Slug: 's' }), 'OFFLINE');
});

test('ClientLabel prefers nickname, then hostname, then slug, then UUID', () => {
  const base = { Type: 'client', UUID: 'uuid-9', Slug: 'stage-left', Hostname: 'FOH-PC' };
  assert.equal(ClientLabel({ ...base, Nickname: 'Front of House' }), 'Front of House');
  assert.equal(ClientLabel({ ...base, Nickname: null }), 'FOH-PC');
  assert.equal(ClientLabel({ ...base, Nickname: null, Hostname: null }), 'stage-left');
  assert.equal(ClientLabel({ ...base, Nickname: null, Hostname: null, Slug: null }), 'uuid-9');
});

test('ClientLabel treats whitespace-only names as absent and trims the winner', () => {
  const base = { Type: 'client', UUID: 'uuid-9', Slug: 'stage-left' };
  // A user clearing a nickname to spaces should fall through, not render blank.
  assert.equal(ClientLabel({ ...base, Nickname: '   ', Hostname: 'FOH-PC' }), 'FOH-PC');
  assert.equal(ClientLabel({ ...base, Nickname: '   ', Hostname: '  ' }), 'stage-left');
  assert.equal(ClientLabel({ ...base, Nickname: '  Booth  ' }), 'Booth');
});
