# Contributing

Maintainer notes for the ShowTrak Server SDK. Consumer-facing documentation
lives in [README.md](./README.md) — keep it that way, since npm publishes the
README as this package's public page.

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

## Releasing

The SDK is distributed through npm as `@showtrak/server-sdk`. There is no
vendoring or copy-deploy step — consumers install it like any other dependency.

Releases are automated: pushing a `v*` tag triggers
[`.github/workflows/publish.yml`](./.github/workflows/publish.yml), which tests
and publishes with build provenance.

```bash
npm version patch   # or minor / major — commits and tags
git push --follow-tags
```

The workflow refuses to publish if the tag disagrees with `package.json`, so a
mistagged release fails loudly instead of shipping under the wrong number.

Authentication uses npm **trusted publishing** (OIDC) — there is no `NPM_TOKEN`
secret. It is configured once on npmjs.com under the package's Trusted Publisher
settings, pointing at this repo and `publish.yml`.

### Publishing by hand

Only needed if Actions is unavailable. Publishing requires 2FA, and npm prints a
browser URL to confirm with a passkey — run it **interactively**, because the CLI
redacts that URL when its output is piped or captured, leaving nothing to click.

```bash
npm publish --access public
```

`prepublishOnly` builds and runs the suite either way, so a failing test blocks
a release.

When the public API changes, update the README's command and event tables to
match; they are hand-maintained and nothing fails if they drift.
