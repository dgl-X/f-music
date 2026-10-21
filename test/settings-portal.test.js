import test from 'node:test';
import assert from 'node:assert/strict';
import {settingsPortalMode,settingsPortalView} from '../public/settings-portal.js';

test('Android settings mode is explicit and limits routed views',()=>{
  assert.equal(settingsPortalMode('?android_settings=1'),true);
  for(const query of ['', '?android_settings=true','?other=1'])assert.equal(settingsPortalMode(query),false);
  assert.equal(settingsPortalView('settings'),true);assert.equal(settingsPortalView('recognition'),false);
  for(const view of ['liked','tracks','search','albums','not-found'])assert.equal(settingsPortalView(view),false);
});
