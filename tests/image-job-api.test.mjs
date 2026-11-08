import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import imageSizes from '../server/image-sizes.json' with { type: 'json' };

test('job API accepts every shared size and rejects unsupported sizes before queuing', async (context) => {
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const { port } = portProbe.address();
  await new Promise((resolve) => portProbe.close(resolve));

  const server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  context.after(async () => {
    if (server.exitCode !== null) return;
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Job API startup timed out')), 15_000);
    let output = '';
    let errors = '';
    server.stderr.on('data', (chunk) => {
      errors += chunk.toString();
    });
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Job API exited with ${code}: ${errors}`));
    });
    server.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (!output.includes('server_started')) return;
      clearTimeout(timer);
      resolve();
    });
  });

  for (const size of [...imageSizes, '16:9', '1536x863', 'unsupported']) {
    const form = new FormData();
    form.set('route', 'site');
    form.set('model', 'gpt-image-2');
    form.set('prompt', 'size validation only');
    form.set('size', size);
    form.set('quality', 'auto');
    form.set('references', '[]');
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-only-key' },
      body: form,
      signal: AbortSignal.timeout(5_000),
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(
      payload.error.message,
      imageSizes.includes(size) ? 'invalid_references' : 'invalid_size',
      size,
    );
  }
  const health = await fetch(`http://127.0.0.1:${port}/api/healthz`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.deepEqual(await health.json(), { ok: true, queue: 0, active: 0 });
});
