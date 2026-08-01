// The telemetry a client tile is built from.
//
// These fields were always on the `/sdk` wire — the server has serialised them
// since long before this SDK existed — but `ClientView` did not declare them, so
// nothing could consume them without casting. Declaring them is additive; what
// is worth testing is that they survive the cache round trip intact, and that
// the two shapes most likely to be mishandled do not quietly break a UI:
//
//   Ram.UsagePercentage is a STRING (the client sends it through toFixed(2)).
//   Reading it as a number renders an empty bar rather than throwing, which is
//   the kind of failure that ships.
//
//   Every field is optional. Monitors, dummies and FreeKiosk terminals carry
//   none of them, and neither does an older server — so a consumer must be able
//   to tell "absent" from "zero".

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeClient, startConnected, waitFor } from './helpers/fake-server.js';

const VITALS = {
  CPU: { UsagePercentage: 42 },
  Ram: { Total: 17_179_869_184, Used: 8_589_934_592, UsagePercentage: '50.00' },
  Uptime: { Formatted: '12:34:56' },
};

async function seed(server, client, clients) {
  server.push('SetFullClientList', clients, []);
  await waitFor(() => client.getAllClients().length === clients.length, {
    label: 'seeded clients',
  });
}

test('tile telemetry survives the cache round trip', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    makeClient({
      Slug: 'foh',
      IP: '192.168.1.50',
      LastSeen: 1_700_000_000_000,
      Vitals: VITALS,
      DegradedWarnings: [],
    }),
  ]);

  const Client = client.getClient('foh');
  assert.equal(Client.IP, '192.168.1.50');
  assert.equal(Client.LastSeen, 1_700_000_000_000);
  assert.equal(Client.Vitals.CPU.UsagePercentage, 42);
  assert.equal(Client.Vitals.Uptime.Formatted, '12:34:56');
});

test('RAM usage arrives as a string, and stays one', async (t) => {
  // Pinned because a consumer that assumes a number gets NaN, and a NaN width
  // renders as an empty bar — a tile that looks like idle hardware rather than
  // a bug. If the server ever starts sending a number this should fail loudly.
  const { server, client } = await startConnected(t);
  await seed(server, client, [makeClient({ Slug: 'foh', Vitals: VITALS })]);

  const Ram = client.getClient('foh').Vitals.Ram;
  assert.equal(typeof Ram.UsagePercentage, 'string');
  assert.equal(Number(Ram.UsagePercentage), 50);
});

test('degraded warnings explain why, not just that', async (t) => {
  const { server, client } = await startConnected(t);
  await seed(server, client, [
    makeClient({
      Slug: 'stage-left',
      Degraded: true,
      DegradedWarnings: ['Critical USB device missing', 'Playback app not running'],
    }),
  ]);

  const Client = client.getClient('stage-left');
  assert.equal(client.getClientStatus('stage-left'), 'DEGRADED');
  assert.deepEqual(Client.DegradedWarnings, [
    'Critical USB device missing',
    'Playback app not running',
  ]);
});

test('an entity with no telemetry reports absent, not zero', async (t) => {
  // A monitoring target has no host of its own. Defaulting these to 0/'' would
  // render a tile claiming 0% CPU on something that has no CPU.
  const { server, client } = await startConnected(t);
  server.push('SetFullMonitoringTargetList', [
    makeClient({ Type: 'monitor', UUID: 'monitor:1', Slug: 'ups' }),
  ]);
  await waitFor(() => !!client.getClient('ups'), { label: 'monitor cached' });

  const Monitor = client.getClient('ups');
  assert.equal(Monitor.Vitals, undefined);
  assert.equal(Monitor.IP, undefined);
});

test('an updated client replaces its telemetry rather than merging it', async (t) => {
  // A client that goes offline stops sending vitals. Merging would leave the
  // last-known CPU figure on screen next to an "Offline" label — stale numbers
  // presented as live ones.
  const { server, client } = await startConnected(t);
  await seed(server, client, [makeClient({ Slug: 'foh', Vitals: VITALS, Online: true })]);

  server.push('ClientUpdated', makeClient({ Slug: 'foh', Online: false }));
  await waitFor(() => client.getClientStatus('foh') === 'OFFLINE', { label: 'offline' });

  assert.equal(client.getClient('foh').Vitals, undefined);
});

// --- Tag membership ----------------------------------------------------------
//
// Exposed because a consumer cannot work it out without reimplementing the scope
// walk, and a second implementation would disagree invisibly: a tag filter that
// quietly omits a machine looks like a tag with fewer members, not like a bug.

test('a tag covers the clients its scope names, directly and by group', async (t) => {
  const { server, client } = await startConnected(t);
  server.push(
    'SetFullClientList',
    [
      makeClient({ UUID: 'u-a', Slug: 'a', GroupID: 1 }),
      makeClient({ UUID: 'u-b', Slug: 'b', GroupID: 2 }),
      makeClient({ UUID: 'u-c', Slug: 'c', GroupID: 2 }),
    ],
    []
  );
  server.push('SetTagList', [
    {
      TagID: 1,
      Slug: 'projectors',
      Scope: { Workspace: false, Groups: [2], Clients: ['u-a'], Tags: [] },
    },
  ]);
  await waitFor(() => client.getTags().length === 1, { label: 'tags cached' });

  const Members = client.getTagMembers('projectors').map((Member) => Member.Slug);
  assert.deepEqual([...Members].sort(), ['a', 'b', 'c']);
  assert.equal(client.isClientInTag('projectors', 'a'), true);
});

test('a workspace tag covers everything', async (t) => {
  const { server, client } = await startConnected(t);
  server.push(
    'SetFullClientList',
    [makeClient({ Slug: 'a' }), makeClient({ UUID: 'u2', Slug: 'b' })],
    []
  );
  server.push('SetTagList', [
    { TagID: 1, Slug: 'all', Scope: { Workspace: true, Groups: [], Clients: [], Tags: [] } },
  ]);
  await waitFor(() => client.getTags().length === 1, { label: 'tags cached' });

  assert.equal(client.getTagMembers('all').length, 2);
});

test('an unknown tag yields no members rather than throwing', async (t) => {
  // A filter can outlive the tag it names — a tag deleted at the desk while the
  // phone is showing it. Degrading to "nothing matches" beats crashing a render.
  const { client } = await startConnected(t);
  assert.deepEqual(client.getTagMembers('deleted'), []);
  assert.equal(client.isClientInTag('deleted', 'a'), false);
});

test('a tag absorbing another covers the other tag members too', async (t) => {
  const { server, client } = await startConnected(t);
  server.push(
    'SetFullClientList',
    [
      makeClient({ UUID: 'u-a', Slug: 'a', GroupID: 1 }),
      makeClient({ UUID: 'u-b', Slug: 'b', GroupID: 9 }),
    ],
    []
  );
  server.push('SetTagList', [
    { TagID: 1, Slug: 'inner', Scope: { Workspace: false, Groups: [1], Clients: [], Tags: [] } },
    { TagID: 2, Slug: 'outer', Scope: { Workspace: false, Groups: [], Clients: [], Tags: [1] } },
  ]);
  await waitFor(() => client.getTags().length === 2, { label: 'tags cached' });

  assert.deepEqual(
    client.getTagMembers('outer').map((Member) => Member.Slug),
    ['a']
  );
});

test('two tags absorbing each other terminate rather than hanging the render', async (t) => {
  // An operator can author this in the scope picker. Without the cycle guard it
  // is an infinite recursion inside a synchronous read called from render.
  const { server, client } = await startConnected(t);
  server.push('SetFullClientList', [makeClient({ UUID: 'u-a', Slug: 'a', GroupID: 1 })], []);
  server.push('SetTagList', [
    { TagID: 1, Slug: 'one', Scope: { Workspace: false, Groups: [], Clients: [], Tags: [2] } },
    { TagID: 2, Slug: 'two', Scope: { Workspace: false, Groups: [1], Clients: [], Tags: [1] } },
  ]);
  await waitFor(() => client.getTags().length === 2, { label: 'tags cached' });

  assert.deepEqual(
    client.getTagMembers('one').map((Member) => Member.Slug),
    ['a']
  );
});
