// Cache maintenance: the SDK keeps clients, monitors and dummies in separate
// maps sharing one slug namespace, so a full-list replacement for one entity
// type must never disturb the others. These tests pin that isolation plus the
// re-slug cleanup, since a stale slug entry would silently misroute commands.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeClient, startConnected, waitFor, waitForEvent } from './helpers/fake-server.js';

const monitor = makeClient({
  Type: 'monitor',
  UUID: 'monitor:7',
  Slug: 'projector-sr',
  Hostname: null,
  Nickname: 'Projector SR',
});
const dummy = makeClient({
  Type: 'dummy',
  UUID: 'dummy:abc',
  Slug: 'spare-slot',
  Hostname: null,
  Nickname: 'Spare Slot',
});

test('SetFullClientList populates clients and groups', async (t) => {
  const { server, client } = await startConnected(t);

  const changed = waitForEvent(client, 'clientsChanged');
  server.push(
    'SetFullClientList',
    [makeClient({ UUID: 'a', Slug: 'foh' }), makeClient({ UUID: 'b', Slug: 'stage' })],
    [{ GroupID: 1, Title: 'Front of House', Slug: 'foh-group' }]
  );
  await changed;

  assert.equal(client.getAllClients().length, 2);
  assert.equal(client.getClient('foh').UUID, 'a');
  assert.deepEqual(
    client.getGroups().map((g) => g.Slug),
    ['foh-group']
  );
});

test('a full client-list replacement drops clients the server no longer sends', async (t) => {
  const { server, client } = await startConnected(t);

  server.push('SetFullClientList', [makeClient({ UUID: 'a', Slug: 'foh' })], []);
  await waitFor(() => client.getClient('foh'), { label: 'initial list' });

  server.push('SetFullClientList', [makeClient({ UUID: 'b', Slug: 'stage' })], []);
  await waitFor(() => client.getClient('stage'), { label: 'replacement list' });

  assert.equal(client.getClient('foh'), undefined, 'removed client should be gone');
  assert.equal(client.getAllClients().length, 1);
});

test('clients, monitors and dummies coexist and replace independently', async (t) => {
  const { server, client } = await startConnected(t);

  server.push('SetFullClientList', [makeClient({ UUID: 'a', Slug: 'foh' })], []);
  server.push('SetFullMonitoringTargetList', [monitor]);
  server.push('SetFullDummyClientList', [dummy]);
  await waitFor(() => client.getAllClients().length === 3, { label: 'all three entity types' });

  assert.equal(client.getClient('foh').Type, 'client');
  assert.equal(client.getClient('projector-sr').Type, 'monitor');
  assert.equal(client.getClient('spare-slot').Type, 'dummy');

  // Replacing the monitor list must leave clients and dummies untouched.
  server.push('SetFullMonitoringTargetList', []);
  await waitFor(() => client.getClient('projector-sr') === undefined, {
    label: 'monitors cleared',
  });
  assert.ok(client.getClient('foh'), 'real client survived a monitor replacement');
  assert.ok(client.getClient('spare-slot'), 'dummy survived a monitor replacement');
});

test('per-entity updates merge into the right map', async (t) => {
  const { server, client } = await startConnected(t);

  server.push('ClientUpdated', makeClient({ UUID: 'a', Slug: 'foh', Nickname: 'FOH' }));
  server.push('MonitoringTargetUpdated', { ...monitor, Online: false });
  server.push('DummyClientUpdated', { ...dummy, Nickname: 'Renamed Slot' });
  await waitFor(() => client.getAllClients().length === 3, { label: 'three entities' });

  assert.equal(client.getClientLabel('foh'), 'FOH');
  assert.equal(client.getClientStatus('projector-sr'), 'OFFLINE');
  assert.equal(client.getClientLabel('spare-slot'), 'Renamed Slot');
});

test('re-slugging a client drops the stale slug entry', async (t) => {
  const { server, client } = await startConnected(t);

  server.push('ClientUpdated', makeClient({ UUID: 'a', Slug: 'old-slug' }));
  await waitFor(() => client.getClient('old-slug'), { label: 'original slug' });

  server.push('ClientUpdated', makeClient({ UUID: 'a', Slug: 'new-slug' }));
  await waitFor(() => client.getClient('new-slug'), { label: 'new slug' });

  // A lingering old-slug entry would route commands to a name the server no
  // longer knows, so it must be actively removed.
  assert.equal(client.getClient('old-slug'), undefined);
  assert.equal(client.getAllClients().length, 1);
});

test('malformed pushes are ignored rather than poisoning the cache', async (t) => {
  const { server, client } = await startConnected(t);

  server.push('ClientUpdated', null);
  server.push('MonitoringTargetUpdated', { Type: 'monitor', UUID: 'm', Slug: null });
  server.push('DummyClientUpdated', null);
  server.push('SetFullClientList', null, null);
  server.push('SetTagList', null);
  server.push('SetScriptList', null);

  // Nothing above is indexable; a later good push must still land, which also
  // proves the socket survived the bad ones.
  server.push('ClientUpdated', makeClient({ UUID: 'a', Slug: 'foh' }));
  await waitFor(() => client.getClient('foh'), { label: 'good push after malformed ones' });
  assert.equal(client.getAllClients().length, 1);
  assert.deepEqual(client.getTags(), []);
  assert.deepEqual(client.getScripts(), []);
});

test('tags and scripts are cached and keyed correctly', async (t) => {
  const { server, client } = await startConnected(t);

  const tagsChanged = waitForEvent(client, 'tagsChanged');
  server.push('SetTagList', [
    { TagID: 1, Slug: 'projectors', Colour: 4 },
    { TagID: 2, Slug: null }, // no slug — unaddressable, must be skipped
  ]);
  await tagsChanged;

  const scriptsChanged = waitForEvent(client, 'scriptsChanged');
  server.push('SetScriptList', [
    { ID: 'reboot', Name: 'Reboot' },
    { ID: '', Name: 'Unusable' }, // no ID — must be skipped
  ]);
  await scriptsChanged;

  assert.deepEqual(
    client.getTags().map((tag) => tag.Slug),
    ['projectors']
  );
  assert.deepEqual(
    client.getScripts().map((script) => script.ID),
    ['reboot']
  );
});

test('mode and alert pushes update state and notify listeners', async (t) => {
  const { server, client } = await startConnected(t);

  assert.equal(client.getMode(), 'SHOW');
  assert.equal(client.getAlertsEnabled(), true);

  const modeChanged = waitForEvent(client, 'modeChanged');
  server.push('ModeUpdated', 'EDIT');
  assert.deepEqual(await modeChanged, ['EDIT']);
  assert.equal(client.getMode(), 'EDIT');

  // Anything that is not exactly 'EDIT' must normalise to SHOW.
  server.push('ModeUpdated', 'GARBAGE');
  await waitFor(() => client.getMode() === 'SHOW', { label: 'mode normalised to SHOW' });

  const alertsChanged = waitForEvent(client, 'alertsChanged');
  server.push('AlertActionsUpdated', 0); // truthiness-coerced on the wire
  assert.deepEqual(await alertsChanged, [false]);
  assert.equal(client.getAlertsEnabled(), false);
});

test('feedback getters return undefined for an unknown slug', async (t) => {
  const { client } = await startConnected(t);

  assert.equal(client.getClient('nope'), undefined);
  assert.equal(client.getClientStatus('nope'), undefined);
  assert.equal(client.getClientStatusColour('nope'), undefined);
  assert.equal(client.getClientStatusRgb('nope'), undefined);
  assert.equal(client.getClientLabel('nope'), undefined);
  assert.equal(client.getGroupStatus('nope'), undefined);
  assert.equal(client.getTagStatus('nope'), undefined);
});

test('status colour getters agree with the derived status', async (t) => {
  const { server, client } = await startConnected(t);

  server.push('ClientUpdated', makeClient({ Slug: 'foh', Online: true, Degraded: true }));
  await waitFor(() => client.getClientStatus('foh') === 'DEGRADED', { label: 'degraded client' });

  assert.match(client.getClientStatusColour('foh'), /^rgba\(/);
  const rgb = client.getClientStatusRgb('foh');
  assert.equal(rgb.length, 3);
});
