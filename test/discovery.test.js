// Parsing an mDNS service record into something the app can act on.
//
// The SDK owns this rather than each host's discovery code, because the rules
// are easy to get subtly wrong in ways that only show up on a venue network:
// which address to prefer, what an absent flag means, and when a record should
// be dropped rather than shown as a half-usable row.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ParseServiceTxt, SERVICE_TYPE, SERVICE_SUBTYPE } from '../dist/index.js';

// `txt` merges rather than replaces, so a test can override one flag without
// restating the whole record.
function record(overrides = {}) {
  return {
    name: 'STAGE-PC - ShowTrak Server V3',
    host: 'stage-pc.local',
    port: 3000,
    addresses: ['192.168.1.50'],
    ...overrides,
    txt: {
      ServerIdentity: 'identity-token',
      Version: '3.18.0',
      Name: 'STAGE-PC',
      SdkEnabled: '1',
      Pairing: '1',
      PinRequired: '1',
      ...(overrides.txt || {}),
    },
  };
}

test('the service constants match what the server publishes', () => {
  // Hardcoding these in each host's browser is how two discovery
  // implementations end up looking for slightly different services.
  assert.equal(SERVICE_TYPE, 'showtrak');
  assert.equal(SERVICE_SUBTYPE, 'showtrakv3server');
});

test('a complete record parses into every field', () => {
  const Server = ParseServiceTxt(record());
  assert.deepEqual(Server, {
    identity: 'identity-token',
    name: 'STAGE-PC',
    host: '192.168.1.50',
    port: 3000,
    version: '3.18.0',
    pinRequired: true,
    sdkEnabled: true,
    pairingEnabled: true,
  });
});

test('a numeric address is preferred over the .local hostname', () => {
  // mDNS name resolution is an extra failure point on exactly the networks where
  // discovery is already marginal — and the address is right there in the record.
  const Server = ParseServiceTxt(record({ addresses: ['fe80::1', '10.0.0.5'] }));
  assert.equal(Server.host, '10.0.0.5');
});

test('the hostname is used when no IPv4 address was advertised', () => {
  const Server = ParseServiceTxt(record({ addresses: [] }));
  assert.equal(Server.host, 'stage-pc.local');
});

test('a record with no identity is dropped, not partially accepted', () => {
  // Without an identity there is no stable key: the entry could not be
  // remembered between sessions, matched to a stored device token, or told apart
  // from the same server on a new address. A row that cannot be acted on is
  // worse than no row.
  assert.equal(ParseServiceTxt(record({ txt: { ServerIdentity: '' } })), null);
});

test('a record with no host or no port is dropped', () => {
  assert.equal(ParseServiceTxt(record({ addresses: [], host: '' })), null);
  assert.equal(ParseServiceTxt(record({ port: 0 })), null);
  assert.equal(ParseServiceTxt(record({ port: undefined })), null);
});

test('null and undefined records are handled', () => {
  assert.equal(ParseServiceTxt(null), null);
  assert.equal(ParseServiceTxt(undefined), null);
});

test('an older server publishing no flags is treated as usable', () => {
  // Defaulting these to false would grey out every server running a build older
  // than the one that added the keys — i.e. punish the user for the server being
  // behind, on the one screen where they most need to see it.
  const Server = ParseServiceTxt({
    name: 'OLD-PC - ShowTrak Server V3',
    host: '10.0.0.9',
    port: 3000,
    addresses: [],
    txt: { ServerIdentity: 'old-identity' },
  });
  assert.equal(Server.sdkEnabled, true);
  assert.equal(Server.pairingEnabled, true);
  // A PIN, though, defaults to NOT required: prompting for one the server will
  // not check is worse than discovering it needs one at the handshake.
  assert.equal(Server.pinRequired, false);
  assert.equal(Server.version, '');
});

test('flags accept every spelling an mDNS library might hand back', () => {
  for (const Truthy of ['1', 'true', 'TRUE', 'yes']) {
    assert.equal(ParseServiceTxt(record({ txt: { PinRequired: Truthy } })).pinRequired, true);
  }
  for (const Falsy of ['0', 'false', 'FALSE', 'no']) {
    assert.equal(ParseServiceTxt(record({ txt: { PinRequired: Falsy } })).pinRequired, false);
  }
});

test('an unrecognised flag value falls back rather than guessing', () => {
  const Server = ParseServiceTxt(record({ txt: { SdkEnabled: 'maybe' } }));
  assert.equal(Server.sdkEnabled, true);
});

test('the service-name suffix is stripped when no friendly name was published', () => {
  const Server = ParseServiceTxt(record({ txt: { Name: '' } }));
  assert.equal(Server.name, 'STAGE-PC');
});

test('the host is the last-resort name', () => {
  const Server = ParseServiceTxt(record({ name: '', txt: { Name: '' } }));
  assert.equal(Server.name, '192.168.1.50');
});
