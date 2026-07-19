# ShowTrak Server SDK

TypeScript SDK for controlling a [ShowTrak Server][showtrak] instance in real
time over its WebSocket control API.

Connect to a running server, send commands, and read live status that stays in
sync through server pushes — with full type definitions throughout.

[showtrak]: https://showtrak.co.uk

## Install

```bash
npm install @showtrak/server-sdk
```

Requires Node 20 or newer. Ships as ESM with bundled type definitions.

## Quick start

```ts
import { ShowTrakControlClient } from '@showtrak/server-sdk';

const client = new ShowTrakControlClient();

client.on('connect', () => console.log('connected'));
client.on('clientsChanged', () => {
  console.log(client.getClientStatus('stage-left')); // 'ONLINE' | 'DEGRADED' | ...
});

client.connect({ host: '192.168.1.50', apiKey: 'your-api-key' });

await client.runScriptOnClient('stage-left', 'reboot');
await client.enterShowMode();
```

Everything is targeted by **slug** — clients, groups and tags by their slug,
scripts and events by theirs. Slugs are stable, human-readable identifiers you
can hardcode in an integration; UUIDs are never part of this API.

## Connecting

```ts
client.connect({
  host: '192.168.1.50',
  port: 3000,      // optional, defaults to 3000
  apiKey: 'xxxx',  // required — the server refuses unauthenticated connections
  reconnect: true, // optional, defaults to true
});

client.disconnect();
```

`disconnect()` clears every cache, so stale state never outlives a session.
Calling `connect()` again replaces the existing session rather than stacking
connections.

## Events

Subscribe with `on()`, which returns an unsubscribe function.

```ts
const off = client.on('clientsChanged', () => refreshUI());
off(); // stop listening
```

| Event            | Payload                              | Fires when                     |
| ---------------- | ------------------------------------ | ------------------------------ |
| `connect`        | —                                    | The session is established     |
| `disconnect`     | `reason`                             | The session drops              |
| `error`          | `message`                            | Auth or transport fails        |
| `stateChanged`   | `state`                              | Connection state transitions   |
| `clientsChanged` | —                                    | Any client's state changes     |
| `tagsChanged`    | —                                    | Tags are added/removed/edited  |
| `scriptsChanged` | —                                    | The script list changes        |
| `modeChanged`    | `mode`                               | The server enters SHOW/EDIT    |
| `alertsChanged`  | `enabled`                            | Alerts are toggled             |
| `notify`         | `message`, `type`, `duration`        | The server raises a toast      |

A throwing listener never blocks the others.

## Reading state

The client keeps local caches updated by server pushes, so reads are
synchronous and cheap.

```ts
client.getClient('stage-left');           // full ClientView, or undefined
client.getAllClients();
client.getClientStatus('stage-left');     // 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'IDLE'
client.getClientLabel('stage-left');      // nickname → hostname → slug → UUID
client.getClientStatusColour('stage-left'); // hex, for UI tiles
client.getClientStatusRgb('stage-left');    // [r, g, b], for hardware surfaces

client.getGroupStatus('front-of-house');  // rolled-up status
client.getTagStatus('projectors');
client.getAllStatus();                    // whole workspace

client.getGroups();
client.getTags();
client.getScripts();
client.getMode();                         // 'SHOW' | 'EDIT'
client.getAlertsEnabled();
client.getState();                        // 'disconnected' | 'connecting' | ...
client.isConnected();
```

## Commands

Every command returns `Promise<CommandResult>` (`{ ok, detail }`) once the
server acknowledges it.

| Area        | Methods                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| Wake-on-LAN | `wolAll`, `wolClient`, `wolGroup`, `wolTag`                                               |
| Scripts     | `runScriptOnAll`, `runScriptOnClient`, `runScriptOnGroup`, `runScriptOnTag`               |
| Events      | `triggerEventOnAll`, `triggerEventOnClient`, `triggerEventOnGroup`, `triggerEventOnTag`   |
| Alerts      | `alertsOn`, `alertsOff`, `alertsToggle`                                                   |
| Mode        | `enterShowMode`, `enterEditMode`, `toggleMode`                                            |
| View        | `enterCompactView`, `enterExpandedView`, `toggleView`                                     |
| Modals      | `openClientModal`, `closeAllModals`                                                       |
| Show        | `saveShow`                                                                                |
| System      | `shutdownServer`, `forceShutdownServer`                                                   |

Targeted variants take the slug first: `runScriptOnGroup(groupSlug, scriptSlug)`.

## Helpers and constants

```ts
import {
  DEFAULT_SERVER_PORT,
  COLOUR_PALETTE,
  ScriptColourHex,
  StatusRgb,
  DeriveClientStatus,
  ClientLabel,
} from '@showtrak/server-sdk';
```

`COLOUR_PALETTE` is the 8-colour palette scripts and tags index into, and the
status helpers resolve the same colours the ShowTrak UI paints — so an
integration can match the server's appearance exactly.

## Licence

MIT © ShowTrak. See [LICENSE](./LICENSE).

Note that the ShowTrak Server application itself is licensed separately under
AGPL-3.0-only; this SDK is MIT so integrations can use it freely.
