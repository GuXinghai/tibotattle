import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeXCookieImport, validateXSettings, isXMediaUrl, isXPageUrl, validateXPost, validateXNotificationBaseline, X_DEFAULT_SETTINGS } from '../desktop-x-contract.js';

const cookie = (name, extra = {}) => ({ domain: '.x.com', hostOnly: false, httpOnly: name === 'auth_token', name, path: '/', sameSite: 'no_restriction', secure: true, session: true, value: 'synthetic-only', ...extra });
const payload = () => ({ version: 1, type: 'x-cookie-import', cookies: [cookie('auth_token'), cookie('ct0')] });
test('X settings remain closed and accept disabled cadence without coercing input', () => {
  assert.deepEqual(validateXSettings(X_DEFAULT_SETTINGS), X_DEFAULT_SETTINGS);
  assert.deepEqual(validateXSettings({ refreshMinutes: -1, proxyMode: 'local', proxyPort: 65535 }, true), { refreshMinutes: -1, proxyMode: 'local', proxyPort: 65535 });
  for (const value of [{ refreshMinutes: 0 }, { refreshMinutes: '5' }, { refreshMinutes: 1.2 }, { proxyPort: 65536 }, { notifyPosts: 1 }, { unknown: true }]) assert.throws(() => validateXSettings(value, true));
});
test('X import preserves cookie policy and rejects foreign/partitioned or incomplete credentials', () => {
  const value = payload(); value.cookies.push(cookie('__Host-example', { domain: 'x.com', hostOnly: true, expirationDate: 2000000000, session: false }));
  const output = normalizeXCookieImport(value, 1000);
  assert.equal(output[0].httpOnly, true); assert.equal(output[0].sameSite, 'no_restriction'); assert.equal(output[2].domain, undefined); assert.equal(output[2].expirationDate, 2000000000);
  for (const mutate of [p => p.cookies[0].domain = 'x.com.evil.test', p => p.cookies[0].partitionKey = {}, p => p.cookies[0].value = 'bad\nvalue', p => p.cookies.pop(), p => p.cookies.push(p.cookies[0]), p => p.cookies[0].secure = false, p => p.cookies[0].expirationDate = 123]) { const p = payload(); mutate(p); assert.throws(() => normalizeXCookieImport(p)); }
});
test('X remote sources are exact HTTPS origins and narrow media hosts', () => {
  assert.equal(isXPageUrl('https://x.com/home'), true);
  for (const url of ['https://x.com.evil.test', 'https://user@x.com/', 'http://x.com/', 'https://x.com:8080/']) assert.equal(isXPageUrl(url), false);
  assert.equal(isXMediaUrl('https://video.twimg.com/clip.mp4'), true);
  for (const url of ['https://video.twimg.com.evil.test/clip.mp4', 'file:///secret', 'https://x.com/api']) assert.equal(isXMediaUrl(url), false);
  assert.throws(() => validateXPost({ id: '1' }));
});


test('notification baseline migrates closed categories and validates ordered bounded IDs', () => {
  assert.deepEqual(validateXNotificationBaseline({ posts: ['0', '10'], replies: [] }, 1), { posts: { floor: '10', seen: [] }, replies: { floor: null, seen: [] } });
  for (const posts of [{ floor: null, seen: ['1'] }, { floor: '10', seen: ['9'] }, { floor: '10', seen: ['12', '11'] }, { floor: '0', seen: Array.from({length: 1025}, (_, i) => String(i + 1)) }]) assert.throws(() => validateXNotificationBaseline({ posts, replies: { floor: null, seen: [] } }));
});

test('media identity preserves upstream IDs and rejects duplicates or arbitrary references', () => {
  const post = { id: '1', author: { name: 'Example', handle: 'example' }, createdAt: '2026-10-20T00:00:00.000Z', text: '', complete: true, kind: 'post', media: [{ id: 'media-123', type: 'image', url: 'https://pbs.twimg.com/media/example.jpg' }] };
  assert.equal(validateXPost(post).media[0].id, 'media-123');
  assert.throws(() => validateXPost({ ...post, media: [...post.media, ...post.media] })); assert.throws(() => validateXPost({ ...post, media: [{ ...post.media[0], id: 'https://example.test' }] }));
});
