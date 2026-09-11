import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWaitlistServer } from './server.mjs';

test('reports the real unique subscriber count without exposing emails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'murmur-waitlist-'));
  const publicDir = join(root, 'public');
  mkdirSync(publicDir);
  writeFileSync(join(publicDir, 'index.html'), '<h1>Murmur</h1>');
  const dbPath = join(root, 'waitlist.sqlite');
  const app = createWaitlistServer({ dbPath, publicDir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const submit = (email) => fetch(`${base}/api/waitlist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    const count = () => fetch(`${base}/api/waitlist/count`, { cache: 'no-store' });
    assert.deepEqual(await (await count()).json(), { count: 0 });
    assert.deepEqual(await (await submit('  HELLO@EXAMPLE.COM ')).json(), { ok: true });
    assert.deepEqual(await (await count()).json(), { count: 1 });
    assert.deepEqual(await (await submit('hello@example.com')).json(), { ok: true });
    assert.deepEqual(await (await count()).json(), { count: 1 });
    const invalid = await submit('not an email');
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: 'Enter a valid email address.' });
    assert.deepEqual(await (await count()).json(), { count: 1 });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
