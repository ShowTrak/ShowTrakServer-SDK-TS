// Devices waiting for adoption.
//
// The server pushes its whole pending list on every change (and once on
// connect), so a remote in Edit mode can offer Adopt and Identify for a machine
// that has just been plugged in. These tests pin the cache: replaced wholesale,
// reported on its event, and dropped when the session ends.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startConnected, waitFor, waitForEvent } from './helpers/fake-server.js';

function device(overrides = {}) {
  return {
    State: 'Pending',
    UUID: 'pending-1',
    Hostname: 'NEW-PC-01',
    Version: '3.28.2',
    IP: '10.0.4.50',
    Identifying: false,
    ...overrides,
  };
}

test('the pending list starts empty rather than undefined', async (t) => {
  const { client } = await startConnected(t);
  assert.deepEqual(client.getPendingAdoption(), []);
});

test('a push replaces the list and reports it on the event', async (t) => {
  const { server, client } = await startConnected(t);

  const changed = waitForEvent(client, 'pendingAdoptionChanged');
  server.push('SetDevicesPendingAdoption', [device(), device({ UUID: 'pending-2' })]);
  const [reported] = await changed;

  assert.equal(client.getPendingAdoption().length, 2);
  assert.deepEqual(reported, client.getPendingAdoption());
});

test('the list is replaced wholesale, not merged', async (t) => {
  // An adopted device leaves the list. Merging would keep offering to adopt it.
  const { server, client } = await startConnected(t);

  server.push('SetDevicesPendingAdoption', [device(), device({ UUID: 'pending-2' })]);
  await waitFor(() => client.getPendingAdoption().length === 2, { label: 'two devices' });

  server.push('SetDevicesPendingAdoption', [device({ UUID: 'pending-3', Identifying: true })]);
  await waitFor(() => client.getPendingAdoption().length === 1, { label: 'one device' });
  assert.equal(client.getPendingAdoption()[0].UUID, 'pending-3');
  assert.equal(client.getPendingAdoption()[0].Identifying, true);
});

test('a malformed push empties the list rather than throwing', async (t) => {
  const { server, client } = await startConnected(t);

  server.push('SetDevicesPendingAdoption', [device()]);
  await waitFor(() => client.getPendingAdoption().length === 1, { label: 'one device' });

  const changed = waitForEvent(client, 'pendingAdoptionChanged');
  server.push('SetDevicesPendingAdoption', null);
  await changed;
  assert.deepEqual(client.getPendingAdoption(), []);

  server.push('SetDevicesPendingAdoption', [null, { Hostname: 'no uuid' }, device()]);
  await waitFor(() => client.getPendingAdoption().length === 1, { label: 'entries filtered' });
});

test('disconnect drops the list', async (t) => {
  // A device listed as waiting may have been adopted, or left, while we were not
  // being told.
  const { server, client } = await startConnected(t);

  server.push('SetDevicesPendingAdoption', [device()]);
  await waitFor(() => client.getPendingAdoption().length === 1, { label: 'one device' });

  client.disconnect();

  assert.deepEqual(client.getPendingAdoption(), []);
});
