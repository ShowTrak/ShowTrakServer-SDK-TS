<div align="center">

<a href="https://showtrak.co.uk"><img src="https://showtrak.co.uk/images/logo.png" alt="ShowTrak Server SDK logo" width="128" height="128"></a>

# ShowTrak Server SDK

**Control ShowTrak Server from your own TypeScript and JavaScript apps.**

[Website](https://showtrak.co.uk) · [npm](https://www.npmjs.com/package/@showtrak/server-sdk) · [Discord](https://discord.gg/DACmwsbSGW)

[![Node.js 20+][badge-node]](https://www.npmjs.com/package/@showtrak/server-sdk) [![TypeScript][badge-typescript]](https://www.npmjs.com/package/@showtrak/server-sdk)

</div>

The official SDK for [ShowTrak Server](https://github.com/ShowTrak/ShowTrakServer)'s control API. It powers
the [Bitfocus Companion module](https://github.com/bitfocus/companion-module-showtrak-server) and
ShowTrak Remote, and lets you build your own dashboards, show-control bridges and automations.

## Key features

- **Live state**: clients, groups, monitors and alerts stay in sync through server pushes.
- **Every action**: run scripts, wake and identify machines, run monitor actions, switch Show and Edit mode and more.
- **Fully typed**: type definitions for every command, event and payload.
- **Works with older servers**: checks what the connected server supports, so one build talks to several server versions.

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
  port: 3000, // optional, defaults to 3000
  apiKey: 'xxxx', // required — the server refuses unauthenticated connections
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

| Event                     | Payload                       | Fires when                                |
| ------------------------- | ----------------------------- | ----------------------------------------- |
| `connect`                 | —                             | The session is established                |
| `disconnect`              | `reason`                      | The session drops                         |
| `error`                   | `message`                     | Auth or transport fails                   |
| `stateChanged`            | `state`                       | Connection state transitions              |
| `clientsChanged`          | —                             | Any client's state changes                |
| `tagsChanged`             | —                             | Tags are added/removed/edited             |
| `scriptsChanged`          | —                             | The script list changes                   |
| `modeChanged`             | `mode`                        | The server enters SHOW/EDIT               |
| `alertsChanged`           | `enabled`                     | Alerts are toggled                        |
| `scriptExecutionsChanged` | `executions`                  | A script or event starts, moves on, ends  |
| `pendingAdoptionChanged`  | `devices`                     | A device starts or stops waiting to adopt |
| `alert`                   | `alert`                       | An alert rule raises a ShowTrak alert     |
| `notify`                  | `message`, `type`, `duration` | The server raises a toast                 |

Paired devices also get `playSound`, `playCustomAudio`, `audioAssetsChanged`,
`favouritesChanged`, `alertRulesChanged`, `auditLogAppended`, `settingsChanged`,
`liveLevels`, `capabilitiesChanged` and `revoked`. From server 3.34 the sound,
favourite, rule, audit and settings pushes go to device sessions only.

`clientsChanged` fires once per client update, and a busy show sends several a
second. An integration that redraws everything on it (a button surface, a
variable table) should coalesce the bursts rather than redraw per event.

A throwing listener never blocks the others.

## Reading state

The client keeps local caches updated by server pushes, so reads are
synchronous and cheap.

Everything the server projects as a client appears in these caches and shares
one slug namespace: real clients, monitoring targets (`monitor:<id>`), dummy
clients (`dummy:<uuid>`) and FreeKiosk terminals (`kiosk:<uuid>`). They are
addressed by slug regardless of kind, and all of them feed `getAllClients()`,
which is what the group, tag and workspace aggregates read. `ClientView.Type`
tells them apart, and is deliberately an open union — a server newer than this
SDK may push a type it does not name.

```ts
client.getClient('stage-left'); // full ClientView, or undefined
client.getAllClients(); // every kind below, in one list
client.getClientsByType('freekiosk'); // just one kind
client.getClientStatus('stage-left'); // 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'IDLE'
client.getClientLabel('stage-left'); // nickname → hostname → slug → UUID
client.getClientStatusColour('stage-left'); // hex, for UI tiles
client.getClientStatusRgb('stage-left'); // [r, g, b], for hardware surfaces

client.getGroupStatus('front-of-house'); // rolled-up status
client.getTagStatus('projectors');
client.getAllStatus(); // whole workspace

client.getGroups();
client.getTags();
client.getScripts();
client.getScriptExecutions(); // the execution panel, in server order
client.getExecutionsForClient('stage-left');
client.getPendingAdoption(); // devices waiting to be adopted
client.getMode(); // 'SHOW' | 'EDIT'
client.getAlertsEnabled();
client.getState(); // 'disconnected' | 'connecting' | ...
client.isConnected();
```

## Commands

Every command returns `Promise<CommandResult>` (`{ ok, detail }`) once the
server acknowledges it.

| Area        | Methods                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| Wake-on-LAN | `wolAll`, `wolClient`, `wolGroup`, `wolTag`                                                                           |
| Scripts     | `runScriptOnAll`, `runScriptOnClient`, `runScriptOnGroup`, `runScriptOnTag`                                           |
| Events      | `triggerEventOnAll`, `triggerEventOnClient`, `triggerEventOnGroup`, `triggerEventOnTag`                               |
| Executions  | `retryFailedExecutions`, `clearSettledExecutions`                                                                     |
| Monitors    | `runActionOnMonitor`                                                                                                  |
| FreeKiosk   | `runFreeKioskCommandOnTerminal`, `runFreeKioskCommandOnGroup`, `runFreeKioskCommandOnTag`, `runFreeKioskCommandOnAll` |
| Dummies     | `sendDummyHeartbeat`                                                                                                  |
| Identify    | `identify`, `stopIdentify`                                                                                            |
| Alerts      | `alertsOn`, `alertsOff`, `alertsToggle`                                                                               |
| Mode        | `enterShowMode`, `enterEditMode`, `toggleMode`                                                                        |
| View        | `setView`, `enterExpandedView`, `enterCompactView`, `enterListView`, `toggleView`                                     |
| Modals      | `openClientModal`, `closeAllModals`                                                                                   |
| Show        | `saveShow`                                                                                                            |
| System      | `shutdownServer`, `forceShutdownServer`                                                                               |

Targeted variants take the slug first: `runScriptOnGroup(groupSlug, scriptSlug)`.

```ts
await client.runActionOnMonitor('proj-sl', 'pjlink', 'power.on');
await client.runActionOnMonitor('proj-sl', 'pjlink', 'input.set', '31'); // first parameter
await client.runFreeKioskCommandOnGroup('foyer', 'brightness', 40);
await client.setView('list'); // 'grid' | 'compact' | 'list'
```

Monitor actions, FreeKiosk commands and dummy heartbeats are the same verbs the
server's OSC API offers (`/API/Monitor/...`, `/API/FreeKiosk/...`,
`/API/Dummy/.../Heartbeat`). A monitor action's IDs are listed in the server's
OSC/API reference; `FREEKIOSK_COMMANDS` lists the FreeKiosk ones.

### Server versions

Commands are additive, so a server older than this SDK answers one it does not
know with `{ ok: false, detail: 'Unknown command "..."' }` instead of failing
the session. Server 3.34 added the view, monitor, FreeKiosk, dummy and
execution commands; earlier servers declared but ignored `view.*`.

## Live levels

A paired device can stream a monitor's live audio meters while it shows them.
Only check types that read meters stream any (the TASCAM MX-8A, with live levels
turned on in its check):

```ts
const off = client.on('liveLevels', (snapshot) => draw(snapshot.Checks));
const first = await client.openLiveLevels(targetId); // the current meters
// ...
client.closeLiveLevels();
off();
```

Levels are dBFS per channel, `null` for no signal. Close the stream when the
meters leave the screen: a held stream can keep the device's only control
connection busy. A reconnect ends it, so open it again on `connect`. API-key
sessions are refused, as for `rpc`.

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

`FREEKIOSK_COMMANDS` lists the FreeKiosk commands the server accepts, with the
value each takes (brightness and volume, 0–100), for building a picker without
the device-only `getFreeKioskCommands()`.

### Script executions

`IsRetryableExecution` says whether the server would retry an execution, and
`SummariseExecutions` counts a list the way the desktop's execution panel does:

```ts
import { SummariseExecutions } from '@showtrak/server-sdk';

const { Pending, Failed, Retryable } = SummariseExecutions(client.getScriptExecutions());
if (Retryable) await client.retryFailedExecutions();
```

Housekeeping (script deployment, Wake-on-LAN) is left out of the counts unless
`{ includeInternal: true }` is passed. Paired devices can read an execution's
console with `getExecutionOutput(requestId, afterSeq)`.

### Script targeting

The desktop only offers a script on clients that can run it: the script must be
enabled, support the client's OS and be admitted by its whitelist. The same rules
are exported so an integration offers what the desk would:

```ts
import {
  ResolveScriptTargets,
  GetScriptSkipReason,
  ScriptConfirmation,
} from '@showtrak/server-sdk';

const Tags = client.getTags();
for (const Script of client.getScripts()) {
  const Targets = ResolveScriptTargets(Script, Selected, Tags); // empty: don't offer it
  const Level = ScriptConfirmation(Script); // 'None' | 'Standard' | 'Critical'
}
```

`GetScriptSkipReason` says why one client is left out (`Unsupported`, `Disabled`
or `Offline`). These are a usability guard; the server re-checks the whitelist
on dispatch.

## Part of ShowTrak

| App                                                           | What it does                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **[ShowTrak Server](https://showtrak.co.uk/software/server)** | Monitor and control every computer and show device from one screen.         |
| **[ShowTrak Client](https://showtrak.co.uk/software/client)** | The lightweight app that lets ShowTrak Server watch and control a computer. |
| **[ShowTrak Timers](https://showtrak.co.uk/software/timers)** | Show timers run from the desk, a Stream Deck, QLab or any browser.          |
| **[ShowTrak Portal](https://showtrak.co.uk)**                 | Show reports, schedules and team collaboration for live productions.        |

Find everything at **[showtrak.co.uk](https://showtrak.co.uk)**.

## Support

Questions, ideas or problems? Join the [ShowTrak Discord](https://discord.gg/DACmwsbSGW) or [open an issue](https://github.com/ShowTrak/ShowTrakServer-SDK-TS/issues).

## Licence

The ShowTrak Server SDK is open source under the [MIT licence](LICENSE).

[badge-node]: https://img.shields.io/badge/Node.js%2020%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white
[badge-typescript]: https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white
