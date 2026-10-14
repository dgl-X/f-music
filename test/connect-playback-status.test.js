import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConnectPlayback } from '../src/connect-service.js';
import { connectPositionAdvances, webConnectPlaybackStatus } from '../public/connect-playback.js';

test('buffering retains playback intent but freezes the remote clock', () => {
  const state=normalizeConnectPlayback({playing:true,is_playing:false,buffering:true});
  assert.deepEqual(state,{playing:true,is_playing:false,buffering:true,playback_status:'buffering'});
  assert.equal(connectPositionAdvances(state),false);
  assert.equal(connectPositionAdvances({...state,is_playing:true}),true);
});

test('legacy producers retain the original playing contract', () => {
  assert.equal(normalizeConnectPlayback({playing:true}).is_playing,true);
  assert.equal(connectPositionAdvances({playing:true}),true);
  assert.equal(connectPositionAdvances({playing:true,buffering:true}),false);
});

test('pause and audio-focus waiting never advance position', () => {
  for(const input of [{playing:false,is_playing:true,buffering:true},{playing:true,is_playing:false}]){
    const state=normalizeConnectPlayback(input);
    assert.equal(connectPositionAdvances(state),false);
    assert.equal(state.buffering,false);
  }
  assert.equal(normalizeConnectPlayback({playing:false,playback_status:'preparing'}).playback_status,'preparing');
});

test('browser distinguishes loading, playing and completed media', () => {
  assert.equal(webConnectPlaybackStatus({paused:false,ended:false,readyState:2}).playback_status,'buffering');
  assert.equal(webConnectPlaybackStatus({paused:false,ended:false,readyState:3}).is_playing,true);
  assert.equal(webConnectPlaybackStatus({paused:false,ended:true,readyState:4}).playing,false);
});
