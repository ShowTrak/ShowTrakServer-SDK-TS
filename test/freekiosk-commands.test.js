// The FreeKiosk command catalog integrations build their pickers from.

import test from 'node:test';
import assert from 'node:assert/strict';

const { FREEKIOSK_COMMANDS, GetFreeKioskCommandInfo } = await import('../dist/index.js');

test('every command has a unique ID, a label and a group', () => {
  const Ids = FREEKIOSK_COMMANDS.map((C) => C.ID);
  assert.equal(new Set(Ids).size, Ids.length);
  for (const Command of FREEKIOSK_COMMANDS) {
    assert.ok(Command.Label, Command.ID);
    assert.ok(['Power', 'Display', 'Content', 'Audio', 'Maintenance'].includes(Command.Group));
  }
});

test('only the two level commands take a value, 0-100', () => {
  const WithValue = FREEKIOSK_COMMANDS.filter((C) => C.Value).map((C) => C.ID);
  assert.deepEqual(WithValue.sort(), ['brightness', 'volume']);
  assert.deepEqual(GetFreeKioskCommandInfo('volume').Value, {
    Label: 'Level',
    Min: 0,
    Max: 100,
    Default: 50,
  });
});

test('the device JavaScript endpoint is never offered', () => {
  assert.equal(GetFreeKioskCommandInfo('js'), undefined);
  assert.equal(GetFreeKioskCommandInfo('api/js'), undefined);
});

test('the catalog cannot be mutated by a consumer', () => {
  assert.throws(() => FREEKIOSK_COMMANDS.push({ ID: 'js' }));
});
