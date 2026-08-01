#!/usr/bin/env node
// End-to-end check of ShowTrak Remote pairing against a REAL running server.
//
// The unit suite runs against a fake namespace, which proves the SDK holds up
// its end of the contract but not that the server holds up the other. This
// exercises the actual handshake: pair, reconnect with the issued token, read
// live state, and confirm the management bridge is reachable.
//
// Usage:
//   node scripts/verify-pairing.mjs --host 192.168.1.50 [--port 3000] [--pin 1234]
//   node scripts/verify-pairing.mjs --host 127.0.0.1 --token <existing-token>
//
// Exits non-zero on the first failure so it is usable as a smoke check.

import { ShowTrakControlClient, RPC_CHANNELS } from '../dist/index.js';

function ParseArgs(argv) {
  const Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const Arg = argv[i];
    if (!Arg.startsWith('--')) continue;
    const Key = Arg.slice(2);
    const Next = argv[i + 1];
    Args[Key] = Next && !Next.startsWith('--') ? Next : true;
    if (Args[Key] !== true) i += 1;
  }
  return Args;
}

const Args = ParseArgs(process.argv.slice(2));
const Host = typeof Args.host === 'string' ? Args.host : '127.0.0.1';
const Port = Args.port ? Number(Args.port) : 3000;
const Pin = typeof Args.pin === 'string' ? Args.pin : undefined;
const ExistingToken = typeof Args.token === 'string' ? Args.token : undefined;

let Failures = 0;

function Step(label) {
  process.stdout.write(`  ${label} ... `);
}

function Pass(detail = '') {
  console.log(`ok${detail ? ` (${detail})` : ''}`);
}

function Fail(detail) {
  Failures += 1;
  console.log(`FAILED — ${detail}`);
}

function Wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log(`\nShowTrak Remote pairing check → ${Host}:${Port}\n`);

// --- 1. Pair -----------------------------------------------------------------

let DeviceToken = ExistingToken;

if (!DeviceToken) {
  Step('pairing');
  const Result = await ShowTrakControlClient.pair({
    host: Host,
    port: Port,
    pin: Pin,
    deviceName: 'Pairing Check',
    platform: 'ios',
  });
  if (!Result.ok) {
    Fail(`${Result.code} — ${Result.detail}`);
    console.log(
      '\nNothing else can run without a token. Common causes:\n' +
        '  invalid_pin       the workspace PIN is set and --pin was wrong or missing\n' +
        '  pairing_disabled  turn on "Allow ShowTrak Remote Pairing" in Settings\n' +
        '  unreachable       wrong host/port, or the server is not running\n'
    );
    process.exit(1);
  }
  DeviceToken = Result.deviceToken;
  Pass(`device ${Result.deviceId}`);
} else {
  console.log('  pairing ... skipped (--token supplied)');
}

// --- 2. Connect with the issued token ----------------------------------------

const client = new ShowTrakControlClient();

Step('connecting with the device token');
const Connected = await new Promise((resolve) => {
  const Timer = setTimeout(() => resolve({ ok: false, detail: 'timed out' }), 10_000);
  client.on('connect', () => {
    clearTimeout(Timer);
    resolve({ ok: true });
  });
  client.on('error', (message) => {
    clearTimeout(Timer);
    resolve({ ok: false, detail: message });
  });
  client.connect({ host: Host, port: Port, deviceToken: DeviceToken });
});

if (!Connected.ok) {
  Fail(Connected.detail);
  console.log('\nThe token was issued but refused on reconnect — that is the bug worth chasing.\n');
  process.exit(1);
}
Pass();

// --- 3. Live state -----------------------------------------------------------

// Pushes arrive right after connection; give them a moment to land.
await Wait(750);

Step('receiving live state');
const Clients = client.getAllClients();
Pass(`${Clients.length} entities, mode ${client.getMode()}`);

if (Clients.length) {
  const Sample = Clients[0];
  console.log(
    `      e.g. ${client.getClientLabel(Sample.Slug)} — ${client.getClientStatus(Sample.Slug)}`
  );
}

// --- 4. The management bridge ------------------------------------------------

Step('reaching the management bridge');
const Read = await client.rpc(RPC_CHANNELS.GetAllGroups, []);
if (Read.ok) Pass('reads allowed');
else Fail(`reads refused (${Read.code}) — a device session should always be able to read`);

Step('capability probe');
const Caps = await client.refreshCapabilities();
Pass(
  `edit=${Caps.editMode} clients=${Caps.clientManagement} groups=${Caps.groupManagement} ` +
    `monitoring=${Caps.monitoringManagement} alerts=${Caps.alertManagement}`
);
if (!Caps.editMode) {
  console.log(
    '      (server is in SHOW mode, so every management category reads false — expected)'
  );
}

// --- 5. Report ---------------------------------------------------------------

client.disconnect();

console.log(`\nDevice token: ${DeviceToken}`);
console.log('Re-run with --token to skip pairing, or revoke it in Settings > Paired Devices.\n');

if (Failures) {
  console.log(`${Failures} check(s) failed.\n`);
  process.exit(1);
}
console.log('All checks passed.\n');
process.exit(0);
