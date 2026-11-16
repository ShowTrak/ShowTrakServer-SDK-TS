// The pushes behind the Web UI's alerts tray, sounds and editors: each reaches
// the client as an event, and the lists are cached so a screen can read them
// without waiting for the next change.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startConnectedDevice, waitForEvent } from './helpers/fake-server.js';

test('a ShowTrak alert and its sounds arrive as events', async (t) => {
  const { server, client } = await startConnectedDevice(t);

  const Alert = waitForEvent(client, 'alert');
  server.push('CreateShowTrakAlert', { Title: 'FOH down', Message: 'Offline', Severity: 'error' });
  assert.equal((await Alert)[0].Title, 'FOH down');

  const Sound = waitForEvent(client, 'playSound');
  server.push('PlaySound', 'Warning');
  assert.equal((await Sound)[0], 'Warning');

  const Custom = waitForEvent(client, 'playCustomAudio');
  server.push('PlayCustomAudio', { ID: 'a', Label: 'Klaxon', Volume: 100, DataURL: 'data:,' });
  assert.equal((await Custom)[0].Label, 'Klaxon');
});

test('favourites, alert rules and public settings are cached as they arrive', async (t) => {
  const { server, client } = await startConnectedDevice(t);
  assert.deepEqual(client.getMonitoringFavourites(), []);

  const Favs = waitForEvent(client, 'favouritesChanged');
  server.push('SetFullMonitoringActionFavouriteList', [{ FavouriteID: 1, Label: 'GO' }]);
  await Favs;
  assert.equal(client.getMonitoringFavourites()[0].Label, 'GO');

  const Rules = waitForEvent(client, 'alertRulesChanged');
  server.push('SetFullAlertRuleList', [{ RuleID: 3, Title: 'Rack down' }]);
  await Rules;
  assert.equal(client.getAlertRules()[0].RuleID, 3);

  const Settings = waitForEvent(client, 'settingsChanged');
  server.push('UpdateSettings', [{ Key: 'UI_GROUP_COLUMN_COUNT', Value: 3 }], []);
  await Settings;
  assert.deepEqual(client.getPublicSettings(), [{ Key: 'UI_GROUP_COLUMN_COUNT', Value: 3 }]);
});

test('a malformed list push clears the cache rather than storing junk', async (t) => {
  const { server, client } = await startConnectedDevice(t);
  const Rules = waitForEvent(client, 'alertRulesChanged');
  server.push('SetFullAlertRuleList', 'not a list');
  await Rules;
  assert.deepEqual(client.getAlertRules(), []);
});
