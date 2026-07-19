# ShowTrak Server SDK (TypeScript)

A standalone TypeScript SDK for controlling a **ShowTrak Server** instance in
real time over its WebSocket control API (the server's `/sdk` Socket.IO
namespace). It provides:

- **Shared constants** — default ports, the 8-colour palette, status colours —
  so every integration (Companion module, future apps) stays consistent.
- **A typed wire protocol** — command names, argument shapes, push channels.
- **`ShowTrakControlClient`** — connect, send slug-based commands, and read live
  status/label feedback from local caches kept in sync by server pushes.

## Install / usage

```ts
import { ShowTrakControlClient } from '@showtrak/server-sdk';

const client = new ShowTrakControlClient();
client.on('connect', () => console.log('connected'));
client.on('clientsChanged', () => {
  console.log(client.getClientStatus('stage-left')); // 'ONLINE' | 'DEGRADED' | ...
});
client.connect({ host: '192.168.1.50', port: 3000, apiKey: 'xxxx' });

await client.runScriptOnClient('stage-left', 'reboot');
await client.enterEditMode();
```

All targeting is by **slug**, never UUID — clients, groups, tags by slug and
scripts/events by their slug (script folder ID / integrated action ID).

## Deployment (copy into consumers)

The SDK is **not** consumed as a git submodule. Instead its build output
(`dist/`) is copied ("deployed") into each consuming project listed in
[`sdk.deploy.json`](./sdk.deploy.json). Consumers import the vendored folder
(e.g. `./showtrak-sdk/index.js`) and compile it with their own toolchain.

- `npm run deploy` — build once and copy `dist/` into every target.
- `npm run deploy:watch` — rebuild + redeploy automatically on every `src/`
  change (dev loop). Targets are **wiped and replaced** on each deploy.

## Keeping constants in sync

This SDK is standalone: the ShowTrak Server does **not** import it, so
`src/constants.ts` is a hand-maintained mirror of the server's authoritative
values. When these change on the server, update them here too:

| Constant       | Server source                         |
| -------------- | ------------------------------------- |
| Ports          | `src/Modules/Config/constants.ts`     |
| Colour palette | `src/Modules/ScriptManager/schema.ts` |
| Status colours | `src/UI/css/parts/01-base.css`        |

## Testing

```bash
npm test          # build, then run the whole suite
npm run test:watch
```

Tests use the built-in Node test runner (`node --test`) — no framework
dependency — matching the ShowTrak Server's own suite. `pretest` compiles
first, so tests exercise the **built** `dist/` output that consumers actually
import, not the TypeScript source.

| File                         | Covers                                                        |
| ---------------------------- | ------------------------------------------------------------- |
| `constants.test.js`          | Palette/port/status constants and their fallbacks             |
| `status-helpers.test.js`     | `DeriveClientStatus` / `ClientLabel` precedence rules         |
| `client-lifecycle.test.js`   | Handshake auth, state transitions, teardown, event delivery   |
| `client-cache.test.js`       | Client/monitor/dummy cache isolation, re-slugging, bad pushes |
| `client-aggregation.test.js` | Group / tag / workspace status rollup                         |
| `client-commands.test.js`    | Every command method's wire name + args, and ack handling     |

Connection-level tests run against a **real Socket.IO server** on an ephemeral
port ([`test/helpers/fake-server.js`](./test/helpers/fake-server.js)) that
mirrors the server's `/sdk` namespace contract — API-key middleware, the
`command` event's ack, and push emission. That means the transport path is
genuinely exercised rather than mocked away.

Two drift guards are worth knowing about:

- `client-commands.test.js` parses the `CommandArgs` interface out of
  `src/protocol.ts` at test time and asserts every declared command has a method
  exercised by the table. Adding a command to the protocol without an SDK method
  fails the suite instead of passing unnoticed.
- The `CommandName` union means a typo'd command name fails to **compile**, so
  `pretest` catches it before any test runs.
