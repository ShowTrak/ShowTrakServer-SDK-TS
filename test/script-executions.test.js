// Live script executions.
//
// The server re-broadcasts its WHOLE execution list on every change, which is
// the property that lets a device joining mid-run see work already in flight.
// These tests pin that, plus the two things about the server's model that are
// easy to get wrong from the outside: order carries meaning, and a queued
// execution is indistinguishable from a running one by status alone.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeClient, startConnected, waitFor, waitForEvent } from './helpers/fake-server.js';

function execution(overrides = {}) {
  return {
    Internal: false,
    RequestID: 'req-1',
    Status: 'Pending',
    Progress: 0,
    StatusText: 'Queued',
    Timer: { Start: 1_800_000_000_000, End: null, Duration: null },
    Client: { UUID: 'a', Nickname: 'FOH Playback', Hostname: 'FOH-PC-01' },
    Script: { ID: 'reboot', Name: 'Reboot' },
    Error: null,
    ...overrides,
  };
}

test('the execution list starts empty rather than undefined', async (t) => {
  const { client } = await startConnected(t);
  assert.deepEqual(client.getScriptExecutions(), []);
});

test('a push replaces the list and reports it on the event', async (t) => {
  const { server, client } = await startConnected(t);

  const changed = waitForEvent(client, 'scriptExecutionsChanged');
  server.push('UpdateScriptExecutions', [execution(), execution({ RequestID: 'req-2' })]);
  const [reported] = await changed;

  assert.equal(client.getScriptExecutions().length, 2);
  // The event carries the list, so a subscriber never has to go and ask for it.
  assert.deepEqual(reported, client.getScriptExecutions());
});

test('the list is replaced wholesale, not merged', async (t) => {
  // The server owns the list and sends all of it every time. Merging would keep
  // an execution alive after the server had dropped it — a script shown as
  // running that finished minutes ago.
  const { server, client } = await startConnected(t);

  server.push('UpdateScriptExecutions', [execution(), execution({ RequestID: 'req-2' })]);
  await waitFor(() => client.getScriptExecutions().length === 2, { label: 'two executions' });

  server.push('UpdateScriptExecutions', [execution({ RequestID: 'req-3' })]);
  await waitFor(() => client.getScriptExecutions().length === 1, { label: 'one execution' });
  assert.equal(client.getScriptExecutions()[0].RequestID, 'req-3');
});

test('server order is preserved', async (t) => {
  // The manager appends, so the order shows each client working down its own
  // queue. Re-keying by RequestID would throw that away.
  const { server, client } = await startConnected(t);

  server.push('UpdateScriptExecutions', [
    execution({ RequestID: 'first' }),
    execution({ RequestID: 'second' }),
    execution({ RequestID: 'third' }),
  ]);
  await waitFor(() => client.getScriptExecutions().length === 3, { label: 'three executions' });

  assert.deepEqual(
    client.getScriptExecutions().map((entry) => entry.RequestID),
    ['first', 'second', 'third']
  );
});

test('settled executions stay in the list', async (t) => {
  // The server keeps a finished execution so an operator can see what a run
  // did. A consumer wanting only live work filters on Status.
  const { server, client } = await startConnected(t);

  server.push('UpdateScriptExecutions', [
    execution({ RequestID: 'done', Status: 'Completed', Progress: 100 }),
    execution({ RequestID: 'bad', Status: 'Failed', Error: 'Exit code 1' }),
    execution({ RequestID: 'live' }),
  ]);
  await waitFor(() => client.getScriptExecutions().length === 3, { label: 'three executions' });

  const live = client.getScriptExecutions().filter((entry) => entry.Status === 'Pending');
  assert.deepEqual(
    live.map((entry) => entry.RequestID),
    ['live']
  );
  assert.equal(client.getScriptExecutions()[1].Error, 'Exit code 1');
});

test('queued and running both arrive as Pending, distinguished only by StatusText', async (t) => {
  // This is the server's model, and reading running-ness off the status would
  // report a client's whole backlog as already executing.
  const { server, client } = await startConnected(t);

  server.push('UpdateScriptExecutions', [
    execution({ RequestID: 'waiting', StatusText: 'Queued' }),
    execution({ RequestID: 'going', StatusText: 'Running', Progress: 40 }),
  ]);
  await waitFor(() => client.getScriptExecutions().length === 2, { label: 'two executions' });

  assert.ok(client.getScriptExecutions().every((entry) => entry.Status === 'Pending'));
});

test('a malformed payload empties the list rather than throwing', async (t) => {
  const { server, client } = await startConnected(t);

  server.push('UpdateScriptExecutions', [execution()]);
  await waitFor(() => client.getScriptExecutions().length === 1, { label: 'one execution' });

  server.push('UpdateScriptExecutions', null);
  await waitFor(() => client.getScriptExecutions().length === 0, { label: 'cleared' });
});

test('disconnect drops the list, so nothing reads as running after the session ends', async (t) => {
  // An execution list is a claim about what is happening right now. Carrying it
  // across a disconnect would show a script as still running long after we
  // stopped being told anything about it.
  const { server, client } = await startConnected(t);

  server.push('SetFullClientList', [makeClient()], []);
  server.push('UpdateScriptExecutions', [execution()]);
  await waitFor(() => client.getScriptExecutions().length === 1, { label: 'one execution' });

  client.disconnect();

  assert.deepEqual(client.getScriptExecutions(), []);
});
