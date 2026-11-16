// Live levels: a monitor's audio meters, streamed to the device that opened
// them. A device opens and closes the stream; frames arrive as an event.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startConnected,
  startConnectedDevice,
  waitFor,
  waitForEvent,
} from './helpers/fake-server.js';

const Snapshot = {
  TargetID: 4,
  Checks: [
    {
      CheckID: 9,
      Name: 'MX-8A',
      State: 'live',
      Message: null,
      Channels: [{ ID: 'in:1', Group: 'Inputs', Label: 'Mic 1', Db: -18, View: true }],
    },
  ],
};

test("a device opens a monitor's meters and gets the current ones back", async (t) => {
  const { server, client } = await startConnectedDevice(t, { liveLevels: Snapshot });

  const Result = await client.openLiveLevels(4);

  assert.deepEqual(Result, { ok: true, result: Snapshot });
  assert.deepEqual(server.liveOpens, [4]);
});

test('frames arrive as liveLevels events', async (t) => {
  const { server, client } = await startConnectedDevice(t);
  await client.openLiveLevels(4);

  const Received = waitForEvent(client, 'liveLevels');
  server.push('MonitorLiveLevels:Frames', Snapshot);
  const [Frame] = await Received;

  assert.deepEqual(Frame, Snapshot);
});

test('closing tells the server to stop streaming', async (t) => {
  const { server, client } = await startConnectedDevice(t);
  await client.openLiveLevels(4);

  client.closeLiveLevels();

  await waitFor(() => server.liveCloses.length === 1, { label: 'close reached the server' });
});

test('an integration is refused without a round trip', async (t) => {
  const { server, client } = await startConnected(t);

  const Result = await client.openLiveLevels(4);

  assert.deepEqual(Result, { ok: false, code: 'forbidden' });
  assert.deepEqual(server.liveOpens, [], 'an API-key session reached the server');
});
