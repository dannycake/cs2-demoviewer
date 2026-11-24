import test from 'node:test';
import assert from 'node:assert/strict';
import { DELAY_MS, parseLines, seedOne } from './seed-players.mjs';

const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });

test('parseLines drops blank and comment lines and trims', () => {
  assert.deepEqual(parseLines('  a  \n\n# note\r\n  # also\nb\n'), ['a', 'b']);
});

test('seedOne: a player answer warms the profile and returns name', async () => {
  const urls = [];
  const f = async (url) => {
    urls.push(String(url));
    return String(url).includes('/api/lookup')
      ? reply(200, { kind: 'profile', steamid: '76561198000000001' })
      : reply(200, { steamid: '76561198000000001', name: 'zeus' });
  };
  const r = await seedOne('https://x.test', 'a b', f);
  assert.deepEqual(r, { kind: 'ok', steamid: '76561198000000001', name: 'zeus' });
  assert.equal(urls[0], 'https://x.test/api/lookup?q=a%20b');
  assert.equal(urls[1], 'https://x.test/api/players/76561198000000001');
});

test('seedOne: 404 is not found, 500 is an error', async () => {
  assert.deepEqual(await seedOne('https://x', 'q', async () => reply(404, { error: 'no' })), { kind: 'not found' });
  assert.deepEqual(await seedOne('https://x', 'q', async () => reply(500, {})), { kind: 'error', status: 500 });
});

test('the default pause keeps any input under the lookup limit of 60 an hour', () => {
  // A custom URL name costs two rate-limited lookups: /api/lookup, then /api/players/{id}.
  assert.ok((2 * 3600 * 1000) / DELAY_MS <= 60, `${DELAY_MS} ms`);
});
