// Every command method, checked against what actually goes on the wire.
//
// The command surface is ~30 thin one-liners delegating to command(name, args).
// A typo'd name or a mis-spelled arg key compiles fine and fails silently at
// runtime against a real server, so the mapping is pinned exhaustively here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startConnected } from './helpers/fake-server.js';

/** [method, call args, expected wire name, expected wire args] */
const COMMANDS = [
  // Wake-on-LAN
  ['wolAll', [], 'wol.all', {}],
  ['wolClient', ['foh'], 'wol.client', { slug: 'foh' }],
  ['wolGroup', ['stage'], 'wol.group', { slug: 'stage' }],
  ['wolTag', ['projectors'], 'wol.tag', { slug: 'projectors' }],

  // Scripts
  ['runScriptOnAll', ['reboot'], 'script.all', { scriptSlug: 'reboot' }],
  ['runScriptOnClient', ['foh', 'reboot'], 'script.client', { slug: 'foh', scriptSlug: 'reboot' }],
  [
    'runScriptOnGroup',
    ['stage', 'reboot'],
    'script.group',
    { slug: 'stage', scriptSlug: 'reboot' },
  ],
  [
    'runScriptOnTag',
    ['projectors', 'reboot'],
    'script.tag',
    { slug: 'projectors', scriptSlug: 'reboot' },
  ],

  // Integrated events
  ['triggerEventOnAll', ['go'], 'event.all', { eventSlug: 'go' }],
  ['triggerEventOnClient', ['foh', 'go'], 'event.client', { slug: 'foh', eventSlug: 'go' }],
  ['triggerEventOnGroup', ['stage', 'go'], 'event.group', { slug: 'stage', eventSlug: 'go' }],
  ['triggerEventOnTag', ['projectors', 'go'], 'event.tag', { slug: 'projectors', eventSlug: 'go' }],

  // Alerts
  ['alertsOn', [], 'alerts.set', { enabled: true }],
  ['alertsOff', [], 'alerts.set', { enabled: false }],
  ['alertsToggle', [], 'alerts.toggle', {}],

  // Show / Edit mode
  ['enterShowMode', [], 'mode.set', { mode: 'SHOW' }],
  ['enterEditMode', [], 'mode.set', { mode: 'EDIT' }],
  ['toggleMode', [], 'mode.toggle', {}],

  // Expanded / Compact view
  ['enterCompactView', [], 'view.set', { compact: true }],
  ['enterExpandedView', [], 'view.set', { compact: false }],
  ['toggleView', [], 'view.toggle', {}],

  // Modals
  ['openClientModal', ['foh'], 'modal.openClient', { slug: 'foh' }],
  ['closeAllModals', [], 'modal.closeAll', {}],

  // Misc
  ['saveShow', [], 'show.save', {}],

  // Shutdown
  ['shutdownServer', [], 'system.shutdown', {}],
  ['forceShutdownServer', [], 'system.shutdownForce', {}],
];

test('every command method sends the expected name and args', async (t) => {
  const { server, client } = await startConnected(t);

  for (const [method, args, expectedName, expectedArgs] of COMMANDS) {
    assert.equal(typeof client[method], 'function', `${method} should exist on the client`);
    const result = await client[method](...args);
    assert.deepEqual(result, { ok: true, detail: 'ok' }, `${method} should resolve the ack`);

    const sent = server.commands.at(-1);
    assert.equal(sent.name, expectedName, `${method} sent the wrong command name`);
    assert.deepEqual(sent.args, expectedArgs, `${method} sent the wrong args`);
  }

  assert.equal(server.commands.length, COMMANDS.length, 'each method sent exactly one command');
});

test('the command table covers the whole documented command surface', async (t) => {
  const { client } = await startConnected(t);
  const { CommandNames } = await import('./helpers/command-names.js');

  const covered = new Set(COMMANDS.map(([, , name]) => name));
  const missing = CommandNames.filter((name) => !covered.has(name));
  assert.deepEqual(missing, [], 'command names with no SDK method exercised above');

  // And nothing in the table is a name the protocol does not define.
  const known = new Set(CommandNames);
  const unknown = [...covered].filter((name) => !known.has(name));
  assert.deepEqual(unknown, [], 'table references command names the protocol does not declare');

  assert.ok(client);
});

test('commands issued before connecting fail fast instead of hanging', async () => {
  const { ShowTrakControlClient } = await import('../dist/index.js');
  const client = new ShowTrakControlClient();

  const result = await client.wolAll();
  assert.deepEqual(result, { ok: false, detail: 'Not connected' });
});

test('commands issued after disconnecting fail fast', async (t) => {
  const { client } = await startConnected(t);
  client.disconnect();

  const result = await client.wolAll();
  assert.deepEqual(result, { ok: false, detail: 'Not connected' });
});

test('a server ack with no payload resolves as a failure, not a hang', async (t) => {
  const { client } = await startConnected(t, { onCommand: () => undefined });

  const result = await client.saveShow();
  assert.deepEqual(result, { ok: false, detail: 'No response' });
});

test('a non-object ack resolves as a failure', async (t) => {
  const { client } = await startConnected(t, { onCommand: () => 'nope' });

  const result = await client.saveShow();
  assert.deepEqual(result, { ok: false, detail: 'No response' });
});

test('a server-reported failure is passed through verbatim', async (t) => {
  const { client } = await startConnected(t, {
    onCommand: () => ({ ok: false, detail: 'Unknown client "ghost"' }),
  });

  const result = await client.wolClient('ghost');
  assert.deepEqual(result, { ok: false, detail: 'Unknown client "ghost"' });
});
