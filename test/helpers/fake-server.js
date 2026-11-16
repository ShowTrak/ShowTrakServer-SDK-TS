// A stand-in for the ShowTrak Server's `/sdk` Socket.IO namespace.
//
// It is a *real* Socket.IO server on an ephemeral port, so tests exercise the
// SDK's actual transport path — handshake auth, the `command` event's ack
// callback, and server→client pushes — rather than a mocked-out socket.
//
// It deliberately mirrors only the contract the SDK depends on (see the server's
// src/Modules/Server/sdk-namespace.ts): API-key middleware, a `command` handler
// that acks {ok, detail}, and free-form push emission.

import { createServer } from 'node:http';
import { Server } from 'socket.io';

import { SDK_NAMESPACE, COMMAND_EVENT } from '../../dist/index.js';

/**
 * Start a fake control server.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] Key the handshake must present. Default 'test-key'.
 * @param {(name: string, args: unknown) => {ok: boolean, detail: string} | undefined} [options.onCommand]
 *   Command handler. Return the ack payload; return undefined to ack nothing
 *   (exercises the SDK's "No response" path).
 * @returns {Promise<FakeServer>}
 */
export async function startFakeServer(options = {}) {
  const apiKey = options.apiKey ?? 'test-key';
  const http = createServer();
  const io = new Server(http, { cors: { origin: '*' } });
  const namespace = io.of(SDK_NAMESPACE);

  const pin = options.pin ?? null;
  const deviceToken = options.deviceToken ?? 'device-token';
  const pairingCode = options.pairingCode ?? null;

  /** Every command the SDK sent, in order: {name, args}. */
  const commands = [];
  /** Every rpc the SDK sent, in order: {channel, args}. */
  const rpcCalls = [];
  /** Every pairing attempt's auth payload, in order. */
  const pairAttempts = [];
  /** Live-level opens (their target ids) and closes, in order. */
  const liveOpens = [];
  const liveCloses = [];
  /** Sockets currently connected to the namespace. */
  const sockets = new Set();

  // Mirrors the real namespace's fixed precedence: device token, then an
  // explicit pairing request, then the API key. A socket presenting more than
  // one must not be able to shop for the most permissive.
  namespace.use((socket, next) => {
    const auth = socket.handshake.auth || {};

    const presentedToken = String(auth.deviceToken || '');
    if (presentedToken) {
      if (presentedToken !== deviceToken) return next(new Error('Device revoked'));
      socket.data.authMode = 'device';
      return next();
    }

    if (auth.pair === true) {
      pairAttempts.push(auth);
      if (options.pairingDisabled) return next(new Error('Remote pairing is disabled'));
      if (pairingCode && auth.pairingCode) {
        if (auth.pairingCode !== pairingCode) {
          return next(new Error('Invalid or expired pairing code'));
        }
      } else if (pin && String(auth.pin || '') !== pin) {
        return next(new Error('Unauthorized'));
      }
      socket.data.authMode = 'device';
      socket.data.mintToken = true;
      return next();
    }

    const presented = String(auth.apiKey || '');
    if (presented !== apiKey) return next(new Error('Unauthorized'));
    socket.data.authMode = 'apikey';
    return next();
  });

  namespace.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('disconnect', () => sockets.delete(socket));

    if (socket.data.mintToken) {
      socket.emit('paired', { deviceId: 'device-1', deviceToken });
    }

    socket.on(COMMAND_EVENT, (name, args, ack) => {
      commands.push({ name, args });
      const result = options.onCommand ? options.onCommand(name, args) : { ok: true, detail: 'ok' };
      // A handler returning undefined acks with no payload on purpose.
      if (typeof ack === 'function') ack(result);
    });

    // Live levels: device sessions only, answered with options.liveLevels.
    socket.on('monitorlive:open', (targetId, ack) => {
      liveOpens.push(targetId);
      if (socket.data.authMode !== 'device') return ack && ack({ error: 'forbidden' });
      if (typeof ack === 'function') {
        ack({ result: options.liveLevels || { TargetID: targetId, Checks: [] } });
      }
    });
    socket.on('monitorlive:close', () => liveCloses.push(true));

    socket.on('rpc', (channel, args, ack) => {
      rpcCalls.push({ channel, args });
      // Device-token sessions only, exactly as the real namespace enforces.
      if (socket.data.authMode !== 'device') return ack && ack({ error: 'forbidden' });
      const result = options.onRpc ? options.onRpc(channel, args) : { result: [null, { channel }] };
      if (typeof ack === 'function') ack(result);
    });
  });

  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();

  return {
    port,
    host: '127.0.0.1',
    apiKey,
    commands,
    rpcCalls,
    pairAttempts,
    liveOpens,
    liveCloses,
    deviceToken,
    /** Push an event to every connected SDK socket. */
    push(event, ...args) {
      namespace.emit(event, ...args);
    },
    /** Number of sockets currently authed and connected. */
    connectionCount() {
      return sockets.size;
    },
    /** Forcibly drop all sockets — used to test disconnect handling. */
    dropAll() {
      for (const socket of sockets) socket.disconnect(true);
    },
    /** Revoke every device session, as the real server does on Revoke. */
    revokeAll() {
      for (const socket of sockets) {
        if (socket.data.authMode !== 'device') continue;
        socket.emit('revoked');
        socket.disconnect(true);
      }
    },
    async stop() {
      await io.close();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/**
 * Resolve once `predicate()` is true, polling each macrotask tick.
 *
 * Socket.IO delivery is asynchronous, so assertions about pushed state have to
 * wait for it rather than assuming it landed. Rejects on timeout so a broken
 * expectation fails loudly instead of hanging the test runner.
 */
export function waitFor(predicate, { timeout = 2000, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (error) {
        return reject(error);
      }
      if (ok) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Resolve on the next occurrence of an SDK event, or reject on timeout. */
export function waitForEvent(client, event, { timeout = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`Timed out waiting for "${event}" event`));
    }, timeout);
    const off = client.on(event, (...args) => {
      clearTimeout(timer);
      off();
      resolve(args);
    });
  });
}

/**
 * Start a server, connect an SDK client to it, and register teardown on `t`.
 *
 * Most tests care about post-connection behaviour, not the handshake, so this
 * collapses the setup to one line and guarantees both ends are torn down even
 * when an assertion throws.
 *
 * @param {import('node:test').TestContext} t
 * @param {Parameters<typeof startFakeServer>[0]} [options]
 * @returns {Promise<{server: FakeServer, client: import('../../dist/index.js').ShowTrakControlClient}>}
 */
export async function startConnected(t, options) {
  const { ShowTrakControlClient } = await import('../../dist/index.js');
  const server = await startFakeServer(options);
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });
  const connected = waitForEvent(client, 'connect');
  client.connect({ host: server.host, port: server.port, apiKey: server.apiKey });
  await connected;
  return { server, client };
}

/**
 * As startConnected, but authenticating as a PAIRED DEVICE rather than an
 * integration. The distinction is not cosmetic: only a device session may reach
 * the management bridge, so anything testing rpc has to start here.
 */
export async function startConnectedDevice(t, options) {
  const { ShowTrakControlClient } = await import('../../dist/index.js');
  const server = await startFakeServer(options);
  const client = new ShowTrakControlClient();
  t.after(async () => {
    client.disconnect();
    await server.stop();
  });
  const connected = waitForEvent(client, 'connect');
  client.connect({ host: server.host, port: server.port, deviceToken: server.deviceToken });
  await connected;
  return { server, client };
}

/**
 * Build a ClientView with sensible defaults — tests override only the fields
 * under test, keeping their intent legible.
 */
export function makeClient(overrides = {}) {
  return {
    Type: 'client',
    UUID: 'uuid-1',
    Slug: 'client-1',
    Nickname: null,
    Hostname: 'host-1',
    GroupID: null,
    Online: true,
    Degraded: false,
    Unassigned: false,
    ...overrides,
  };
}
