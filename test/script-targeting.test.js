// Script targeting must agree with the desktop's context menu: a script an
// integration offers on a machine is one the desk would offer there too.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GetScriptSkipReason,
  IsScriptTargetable,
  ResolveScriptTargets,
  ScopeCoversClient,
  ScriptConfirmation,
} from '../dist/index.js';
import { makeClient } from './helpers/fake-server.js';

const Script = (overrides = {}) => ({
  ID: 'restart',
  Name: 'Restart',
  CompatiblePlatforms: ['Windows', 'macOS'],
  isEnabled: true,
  Whitelist: null,
  ...overrides,
});

const Mac = makeClient({ UUID: 'mac', OperatingSystem: 'macOS', GroupID: 1 });
const Linux = makeClient({ UUID: 'linux', OperatingSystem: 'Linux', GroupID: 2 });

test('IsScriptTargetable: needs the client OS to be supported', () => {
  assert.equal(IsScriptTargetable(Script(), Mac), true);
  assert.equal(IsScriptTargetable(Script(), Linux), false);
  assert.equal(IsScriptTargetable(Script(), makeClient({ OperatingSystem: undefined })), false);
});

test('IsScriptTargetable: only an explicit isEnabled false hides a script', () => {
  assert.equal(IsScriptTargetable(Script({ isEnabled: false }), Mac), false);
  assert.equal(IsScriptTargetable(Script({ isEnabled: undefined }), Mac), true);
});

test('IsScriptTargetable: the whitelist admits by client, group or nested tag', () => {
  const Scope = (s) => Script({ Whitelist: { Workspace: false, Groups: [], Clients: [], ...s } });
  assert.equal(IsScriptTargetable(Scope({}), Mac), false);
  assert.equal(IsScriptTargetable(Scope({ Workspace: true }), Mac), true);
  assert.equal(IsScriptTargetable(Scope({ Clients: ['mac'] }), Mac), true);
  assert.equal(IsScriptTargetable(Scope({ Groups: [1] }), Mac), true);
  const Tags = [
    { TagID: 1, Slug: 'outer', Scope: { Workspace: false, Groups: [], Clients: [], Tags: [2] } },
    { TagID: 2, Slug: 'inner', Scope: { Workspace: false, Groups: [1], Clients: [] } },
  ];
  assert.equal(IsScriptTargetable(Scope({ Tags: [1] }), Mac, Tags), true);
  // Without the tag list a tag-based whitelist cannot be expanded.
  assert.equal(IsScriptTargetable(Scope({ Tags: [1] }), Mac), false);
});

test('ScopeCoversClient: a tag cycle terminates', () => {
  const Tags = [
    { TagID: 1, Slug: 'a', Scope: { Workspace: false, Groups: [], Clients: [], Tags: [2] } },
    { TagID: 2, Slug: 'b', Scope: { Workspace: false, Groups: [], Clients: [], Tags: [1] } },
  ];
  assert.equal(ScopeCoversClient(Tags[0].Scope, Mac, Tags), false);
});

test('ResolveScriptTargets: keeps only the admitted subset', () => {
  assert.deepEqual(
    ResolveScriptTargets(Script(), [Mac, Linux]).map((Client) => Client.UUID),
    ['mac']
  );
});

test('GetScriptSkipReason: OS, then whitelist, then offline', () => {
  const Restricted = Script({ Whitelist: { Workspace: false, Groups: [], Clients: [] } });
  assert.equal(GetScriptSkipReason(Script(), Linux), 'Unsupported');
  assert.equal(GetScriptSkipReason(Restricted, { ...Mac, Online: false }), 'Disabled');
  assert.equal(GetScriptSkipReason(Script(), { ...Mac, Online: false }), 'Offline');
  assert.equal(GetScriptSkipReason(Script(), Mac), null);
});

test('ScriptConfirmation: reads the level, falling back to the boolean', () => {
  assert.equal(
    ScriptConfirmation({ Confirmation: true, ConfirmationLevel: 'Critical' }),
    'Critical'
  );
  assert.equal(ScriptConfirmation({ Confirmation: true }), 'Standard');
  assert.equal(ScriptConfirmation({ Confirmation: false }), 'None');
  assert.equal(ScriptConfirmation({}), 'None');
});
