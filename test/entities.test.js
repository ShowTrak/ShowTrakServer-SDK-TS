// How an entity's pushed uuid maps to the id its rpc readers and audit log use,
// and how a history series is matched whichever id field its reader names.

import test from 'node:test';
import assert from 'node:assert/strict';

import { EntityAddress, SeriesId } from '../dist/index.js';

test('EntityAddress strips the projection prefix and names the audit entity type', () => {
  assert.deepEqual(EntityAddress('monitor:8'), { type: 'monitor', id: '8' });
  assert.deepEqual(EntityAddress('dummy:abc'), { type: 'dummy', id: 'abc' });
  assert.deepEqual(EntityAddress('kiosk:def'), { type: 'freekiosk', id: 'def' });
  assert.deepEqual(EntityAddress('5164-uuid'), { type: 'client', id: '5164-uuid' });
});

test('SeriesId reads whichever id a history reader carries', () => {
  assert.equal(SeriesId({ Name: 'n', samples: [], Serial: 'S1' }), 'S1');
  assert.equal(SeriesId({ Name: 'n', samples: [], MountPoint: '/' }), '/');
  assert.equal(SeriesId({ Name: 'n', samples: [], CheckKey: 'cpu' }), 'cpu');
  assert.equal(SeriesId({ Name: 'Fallback', samples: [] }), 'Fallback');
});
