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
