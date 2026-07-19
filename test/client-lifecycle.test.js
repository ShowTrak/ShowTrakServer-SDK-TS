// Connection lifecycle against a real Socket.IO server: handshake auth, state
// transitions, event delivery, and the teardown guarantees integrations rely on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ShowTrakControlClient } from '../dist/index.js';
import { makeClient, startFakeServer, waitFor, waitForEvent } from './helpers/fake-server.js';

test('connects with a valid API key and reports connected state', async (t) => {
  const server = await startFakeServer();
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });

  assert.equal(client.getState(), 'disconnected');
  assert.equal(client.isConnected(), false);

  const connected = waitForEvent(client, 'connect');
  client.connect({ host: server.host, port: server.port, apiKey: server.apiKey });
  assert.equal(client.getState(), 'connecting');

  await connected;
  assert.equal(client.getState(), 'connected');
  assert.equal(client.isConnected(), true);
  await waitFor(() => server.connectionCount() === 1, { label: 'server-side connection' });
});

test('a wrong API key surfaces an error state, not a connection', async (t) => {
  const server = await startFakeServer({ apiKey: 'correct-key' });
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });

  const errored = waitForEvent(client, 'error');
  client.connect({
    host: server.host,
    port: server.port,
    apiKey: 'wrong-key',
    reconnect: false,
  });

  const [message] = await errored;
  assert.match(message, /Unauthorized/);
  assert.equal(client.getState(), 'error');
  assert.equal(client.isConnected(), false);
  assert.equal(server.connectionCount(), 0);
});

test('stateChanged fires for each transition', async (t) => {
  const server = await startFakeServer();
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });

  const states = [];
  client.on('stateChanged', (state) => states.push(state));

  client.connect({ host: server.host, port: server.port, apiKey: server.apiKey });
  await waitForEvent(client, 'connect');
  client.disconnect();

  assert.deepEqual(states, ['connecting', 'connected', 'disconnected']);
});

test('a server-side drop emits disconnect and clears connected state', async (t) => {
  const server = await startFakeServer();
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });

  client.connect({
    host: server.host,
    port: server.port,
    apiKey: server.apiKey,
    reconnect: false,
  });
  await waitForEvent(client, 'connect');

  const dropped = waitForEvent(client, 'disconnect');
  server.dropAll();
  const [reason] = await dropped;

  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 0);
  assert.equal(client.isConnected(), false);
  assert.equal(client.getState(), 'disconnected');
});

test('disconnect() clears every cache so stale state never outlives the session', async (t) => {
  const server = await startFakeServer();
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });

  client.connect({ host: server.host, port: server.port, apiKey: server.apiKey });
  await waitForEvent(client, 'connect');

  server.push('SetFullClientList', [makeClient()], [{ GroupID: 1, Title: 'FOH', Slug: 'foh' }]);
  server.push('SetTagList', [{ TagID: 1, Slug: 'projectors' }]);
  server.push('SetScriptList', [{ ID: 'reboot', Name: 'Reboot' }]);
  await waitFor(() => client.getAllClients().length === 1, { label: 'client list' });
  await waitFor(() => client.getTags().length === 1, { label: 'tag list' });
  await waitFor(() => client.getScripts().length === 1, { label: 'script list' });

  client.disconnect();

  assert.deepEqual(client.getAllClients(), []);
  assert.deepEqual(client.getGroups(), []);
  assert.deepEqual(client.getTags(), []);
  assert.deepEqual(client.getScripts(), []);
  assert.equal(client.getClient('client-1'), undefined);
  assert.equal(client.getState(), 'disconnected');
});

test('connect() replaces an existing session rather than stacking sockets', async (t) => {
  const server = await startFakeServer();
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });

  client.connect({ host: server.host, port: server.port, apiKey: server.apiKey });
  await waitForEvent(client, 'connect');

  client.connect({ host: server.host, port: server.port, apiKey: server.apiKey });
  await waitForEvent(client, 'connect');

  await waitFor(() => server.connectionCount() === 1, {
    label: 'exactly one live server-side connection',
  });
});

test('on() returns an unsubscribe that stops delivery', async (t) => {
  const server = await startFakeServer();
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });

  client.connect({ host: server.host, port: server.port, apiKey: server.apiKey });
  await waitForEvent(client, 'connect');

  let calls = 0;
  const off = client.on('clientsChanged', () => {
    calls += 1;
  });

  server.push('ClientUpdated', makeClient());
  await waitFor(() => calls === 1, { label: 'first change' });

  off();
  server.push('ClientUpdated', makeClient({ Nickname: 'Renamed' }));
  await waitFor(() => client.getClientLabel('client-1') === 'Renamed', { label: 'second update' });
  assert.equal(calls, 1, 'unsubscribed listener should not have fired again');
});

test('a throwing listener does not block the others', async (t) => {
  const server = await startFakeServer();
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });

  client.connect({ host: server.host, port: server.port, apiKey: server.apiKey });
  await waitForEvent(client, 'connect');

  let reached = false;
  client.on('clientsChanged', () => {
    throw new Error('listener blew up');
  });
  client.on('clientsChanged', () => {
    reached = true;
  });

  server.push('ClientUpdated', makeClient());
  await waitFor(() => reached, { label: 'second listener despite a throwing first' });
});

test('Notify normalises its payload before handing it to listeners', async (t) => {
  const server = await startFakeServer();
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });

  client.connect({ host: server.host, port: server.port, apiKey: server.apiKey });
  await waitForEvent(client, 'connect');

  const received = waitForEvent(client, 'notify');
  server.push('Notify', 'Show saved');
  // Absent type/duration must not reach integrations as undefined.
  assert.deepEqual(await received, ['Show saved', 'info', 0]);
});
