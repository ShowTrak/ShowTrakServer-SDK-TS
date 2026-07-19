// Constants are a hand-maintained MIRROR of the server's authoritative values
// (see the note atop src/constants.ts). These tests pin the shape and the
// lookup behaviour so an accidental edit during a sync is caught, and so the
// fallbacks stay defined for out-of-range input coming off the wire.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_STATUSES,
  COLOUR_PALETTE,
  COMMAND_EVENT,
  DEFAULT_COLOUR_INDEX,
  DEFAULT_SERVER_PORT,
  OSC_PORT,
  SDK_NAMESPACE,
  STATUS_COLOURS,
  STATUS_RGB,
  ScriptColourHex,
  StatusColour,
  StatusRgb,
} from '../dist/index.js';

test('wire constants match the server contract', () => {
  assert.equal(DEFAULT_SERVER_PORT, 3000);
  assert.equal(OSC_PORT, 3333);
  assert.equal(SDK_NAMESPACE, '/sdk');
  assert.equal(COMMAND_EVENT, 'command');
});

test('colour palette is the 8 densely-indexed entries scripts index into', () => {
  assert.equal(COLOUR_PALETTE.length, 8);
  COLOUR_PALETTE.forEach((colour, position) => {
    assert.equal(colour.index, position, `palette entry ${position} is out of order`);
    assert.match(colour.hex, /^#[0-9a-f]{6}$/i);
    assert.ok(colour.name.length > 0);
  });
  assert.ok(DEFAULT_COLOUR_INDEX >= 0 && DEFAULT_COLOUR_INDEX < COLOUR_PALETTE.length);
});

test('ScriptColourHex resolves valid indices', () => {
  for (const colour of COLOUR_PALETTE) {
    assert.equal(ScriptColourHex(colour.index), colour.hex);
  }
  // Numeric strings arrive from OSC/JSON payloads and must still resolve.
  assert.equal(ScriptColourHex('3'), COLOUR_PALETTE[3].hex);
});

test('ScriptColourHex falls back to light grey for unusable input', () => {
  const fallback = COLOUR_PALETTE[6].hex;
  // null / '' / false must NOT coerce to index 0 — an unset colour has to read
  // as grey, not red, and has to agree with the server's SCRIPT_COLOURS lookup.
  for (const bad of [-1, 8, 99, 1.5, null, undefined, {}, [], '', '   ', false, 'nope', NaN]) {
    assert.equal(ScriptColourHex(bad), fallback, `expected fallback for ${JSON.stringify(bad)}`);
  }
});

test('every status has a tile colour and a solid rgb', () => {
  assert.deepEqual([...CLIENT_STATUSES], ['ONLINE', 'DEGRADED', 'IDLE', 'OFFLINE']);
  for (const status of CLIENT_STATUSES) {
    assert.match(STATUS_COLOURS[status], /^rgba\(/, `${status} tile colour`);
    const rgb = STATUS_RGB[status];
    assert.equal(rgb.length, 3);
    for (const channel of rgb) {
      assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255);
    }
    assert.equal(StatusColour(status), STATUS_COLOURS[status]);
    assert.deepEqual(StatusRgb(status), STATUS_RGB[status]);
  }
});

test('status lookups fall back to OFFLINE for an unknown status', () => {
  // Older/newer servers may send a status this build does not know.
  assert.equal(StatusColour('BOGUS'), STATUS_COLOURS.OFFLINE);
  assert.deepEqual(StatusRgb('BOGUS'), STATUS_RGB.OFFLINE);
});
