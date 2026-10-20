import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLoopbackNavigationPolicy, installLoopbackNavigationPolicy } from '../loopback-policy.js';

const origin = 'http://127.0.0.1:3456';
const id = '11111111-1111-4111-8111-111111111111';
function fixture(enabled = true) {
  const session = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest(_filter, listener) { this.listener = listener; } } };
  const contents = (number) => Object.assign(new EventEmitter(), { id: number, mainFrame: { url: `${origin}/#x`, parent: null }, setWindowOpenHandler() {} });
  const main = contents(1), other = contents(2);
  const policy = createLoopbackNavigationPolicy({ origin });
  const mainPolicy = installLoopbackNavigationPolicy({ session, policy, webContents: main, allowXMediaResource: enabled });
  const otherPolicy = installLoopbackNavigationPolicy({ session, policy, webContents: other });
  const request = { url: `tibotattle-x-media://resource/${id}`, resourceType: 'image', method: 'GET', webContentsId: main.id, frame: main.mainFrame };
  const check = (patch, permitted) => {
    let decision;
    session.webRequest.listener({ ...request, ...patch }, value => { decision = value; });
    assert.deepEqual(decision, { cancel: !permitted }, JSON.stringify(patch));
  };
  return { session, main, other, mainPolicy, otherPolicy, request, check };
}

test('X media allows only canonical opaque resources requested by the opted-in dashboard main frame', () => {
  const f = fixture();
  for (const resourceType of ['image', 'media', 'xhr']) for (const method of ['GET', 'HEAD']) f.check({ resourceType, method }, true);
  for (const patch of [
    { method: 'POST' }, { method: 'DELETE' }, { resourceType: 'mainFrame' }, { resourceType: 'subFrame' }, { resourceType: 'script' },
    { resourceType: 'worker' }, { resourceType: 'other' }, { webContentsId: f.other.id }, { webContentsId: 999 },
    { frame: undefined }, { frame: { ...f.main.mainFrame } }, { frame: { url: `${origin}/`, parent: f.main.mainFrame } },
    { url: `${f.request.url}?url=https://video.twimg.com/example` }, { url: `${f.request.url}#fragment` }, { url: `${f.request.url}/segment` },
    { url: `tibotattle-x-media://user@resource/${id}` }, { url: `tibotattle-x-media://resource:80/${id}` },
    { url: 'tibotattle-x-media://resource/https://video.twimg.com/example' }, { url: 'https://video.twimg.com/example' },
    { url: f.request.url.replace('resource/', 'other/') }, { url: f.request.url.replace('11111111', '%311111111') },
  ]) f.check(patch, false);
  for (const url of [`${origin}/app.js`, `${origin}/?x`, 'https://x.com/', 'http://127.0.0.1:3457/']) { f.main.mainFrame.url = url; f.check({}, false); }
  f.main.mainFrame.url = `${origin}/`;
  f.mainPolicy.remove(); f.check({}, false); f.otherPolicy.remove();
});

test('MSE blobs are limited to media from the same opted-in main frame and exact dashboard origin', () => {
  const f = fixture(); const blob = `blob:${origin}/${id}`;
  f.check({ url: blob, resourceType: 'media' }, true);
  for (const patch of [
    { resourceType: 'xhr' }, { resourceType: 'image' }, { resourceType: 'script' }, { resourceType: 'worker' }, { resourceType: 'mainFrame' },
    { webContentsId: f.other.id }, { frame: undefined }, { url: `blob:https://x.com/${id}` }, { url: `blob:http://127.0.0.1:3457/${id}` },
    { url: `${blob}?query` }, { url: `${blob}#fragment` }, { url: `blob:${origin}/arbitrary` }, { url: `blob:http://user@127.0.0.1:3456/${id}` },
  ]) f.check({ url: blob, resourceType: 'media', ...patch }, false);
  const ordinary = fixture(false);
  ordinary.check({}, false);
  ordinary.check({ url: blob, resourceType: 'media' }, false);
});
