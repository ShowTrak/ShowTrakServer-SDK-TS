// Scope rollup: group / tag / all-clients status. This drives the colour of a
// single Companion button standing in for many machines, so the precedence has
// to be exact — a scope is only "healthy" when every member is up, and one
// offline member must not read as a fully-offline scope.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeClient, startConnected, waitFor } from './helpers/fake-server.js';

const GROUPS = [
  { GroupID: 1, Title: 'Front of House', Slug: 'foh' },
  { GroupID: 2, Title: 'Stage', Slug: 'stage' },
];

/** Push a client list and wait for the cache to reflect it. */
async function seed(server, client, clients, groups = GROUPS) {
  server.push('SetFullClientList', clients, groups);
  await waitFor(() => client.getAllClients().length === clients.length, {
    label: `${clients.length} seeded clients`,
  });
}

function inGroup(id, overrides) {
  return makeClient({ UUID: `u-${overrides.Slug}`, GroupID: id, ...overrides });
}

test('a group of all-online members is ONLINE', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: true }),
    inGroup(1, { Slug: 'b', Online: true }),
  ]);
  assert.equal(client.getGroupStatus('foh'), 'ONLINE');
});

test('one offline member drags the group to DEGRADED, not OFFLINE', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: true }),
    inGroup(1, { Slug: 'b', Online: false }),
  ]);
  assert.equal(client.getGroupStatus('foh'), 'DEGRADED');
});

test('one degraded member drags the group to DEGRADED', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: true }),
    inGroup(1, { Slug: 'b', Online: true, Degraded: true }),
  ]);
  assert.equal(client.getGroupStatus('foh'), 'DEGRADED');
});

test('a group reads OFFLINE only when every member is down', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: false }),
    inGroup(1, { Slug: 'b', Online: false }),
  ]);
  assert.equal(client.getGroupStatus('foh'), 'OFFLINE');
});

test('a group reads IDLE only when every member is unassigned', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Unassigned: true }),
    inGroup(1, { Slug: 'b', Unassigned: true }),
  ]);
  assert.equal(client.getGroupStatus('foh'), 'IDLE');
});

test('idle members do not detract from an otherwise-online group', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: true }),
    inGroup(1, { Slug: 'b', Unassigned: true }),
  ]);
  assert.equal(client.getGroupStatus('foh'), 'ONLINE');
});

test('an empty group reads OFFLINE', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [inGroup(1, { Slug: 'a', Online: true })]);
  // Group 2 exists but has no members.
  assert.equal(client.getGroupStatus('stage'), 'OFFLINE');
});

test('group membership ignores clients in other groups', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: true }),
    inGroup(2, { Slug: 'b', Online: false }),
  ]);
  assert.equal(client.getGroupStatus('foh'), 'ONLINE');
  assert.equal(client.getGroupStatus('stage'), 'OFFLINE');
});

test('group rollup spans monitors and dummies, not just real clients', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [inGroup(1, { Slug: 'a', Online: true })]);

  server.push('SetFullMonitoringTargetList', [
    makeClient({ Type: 'monitor', UUID: 'monitor:1', Slug: 'proj', GroupID: 1, Online: false }),
  ]);
  await waitFor(() => client.getClient('proj'), { label: 'monitor cached' });

  assert.equal(client.getGroupStatus('foh'), 'DEGRADED');
});

test('a workspace-scoped tag covers every client', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: true }),
    inGroup(2, { Slug: 'b', Online: false }),
  ]);
  server.push('SetTagList', [
    { TagID: 1, Slug: 'everything', Scope: { Workspace: true, Groups: [], Clients: [] } },
  ]);
  await waitFor(() => client.getTags().length === 1, { label: 'tag cached' });

  assert.equal(client.getTagStatus('everything'), 'DEGRADED');
});

test('a tag scoped to a group resolves membership by GroupID', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: true }),
    inGroup(2, { Slug: 'b', Online: false }),
  ]);
  server.push('SetTagList', [
    { TagID: 1, Slug: 'foh-tag', Scope: { Workspace: false, Groups: [1], Clients: [] } },
  ]);
  await waitFor(() => client.getTags().length === 1, { label: 'tag cached' });

  // Only the group-1 client is in scope, and it is online.
  assert.equal(client.getTagStatus('foh-tag'), 'ONLINE');
});

test('a tag scoped to explicit UUIDs resolves membership by UUID', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: true }),
    inGroup(2, { Slug: 'b', Online: false }),
  ]);
  server.push('SetTagList', [
    { TagID: 1, Slug: 'picked', Scope: { Workspace: false, Groups: [], Clients: ['u-b'] } },
  ]);
  await waitFor(() => client.getTags().length === 1, { label: 'tag cached' });

  assert.equal(client.getTagStatus('picked'), 'OFFLINE');
});

test('a tag with no scope falls back to covering everything', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [inGroup(1, { Slug: 'a', Online: false })]);
  // Older servers omit Scope; treating it as "no members" would paint the
  // button OFFLINE-empty rather than reflecting the workspace.
  server.push('SetTagList', [{ TagID: 1, Slug: 'legacy' }]);
  await waitFor(() => client.getTags().length === 1, { label: 'tag cached' });

  assert.equal(client.getTagStatus('legacy'), 'OFFLINE');
});

test('a tag matching no clients reads OFFLINE', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [inGroup(1, { Slug: 'a', Online: true })]);
  server.push('SetTagList', [
    { TagID: 1, Slug: 'empty', Scope: { Workspace: false, Groups: [99], Clients: [] } },
  ]);
  await waitFor(() => client.getTags().length === 1, { label: 'tag cached' });

  assert.equal(client.getTagStatus('empty'), 'OFFLINE');
});

test('getAllStatus rolls up every entity type', async (t) => {
  const { server, client } = await startConnected(t);

  // No clients at all — nothing to report on.
  assert.equal(client.getAllStatus(), 'OFFLINE');

  await seed(server, client, [
    inGroup(1, { Slug: 'a', Online: true }),
    inGroup(2, { Slug: 'b', Online: true }),
  ]);
  assert.equal(client.getAllStatus(), 'ONLINE');

  server.push('SetFullDummyClientList', [
    makeClient({ Type: 'dummy', UUID: 'dummy:1', Slug: 'spare', Online: false }),
  ]);
  await waitFor(() => client.getAllClients().length === 3, { label: 'dummy cached' });
  assert.equal(client.getAllStatus(), 'DEGRADED');
});
