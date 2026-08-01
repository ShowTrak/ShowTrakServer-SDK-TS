// Pairing and the management bridge.
//
// Two credentials reach this server and they are NOT interchangeable. An API key
// identifies an integration and may only send commands; a device token
// identifies a paired phone and additionally reaches the management bridge.
// Most of what is worth testing here is that the distinction holds, and that
// every failure a pairing screen has to render arrives as something it can
// branch on rather than a message string.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ShowTrakControlClient,
  ClassifyPairError,
  ParseRetryAfterMs,
  RPC_CHANNELS,
} from '../dist/index.js';
import { startFakeServer, startConnectedDevice, waitForEvent } from './helpers/fake-server.js';

async function server(t, options) {
  const Server = await startFakeServer(options);
  t.after(async () => Server.stop());
  return Server;
}

// --- Pairing -----------------------------------------------------------------

test('pairing with the right PIN returns a device token', async (t) => {
  const Server = await server(t, { pin: '4321' });
  const Result = await ShowTrakControlClient.pair({
    host: Server.host,
    port: Server.port,
    pin: '4321',
    deviceName: "Tom's iPhone",
    platform: 'ios',
  });

  assert.equal(Result.ok, true);
  assert.equal(Result.deviceToken, Server.deviceToken);
  assert.equal(Server.pairAttempts[0].deviceName, "Tom's iPhone");
  assert.equal(Server.pairAttempts[0].platform, 'ios');
});

test('pairing with no PIN works when the workspace has none', async (t) => {
  const Server = await server(t, { pin: null });
  const Result = await ShowTrakControlClient.pair({ host: Server.host, port: Server.port });
  assert.equal(Result.ok, true);
});

test('a wrong PIN resolves to invalid_pin, not an exception', async (t) => {
  // A pairing screen wants a result to render. Making the caller wrap every
  // attempt in try/catch is how a keypad ends up with an unhandled rejection.
  const Server = await server(t, { pin: '4321' });
  const Result = await ShowTrakControlClient.pair({
    host: Server.host,
    port: Server.port,
    pin: '0000',
  });

  assert.equal(Result.ok, false);
  assert.equal(Result.code, 'invalid_pin');
});

test('a scanned pairing code stands in for the PIN', async (t) => {
  const Server = await server(t, { pin: '4321', pairingCode: 'scanned-code' });
  const Result = await ShowTrakControlClient.pair({
    host: Server.host,
    port: Server.port,
    pairingCode: 'scanned-code',
  });
  assert.equal(Result.ok, true);
});

test('a stale pairing code is reported as expired, not as a bad PIN', async (t) => {
  // Different remedy: refresh the QR at the desk, rather than retype a PIN.
  const Server = await server(t, { pin: '4321', pairingCode: 'fresh-code' });
  const Result = await ShowTrakControlClient.pair({
    host: Server.host,
    port: Server.port,
    pairingCode: 'stale-code',
  });

  assert.equal(Result.ok, false);
  assert.equal(Result.code, 'code_expired');
});

test('pairing against a disabled server says so', async (t) => {
  const Server = await server(t, { pairingDisabled: true });
  const Result = await ShowTrakControlClient.pair({ host: Server.host, port: Server.port });

  assert.equal(Result.ok, false);
  assert.equal(Result.code, 'pairing_disabled');
});

test('an unreachable host resolves rather than hanging the pairing screen', async () => {
  // Port 1 on localhost refuses immediately, so this exercises the failure path
  // without waiting out a timeout.
  const Result = await ShowTrakControlClient.pair({
    host: '127.0.0.1',
    port: 1,
    timeoutMs: 2000,
  });

  assert.equal(Result.ok, false);
  assert.equal(Result.code, 'unreachable');
});

test('pairing does not retry, so one fat-fingered PIN is not a lockout', async (t) => {
  // The server throttles wrong PINs hard — it has to, the keyspace is 10,000.
  // A socket that reconnects on failure would burn several attempts per tap.
  const Server = await server(t, { pin: '4321' });
  await ShowTrakControlClient.pair({ host: Server.host, port: Server.port, pin: '0000' });
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(Server.pairAttempts.length, 1, 'pairing retried behind the caller');
});

// --- Error classification ----------------------------------------------------

test('every server refusal maps to a code the app can branch on', () => {
  assert.equal(ClassifyPairError('Device revoked'), 'token_revoked');
  assert.equal(ClassifyPairError('Remote pairing is disabled'), 'pairing_disabled');
  assert.equal(ClassifyPairError('SDK API is disabled'), 'sdk_disabled');
  assert.equal(ClassifyPairError('SDK API key not configured'), 'sdk_disabled');
  assert.equal(ClassifyPairError('Invalid or expired pairing code'), 'code_expired');
  assert.equal(ClassifyPairError('Too many failed attempts. Try again in 42s'), 'rate_limited');
  assert.equal(ClassifyPairError('Unauthorized'), 'invalid_pin');
  for (const Transport of ['xhr poll error', 'websocket error', 'timeout', 'ECONNREFUSED']) {
    assert.equal(ClassifyPairError(Transport), 'unreachable', Transport);
  }
});

test('an unrecognised refusal falls back rather than guessing a remedy', () => {
  // Guessing here would send the operator to the wrong screen — worse than
  // admitting the failure is unknown.
  assert.equal(ClassifyPairError('something nobody predicted'), 'failed');
  assert.equal(ClassifyPairError(''), 'failed');
});

test('a lockout countdown is read from the message when present', () => {
  assert.equal(ParseRetryAfterMs('Too many failed attempts. Try again in 42s'), 42000);
  assert.equal(ParseRetryAfterMs('Unauthorized'), undefined);
});

// --- Device sessions vs API keys ---------------------------------------------

test('a device token connects and reaches the management bridge', async (t) => {
  const { server: Server, client } = await startConnectedDevice(t);
  const Result = await client.rpc(RPC_CHANNELS.GetClient, ['uuid-1']);

  assert.equal(Result.ok, true);
  assert.deepEqual(Server.rpcCalls[0], { channel: 'GetClient', args: ['uuid-1'] });
});

test('an API-key session is refused rpc without a round trip', async (t) => {
  // Short-circuited client-side as well as server-side: an integration should
  // not be able to spend a socket round trip discovering it has no management
  // rights, and the SDK already knows which credential it presented.
  const Server = await server(t);
  const client = new ShowTrakControlClient();
  t.after(() => client.disconnect());
  const connected = waitForEvent(client, 'connect');
  client.connect({ host: Server.host, port: Server.port, apiKey: Server.apiKey });
  await connected;

  const Result = await client.rpc(RPC_CHANNELS.GetClient, ['uuid-1']);
  assert.deepEqual(Result, { ok: false, code: 'forbidden' });
  assert.equal(Server.rpcCalls.length, 0, 'an API-key session hit the wire anyway');
});

test('rpc before connecting reports not_connected rather than throwing', async () => {
  const client = new ShowTrakControlClient();
  assert.deepEqual(await client.rpc(RPC_CHANNELS.GetClient, []), {
    ok: false,
    code: 'not_connected',
  });
});

test('an edit-mode refusal stays distinct from a permission refusal', async (t) => {
  // The two are fixable by different people: the operator can leave SHOW mode
  // themselves, but only someone at the desk can grant a permission.
  const { client } = await startConnectedDevice(t, {
    onRpc: () => ({ error: 'edit_mode_required' }),
  });
  const Result = await client.rpc(RPC_CHANNELS.CreateGroup, ['Front of House']);
  assert.deepEqual(Result, { ok: false, code: 'edit_mode_required' });
});

test('an unrecognised rpc error is normalised rather than leaked', async (t) => {
  const { client } = await startConnectedDevice(t, {
    onRpc: () => ({ error: 'something_new_from_a_newer_server' }),
  });
  const Result = await client.rpc(RPC_CHANNELS.CreateGroup, []);
  assert.deepEqual(Result, { ok: false, code: 'failed' });
});

test('typed management wrappers hit the right channels', async (t) => {
  const { server: Server, client } = await startConnectedDevice(t);

  await client.updateClient('uuid-1', { Nickname: 'FOH' });
  await client.createGroup('Front of House');
  await client.deleteGroup(3);
  await client.setAlertRuleEnabled(7, false);

  assert.deepEqual(
    Server.rpcCalls.map((Call) => Call.channel),
    ['UpdateClient', 'CreateGroup', 'DeleteGroup', 'SetAlertRuleEnabled']
  );
  assert.deepEqual(Server.rpcCalls[0].args, ['uuid-1', { Nickname: 'FOH' }]);
});

// --- Revocation --------------------------------------------------------------

test('a revoked device is told, rather than left reconnecting forever', async (t) => {
  // Without this the app retries a credential the server will never accept
  // again, so the operator sees an endless spinner instead of "pair again".
  const { server: Server, client } = await startConnectedDevice(t);
  const Revoked = waitForEvent(client, 'revoked');
  Server.revokeAll();
  await Revoked;
});

// --- Capabilities ------------------------------------------------------------

test('an API-key session reports no management capabilities', async (t) => {
  const Server = await server(t);
  const client = new ShowTrakControlClient();
  t.after(() => client.disconnect());
  const connected = waitForEvent(client, 'connect');
  client.connect({ host: Server.host, port: Server.port, apiKey: Server.apiKey });
  await connected;

  const Caps = client.getCapabilities();
  assert.equal(Caps.clientManagement, false);
  assert.equal(Caps.groupManagement, false);
  assert.equal(Caps.identify, false);
});

test('management capabilities require EDIT mode', async (t) => {
  const { server: Server, client } = await startConnectedDevice(t);

  Server.push('ModeUpdated', 'SHOW');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.getCapabilities().clientManagement, false, 'mutable in SHOW mode');

  Server.push('ModeUpdated', 'EDIT');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.getCapabilities().clientManagement, true);
});

test('a mode change re-emits capabilities so a UI can re-render', async (t) => {
  const { server: Server, client } = await startConnectedDevice(t);
  const Changed = waitForEvent(client, 'capabilitiesChanged');
  Server.push('ModeUpdated', 'EDIT');
  await Changed;
});

test('probing distinguishes a refused permission from a handler that simply failed', async (t) => {
  // The probe calls each category with an id that cannot exist. A handler error
  // proves the permission IS granted — it got far enough to fail. Only an
  // authorisation refusal means "not permitted", and conflating the two would
  // hide every control the moment the workspace was empty.
  const { server: Server, client } = await startConnectedDevice(t, {
    onRpc: (channel) => {
      if (channel === 'RenameGroup') return { error: 'forbidden' };
      return { result: ['No such client', null] };
    },
  });
  // Management capabilities are mode AND permission, so EDIT has to be on for
  // the permission half to be the thing under test.
  Server.push('ModeUpdated', 'EDIT');
  await new Promise((r) => setTimeout(r, 50));

  const Caps = await client.refreshCapabilities();
  assert.equal(Caps.groupManagement, false, 'a refusal was read as permission');
  assert.equal(Caps.clientManagement, true, 'a handler error was read as a refusal');
});
