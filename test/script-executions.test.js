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

// --- Per-client lookups and counts ---------------------------------------------

test('getExecutionsForClient picks one client out of the panel by slug', async (t) => {
  const { server, client } = await startConnected(t);
  server.push(
    'SetFullClientList',
    [
      { Type: 'client', UUID: 'a', Slug: 'foh', Online: true },
      { Type: 'client', UUID: 'b', Slug: 'mon', Online: true },
    ],
    []
  );
  server.push('UpdateScriptExecutions', [
    execution({ RequestID: 'r-1' }),
    execution({ RequestID: 'r-2', Client: { UUID: 'b', Nickname: null, Hostname: null } }),
    execution({ RequestID: 'r-3', Status: 'Failed' }),
  ]);
  await waitFor(() => client.getScriptExecutions().length === 3 && client.getClient('foh'), {
    label: 'executions and clients',
  });

  assert.deepEqual(
    client.getExecutionsForClient('foh').map((E) => E.RequestID),
    ['r-1', 'r-3']
  );
  assert.deepEqual(client.getExecutionsForClient('nope'), []);
});

test('IsRetryableExecution mirrors the server: failed scripts and integrated events only', async () => {
  const { IsRetryableExecution } = await import('../dist/index.js');
  assert.equal(IsRetryableExecution(execution({ Status: 'Failed' })), true);
  assert.equal(IsRetryableExecution(execution({ Status: 'Completed' })), false);
  assert.equal(IsRetryableExecution(execution({ Status: 'Pending' })), false);
  // A deployment is internal and retries itself.
  assert.equal(
    IsRetryableExecution(
      execution({ Status: 'Failed', Internal: true, Script: { ID: 'x', Name: 'Deploy Scripts' } })
    ),
    false
  );
  assert.equal(
    IsRetryableExecution(
      execution({
        Status: 'Failed',
        Internal: true,
        Script: { ID: 'x', Name: 'Integrated Event: go' },
      })
    ),
    true
  );
  assert.equal(
    IsRetryableExecution(execution({ Status: 'Failed', Client: { UUID: null } })),
    false
  );
  assert.equal(IsRetryableExecution(null), false);
});

test('SummariseExecutions counts what an operator asked for', async () => {
  const { SummariseExecutions } = await import('../dist/index.js');
  const List = [
    execution({ RequestID: '1', Status: 'Pending' }),
    execution({ RequestID: '2', Status: 'Completed' }),
    execution({ RequestID: '3', Status: 'Failed' }),
    execution({
      RequestID: '4',
      Status: 'Failed',
      Internal: true,
      Script: { ID: 'x', Name: 'Integrated Event: go' },
    }),
    // Housekeeping: left out unless asked for.
    execution({
      RequestID: '5',
      Status: 'Failed',
      Internal: true,
      Script: { ID: 'deploy', Name: 'Deploy Scripts' },
    }),
  ];
  assert.deepEqual(SummariseExecutions(List), {
    Pending: 1,
    Completed: 1,
    Failed: 2,
    Retryable: 2,
    Total: 4,
  });
  assert.deepEqual(SummariseExecutions(List, { includeInternal: true }), {
    Pending: 1,
    Completed: 1,
    Failed: 3,
    Retryable: 2,
    Total: 5,
  });
  assert.deepEqual(SummariseExecutions([]), {
    Pending: 0,
    Completed: 0,
    Failed: 0,
    Retryable: 0,
    Total: 0,
  });
});

// --- The execution panel over the management bridge (paired devices) -----------

test('retryExecutions and getExecutionOutput reach their server channels', async (t) => {
  const { startConnectedDevice } = await import('./helpers/fake-server.js');
  const { server, client } = await startConnectedDevice(t, {
    onRpc: (channel) =>
      channel === 'Scripts:GetExecutionOutput'
        ? { result: [null, { RequestID: 'r-1', Status: 'Pending', Entries: [], LastSeq: 4 }] }
        : { result: [null, { Retried: 2 }] },
  });

  const Retry = await client.retryExecutions(['r-1', 'r-2']);
  assert.deepEqual(Retry, { ok: true, result: [null, { Retried: 2 }] });
  const Output = await client.getExecutionOutput('r-1', 3);
  assert.equal(Output.ok, true);
  assert.equal(Output.result[1].LastSeq, 4);

  assert.deepEqual(server.rpcCalls, [
    { channel: 'Scripts:RetryExecutions', args: [['r-1', 'r-2']] },
    { channel: 'Scripts:GetExecutionOutput', args: ['r-1', 3] },
  ]);
});
