// Auxiliary entity kinds: monitoring targets, dummy clients and FreeKiosk
// terminals.
//
// The server projects each of them into a ClientView and pushes them on their
// own pair of events. The SDK wires all three from one table (AUXILIARY_ENTITIES
// in src/client.ts), so these tests are really about the table being complete
// and the generic wiring behaving per-kind: a full-list replacement for one kind
// must never disturb another, and every kind has to reach getAllClients(), which
// is what every aggregate — tag status, group status, summary counts — reads.
//
// The tag-scope tests carry the most weight. A tag records a monitoring target
// by its PREFIXED id but a dummy or a terminal by a BARE uuid, while the pushed
// ClientView always carries the prefixed form. Comparing only the pushed form
// drops those entities from the tag with no error anywhere — the tag simply
// reports the status of everything else, which is how it went unnoticed for
// dummy clients until FreeKiosk terminals ran into the same wall.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeClient, startConnected, waitForEvent } from './helpers/fake-server.js';

const monitor = makeClient({
  Type: 'monitor',
  UUID: 'monitor:7',
  Slug: 'projector-sr',
  Nickname: 'Projector SR',
  Online: true,
});
const dummy = makeClient({
  Type: 'dummy',
  UUID: 'dummy:abc',
  Slug: 'spare-slot',
  Nickname: 'Spare Slot',
  Online: true,
});
const kiosk = makeClient({
  Type: 'freekiosk',
  UUID: 'kiosk:def',
  Slug: 'lobby-tablet',
  Nickname: 'Lobby Tablet',
  Online: true,
});

/** Push one full list per kind and wait for each to land. */
async function seedAll(server, client) {
  for (const [event, list] of [
    ['SetFullMonitoringTargetList', [monitor]],
    ['SetFullDummyClientList', [dummy]],
    ['SetFullFreeKioskTerminalList', [kiosk]],
  ]) {
    const changed = waitForEvent(client, 'clientsChanged');
    server.push(event, list);
    await changed;
  }
}

test('a FreeKiosk terminal is cached and reachable by slug', async (t) => {
  const { server, client } = await startConnected(t);
  const changed = waitForEvent(client, 'clientsChanged');
  server.push('SetFullFreeKioskTerminalList', [kiosk]);
  await changed;

  assert.equal(client.getClient('lobby-tablet').UUID, 'kiosk:def');
  assert.equal(client.getClientStatus('lobby-tablet'), 'ONLINE');
});

test('every entity kind reaches getAllClients', async (t) => {
  // The single most consequential assertion here: a kind missing from this list
  // is invisible to tag status, group status and every summary count at once.
  const { server, client } = await startConnected(t);
  await seedAll(server, client);

  assert.deepEqual(
    client
      .getAllClients()
      .map((Entity) => Entity.Slug)
      .sort(),
    ['lobby-tablet', 'projector-sr', 'spare-slot']
  );
});

test('a full-list push for one kind leaves the other kinds alone', async (t) => {
  const { server, client } = await startConnected(t);
  await seedAll(server, client);

  // Replace the terminals with an empty list; monitors and dummies must survive.
  const changed = waitForEvent(client, 'clientsChanged');
  server.push('SetFullFreeKioskTerminalList', []);
  await changed;

  assert.equal(client.getClient('lobby-tablet'), undefined);
  assert.ok(client.getClient('projector-sr'));
  assert.ok(client.getClient('spare-slot'));
});

test('a single-entity update replaces just that entity', async (t) => {
  const { server, client } = await startConnected(t);
  await seedAll(server, client);

  const changed = waitForEvent(client, 'clientsChanged');
  server.push('FreeKioskTerminalUpdated', { ...kiosk, Online: false });
  await changed;

  assert.equal(client.getClientStatus('lobby-tablet'), 'OFFLINE');
  assert.equal(client.getClientStatus('projector-sr'), 'ONLINE');
});

test('getClientsByType filters without a bespoke getter per kind', async (t) => {
  const { server, client } = await startConnected(t);
  await seedAll(server, client);

  assert.deepEqual(
    client.getClientsByType('freekiosk').map((Entity) => Entity.Slug),
    ['lobby-tablet']
  );
  assert.deepEqual(client.getClientsByType('nonexistent'), []);
});

// --- Tag membership ----------------------------------------------------------

test('a tag naming a terminal by its bare uuid still covers it', async (t) => {
  // This is the bug. The scope picker writes a bare uuid for terminals and
  // dummies; the push carries `kiosk:`/`dummy:`. Matching only the pushed form
  // means the tag quietly reports without them.
  const { server, client } = await startConnected(t);
  await seedAll(server, client);

  const tagged = waitForEvent(client, 'tagsChanged');
  server.push('SetTagList', [
    // One member each, so a status change can only have come from that member.
    // Both bare, exactly as the server's scope picker records them.
    {
      TagID: 1,
      Slug: 'kiosks',
      Colour: 1,
      Icon: 'tablet',
      Scope: { Workspace: false, Groups: [], Clients: ['def'], Tags: [] },
    },
    {
      TagID: 2,
      Slug: 'spares',
      Colour: 1,
      Icon: 'box',
      Scope: { Workspace: false, Groups: [], Clients: ['abc'], Tags: [] },
    },
  ]);
  await tagged;

  // An uncovered tag has no members, and an empty scope aggregates to OFFLINE —
  // so ONLINE here is only reachable if the bare id actually matched.
  assert.equal(client.getTagStatus('kiosks'), 'ONLINE');
  assert.equal(client.getTagStatus('spares'), 'ONLINE', 'dummy clients had the same bug');

  // Flipping the terminal moves only its own tag, which pins that the match is
  // to that entity rather than to whatever else happened to be in scope.
  const offline = waitForEvent(client, 'clientsChanged');
  server.push('FreeKioskTerminalUpdated', { ...kiosk, Online: false });
  await offline;
  assert.equal(client.getTagStatus('kiosks'), 'OFFLINE');
  assert.equal(client.getTagStatus('spares'), 'ONLINE');
});

test('a tag naming a monitor by its prefixed id still covers it', async (t) => {
  // Monitors are recorded prefixed, so they must keep matching on the pushed
  // form — the fix for bare ids must not have moved the goalposts for these.
  const { server, client } = await startConnected(t);
  await seedAll(server, client);

  const tagged = waitForEvent(client, 'tagsChanged');
  server.push('SetTagList', [
    {
      TagID: 2,
      Slug: 'projectors',
      Colour: 1,
      Icon: 'projector',
      Scope: { Workspace: false, Groups: [], Clients: ['monitor:7'], Tags: [] },
    },
  ]);
  await tagged;

  assert.equal(client.getTagStatus('projectors'), 'ONLINE');
});

test('a de-prefixed id cannot make a monitor match a scope it is not in', async (t) => {
  // `monitor:7` must never also answer to `7`. Monitor ids are small integers,
  // so a loose de-prefix could collide with an unrelated scope entry — which is
  // why only the kinds whose scope ids are genuinely bare get de-prefixed.
  const { server, client } = await startConnected(t);
  await seedAll(server, client);

  const tagged = waitForEvent(client, 'tagsChanged');
  server.push('SetTagList', [
    {
      TagID: 3,
      Slug: 'stray',
      Colour: 1,
      Icon: 'question',
      Scope: { Workspace: false, Groups: [], Clients: ['7'], Tags: [] },
    },
  ]);
  await tagged;

  // No member matches, so the tag has nothing to aggregate.
  assert.equal(client.getTagStatus('stray'), 'OFFLINE');
});

test('a terminal counts toward a group-scoped tag like any other entity', async (t) => {
  const { server, client } = await startConnected(t);
  const changed = waitForEvent(client, 'clientsChanged');
  server.push('SetFullFreeKioskTerminalList', [{ ...kiosk, GroupID: 4, Degraded: true }]);
  await changed;

  const tagged = waitForEvent(client, 'tagsChanged');
  server.push('SetTagList', [
    {
      TagID: 4,
      Slug: 'lobby',
      Colour: 1,
      Icon: 'house',
      Scope: { Workspace: false, Groups: [4], Clients: [], Tags: [] },
    },
  ]);
  await tagged;

  assert.equal(client.getTagStatus('lobby'), 'DEGRADED');
});
