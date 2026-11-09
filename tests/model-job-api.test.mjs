import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { createModelJobService } from '../server/model-jobs.mjs';
import { modelFixture } from './helpers/model-fixture.mjs';

const accessToken = 'test-backend-access-token-not-a-provider-key-123456';
const image = await sharp({
  create: { width: 320, height: 512, channels: 3, background: { r: 200, g: 210, b: 220 } },
})
  .png()
  .toBuffer();

function provider(options = {}) {
  const calls = [];
  let uploads = 0,
    polls = 0;
  return {
    calls,
    async fetcher(url, init) {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      if (url.endsWith('/files')) {
        assert.equal(init.headers.Authorization, 'Bearer test-tripo-key');
        assert.equal(init.body.get('file').type, 'image/png');
        return Response.json({ code: 0, data: { file_token: `file_${++uploads}` } });
      }
      if (url.endsWith('/generation/multiview-to-model')) {
        if (options.uncertain) throw Error('connection lost after submission');
        return Response.json({ code: 0, data: { task_id: 'test-task-123' } });
      }
      if (url.includes('/tasks/')) {
        if (++polls === 1 && options.transient) throw Error('temporary unavailable');
        return Response.json({
          code: 0,
          data: {
            status: options.status || 'success',
            progress: 100,
            output: { model_url: options.modelUrl || 'https://cdn.tripo3d.ai/output/model.glb' },
          },
        });
      }
      assert.equal(init.headers.Authorization, undefined);
      return new Response(options.bytes || modelFixture());
    },
  };
}

async function start(context, options = {}) {
  const mock = options.mock || provider(options.provider);
  const diagnostics = [];
  const service = createModelJobService({
    onDiagnostic: (record) => diagnostics.push(record),
    providerName: 'tripo',
    apiKey: 'test-tripo-key',
    accessToken,
    pollInterval: 1,
    timeout: 3000,
    fetcher: mock.fetcher,
    ...options.service,
  });
  const server = createServer(async (request, response) => {
    if (!(await service.handle(request, response, new URL(request.url, 'http://localhost')))) {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/model-jobs`;
  return { base, calls: mock.calls, diagnostics };
}

function form(bytes = image, sideView = 'left') {
  const data = new FormData();
  for (const view of ['front', 'side', 'back'])
    data.set(view, new Blob([bytes], { type: 'image/png' }), `${view}.png`);
  data.set('sideView', sideView);
  return data;
}

async function submit(base, data = form(), extra = {}) {
  const response = await fetch(base, {
    method: 'POST',
    body: data,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Idempotency-Key': 'stable-submission-12345',
      ...extra,
    },
    signal: AbortSignal.timeout(5000),
  });
  return { response, payload: await response.json() };
}

async function terminal(base, job) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/${job.jobId}`, {
      headers: { 'X-Model-Job-Token': job.jobToken },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    if (['succeeded', 'failed', 'cancelled'].includes(result.status)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error('model test timed out');
}

test('model API is disabled without server credentials and rejects unauthorized/foreign origins before upstream calls', async (context) => {
  const disabled = await start(context, { service: { apiKey: '' } });
  assert.equal((await submit(disabled.base)).response.status, 503);
  const shortToken = await start(context, { service: { accessToken: 'short' } });
  assert.equal((await submit(shortToken.base)).response.status, 503);
  const enabled = await start(context);
  assert.equal(
    (await submit(enabled.base, form(), { Authorization: 'Bearer wrong' })).response.status,
    401,
  );
  assert.equal(
    (await submit(enabled.base, form(), { Origin: 'https://evil.example' })).response.status,
    403,
  );
  assert.equal(enabled.calls.length, 0);
  const preflight = await fetch(enabled.base, {
    method: 'OPTIONS',
    headers: { Origin: 'http://127.0.0.1:5199' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5199');
});

test('model API validates three images, duplicate fields, side direction, image bytes and dimensions', async (context) => {
  const { base, calls } = await start(context);
  const missing = form();
  missing.delete('back');
  const duplicate = form();
  duplicate.append('sideView', 'right');
  const unknown = form();
  unknown.append('url', 'http://localhost/private');
  const tiny = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#fff' } })
    .png()
    .toBuffer();
  for (const invalid of [
    missing,
    duplicate,
    unknown,
    form(image, 'front'),
    form(Buffer.from('not PNG')),
    form(tiny),
  ]) {
    const result = await submit(base, invalid);
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.error.message, 'invalid_images');
  }
  assert.equal(calls.length, 0);
});

test('model API uses v3 view slots, serial uploads, scoped result credentials and does not leak provider keys', async (context) => {
  const { base, calls } = await start(context);
  const { response, payload: job } = await submit(base, form(image, 'right'));
  assert.equal(response.status, 202);
  assert.equal(job.jobToken.length, 64);
  const completed = await terminal(base, job);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.progress, 100);
  assert.equal(completed.providerTaskId, 'test-task-123');
  assert.equal(calls.filter((call) => call.url.endsWith('/files')).length, 3);
  const task = JSON.parse(
    calls.find((call) => call.url.endsWith('/generation/multiview-to-model')).init.body,
  );
  assert.deepEqual(task.inputs, [
    { front: { file_token: 'file_1' } },
    { right: { file_token: 'file_2' } },
    { back: { file_token: 'file_3' } },
  ]);
  assert.equal(task.model, 'v3.1-20260211');
  assert.equal(task.face_limit, 30000);
  assert.equal(task.texture, true);
  const route = `${base}/${job.jobId}/result`;
  assert.equal((await fetch(route)).status, 401);
  assert.equal(
    (await fetch(route, { headers: { 'X-Model-Job-Token': 'another-task-token' } })).status,
    401,
  );
  const result = await fetch(route, { headers: { 'X-Model-Job-Token': job.jobToken } });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-type'), 'model/gltf-binary');
  assert.deepEqual(Buffer.from(await result.arrayBuffer()), modelFixture());
  assert.doesNotMatch(JSON.stringify(completed), /test-tripo-key|cdn\.tripo/);
});

test('duplicate submission reuses the task and a mismatched payload is rejected', async (context) => {
  const { base, calls } = await start(context);
  const first = await submit(base);
  await terminal(base, first.payload);
  const second = await submit(base);
  assert.equal(first.payload.jobId, second.payload.jobId);
  assert.equal(first.payload.jobToken, second.payload.jobToken);
  const conflict = await submit(base, form(image, 'right'));
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.payload.error.message, 'conflict');
  assert.equal(
    calls.filter((call) => call.url.endsWith('/generation/multiview-to-model')).length,
    1,
  );
});

test('transient polling failures only retry GET, never paid task submission', async (context) => {
  const { base, calls } = await start(context, { provider: { transient: true } });
  const { payload: job } = await submit(base);
  assert.equal((await terminal(base, job)).status, 'succeeded');
  assert.equal(calls.filter((call) => call.url.includes('/tasks/')).length, 2);
  assert.equal(
    calls.filter((call) => call.url.endsWith('/generation/multiview-to-model')).length,
    1,
  );
});

test('uncertain paid submission becomes terminal and duplicate request does not retry upstream', async (context) => {
  const { base, calls } = await start(context, { provider: { uncertain: true } });
  const { payload: job } = await submit(base);
  const failed = await terminal(base, job);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.message, 'submission_uncertain');
  assert.equal((await submit(base)).payload.jobId, job.jobId);
  assert.equal(
    calls.filter((call) => call.url.endsWith('/generation/multiview-to-model')).length,
    1,
  );
});

test('model result rejects untrusted hosts and external GLB resources', async (context) => {
  const untrusted = await start(context, { provider: { modelUrl: 'http://127.0.0.1/secret.glb' } });
  const first = await submit(untrusted.base);
  assert.equal((await terminal(untrusted.base, first.payload)).error.message, 'invalid_model');
  assert.equal(
    untrusted.calls.some((call) => call.url.startsWith('http://127.0.0.1')),
    false,
  );
  const external = await start(context, {
    provider: { bytes: modelFixture({ images: [{ uri: 'https://evil.example/image.png' }] }) },
  });
  const second = await submit(external.base);
  assert.equal((await terminal(external.base, second.payload)).error.message, 'invalid_model');
});

test('unknown provider states have bounded waiting and cancellation requires task credentials', async (context) => {
  const { base, calls } = await start(context, {
    provider: { status: 'unknown' },
    service: { timeout: 80 },
  });
  const { payload: job } = await submit(base);
  assert.equal((await fetch(`${base}/${job.jobId}`, { method: 'DELETE' })).status, 401);
  const cancelled = await fetch(`${base}/${job.jobId}`, {
    method: 'DELETE',
    headers: { 'X-Model-Job-Token': job.jobToken },
  });
  assert.equal((await cancelled.json()).status, 'cancelled');
  const second = await submit(base, form(), { 'X-Idempotency-Key': 'second-submission-123' });
  const failed = await terminal(base, second.payload);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.message, 'timed_out');
  assert.ok(
    calls.filter((call) => call.url.endsWith('/generation/multiview-to-model')).length <= 2,
  );
});

test('in-flight queue is bounded and old terminal records are evicted at capacity', async (context) => {
  const queued = await start(context, {
    provider: { status: 'running' },
    service: { maxPending: 1, timeout: 2000 },
  });
  await submit(queued.base);
  const full = await submit(queued.base, form(), {
    'X-Idempotency-Key': 'different-submission-123',
  });
  assert.equal(full.response.status, 429);
  assert.equal(full.payload.error.message, 'queue_full');
  const bounded = await start(context, { service: { maxJobs: 1 } });
  const first = await submit(bounded.base);
  await terminal(bounded.base, first.payload);
  const second = await submit(bounded.base, form(), {
    'X-Idempotency-Key': 'another-submission-123',
  });
  await terminal(bounded.base, second.payload);
  assert.equal(
    (
      await fetch(`${bounded.base}/${first.payload.jobId}`, {
        headers: { 'X-Model-Job-Token': first.payload.jobToken },
      })
    ).status,
    404,
  );
});

test('normalization rejects narrow views that would shrink below the minimum modeling resolution', async (context) => {
  const { base, calls } = await start(context);
  const narrow = await sharp({
    create: { width: 320, height: 8000, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  const result = await submit(base, form(narrow));
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.error.message, 'invalid_images');
  assert.equal(calls.length, 0);
});

const hunyuanJobId = '1387416933258346496';
const hunyuanModelUrl =
  'https://hunyuan-prod-1258344699.cos.ap-guangzhou.tencentcos.cn/output/model.glb?sign=mock-signature';

function hunyuanProvider(options = {}) {
  const calls = [];
  let polls = 0;
  const envelope = (value, status = 200) =>
    Response.json(options.flat ? value : { Response: value }, {
      status,
      headers: options.responseHeaders,
    });
  return {
    calls,
    async fetcher(url, init) {
      calls.push({ url, init });
      assert.equal(init.redirect, 'error');
      if (url.startsWith('https://api.ai3d.cloud.tencent.com/')) {
        assert.equal(init.headers.Authorization, 'test-hunyuan-key');
        assert.equal(init.headers['Content-Type'], 'application/json');
        assert.equal(init.method, 'POST');
        if (url.endsWith('/submit')) {
          if (options.uncertain) throw Error('connection lost after paid POST');
          if (options.submitStatus)
            return options.submitBody === undefined
              ? new Response('upstream detail', {
                  status: options.submitStatus,
                  headers: options.responseHeaders,
                })
              : envelope(options.submitBody, options.submitStatus);
          if (options.submitBody !== undefined) return envelope(options.submitBody);
          return envelope({ JobId: hunyuanJobId });
        }
        assert.equal(url, 'https://api.ai3d.cloud.tencent.com/v1/ai3d/query');
        assert.deepEqual(JSON.parse(init.body), { JobId: hunyuanJobId });
        polls++;
        if (polls === 1 && options.transient) return new Response('try later', { status: 503 });
        if (options.queryResponses?.[polls - 1]) {
          const reply = options.queryResponses[polls - 1];
          return envelope(reply.body, reply.status);
        }
        if (options.queryBody !== undefined)
          return envelope(options.queryBody, options.queryStatus);
        const statuses = options.statuses || ['WAIT', 'RUN', 'DONE'];
        return envelope({
          Status: statuses[Math.min(polls - 1, statuses.length - 1)],
          ErrorCode: '',
          ErrorMessage: '',
          ResultFile3Ds: options.files || [
            { Type: 'OBJ', Url: 'https://untrusted.example/not-the-glb.zip' },
            { Type: 'GLB', Url: options.modelUrl || hunyuanModelUrl },
          ],
        });
      }
      assert.equal(init.headers.Authorization, undefined);
      if (options.downloadRedirect)
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1/secret' },
        });
      return new Response(options.bytes || modelFixture());
    },
  };
}

async function startHunyuan(context, options = {}) {
  return start(context, {
    mock: hunyuanProvider(options.provider),
    service: { providerName: 'hunyuan', apiKey: 'test-hunyuan-key', ...options.service },
  });
}

for (const sideView of ['left', 'right']) {
  test(
    'Hunyuan maps front/' +
      sideView +
      '/back, uses raw API key and returns a scoped GLB without paid add-ons',
    async (context) => {
      const { base, calls } = await startHunyuan(context);
      const images = {};
      const data = new FormData();
      for (const [index, field] of ['front', 'side', 'back'].entries()) {
        images[field] = await sharp({
          create: {
            width: 320,
            height: 512,
            channels: 3,
            background: { r: 50 + index * 50, g: 120, b: 200 },
          },
        })
          .png()
          .toBuffer();
        data.set(field, new Blob([images[field]], { type: 'image/png' }), field + '.png');
      }
      data.set('sideView', sideView);
      const { response, payload: job } = await submit(base, data);
      assert.equal(response.status, 202);
      const done = await terminal(base, job);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.progress, 100);
      assert.equal(done.providerTaskId, hunyuanJobId);
      const submitted = calls.filter((call) => call.url.endsWith('/submit'));
      assert.equal(submitted.length, 1);
      const body = JSON.parse(submitted[0].init.body);
      assert.deepEqual(body, {
        Model: '3.0',
        ImageUrl: { Url: 'data:image/png;base64,' + images.front.toString('base64') },
        MultiViewImages: [
          { ViewType: sideView, ViewImageBase64: images.side.toString('base64') },
          { ViewType: 'back', ViewImageBase64: images.back.toString('base64') },
        ],
      });
      assert.equal(calls.filter((call) => call.url.endsWith('/query')).length, 3);
      const download = calls.find((call) => call.url === hunyuanModelUrl);
      assert.ok(download);
      assert.equal(download.init.headers.Authorization, undefined);
      const route = base + '/' + job.jobId + '/result';
      assert.equal((await fetch(route)).status, 401);
      const result = await fetch(route, { headers: { 'X-Model-Job-Token': job.jobToken } });
      assert.equal(result.status, 200);
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), modelFixture());
      assert.doesNotMatch(JSON.stringify(done), /test-hunyuan-key|tencentcos|mock-signature/);
      // Reusing the idempotency key restores this job; it never resubmits to Tencent.
      assert.equal((await submit(base, data)).payload.jobId, job.jobId);
      assert.equal(calls.filter((call) => call.url.endsWith('/submit')).length, 1);
    },
  );
}

test('Hunyuan supports model 3.1 and a flat compatible response', async (context) => {
  const { base, calls } = await startHunyuan(context, {
    provider: { flat: true },
    service: { model: '3.1' },
  });
  const { payload: job } = await submit(base);
  assert.equal((await terminal(base, job)).status, 'succeeded');
  assert.equal(JSON.parse(calls[0].init.body).Model, '3.1');
});

test('Hunyuan rejects missing credentials, unsupported providers/models and foreign API origins before any upstream call', async (context) => {
  for (const config of [
    { apiKey: '' },
    { accessToken: 'short' },
    { model: '3.2' },
    { apiOrigin: 'https://evil.example' },
    { apiOrigin: 'https://openapi.tripo3d.ai' },
    { providerName: 'unknown' },
    { providerName: '__proto__' },
  ]) {
    const { base, calls } = await startHunyuan(context, { service: config });
    const result = await submit(base);
    assert.equal(result.response.status, 503);
    assert.equal(calls.length, 0);
  }
  const { base, calls } = await startHunyuan(context);
  assert.equal(
    (await submit(base, form(), { Authorization: 'Bearer wrong' })).response.status,
    401,
  );
  assert.equal(
    (await submit(base, form(), { Origin: 'https://evil.example' })).response.status,
    403,
  );
  assert.equal(calls.length, 0);
});

test('Hunyuan selects its own environment credentials and does not fall back to a Tripo key', async (context) => {
  const names = [
    'MODEL_PROVIDER',
    'HUNYUAN_API_KEY',
    'TRIPO_API_KEY',
    'HUNYUAN_MODEL',
    'HUNYUAN_API_ORIGIN',
    'MODEL_RESULT_HOSTS',
  ];
  const old = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.MODEL_PROVIDER = 'hunyuan';
    process.env.TRIPO_API_KEY = 'a-tripo-key-must-not-be-used';
    for (const name of [
      'HUNYUAN_API_KEY',
      'HUNYUAN_MODEL',
      'HUNYUAN_API_ORIGIN',
      'MODEL_RESULT_HOSTS',
    ])
      delete process.env[name];
    const disabled = await start(context, {
      service: { providerName: undefined, apiKey: undefined },
    });
    assert.equal((await submit(disabled.base)).response.status, 503);
    assert.equal(disabled.calls.length, 0);
    process.env.HUNYUAN_API_KEY = 'test-hunyuan-key';
    const enabled = await startHunyuan(context, {
      service: { providerName: undefined, apiKey: undefined },
    });
    const { payload: job } = await submit(enabled.base);
    assert.equal((await terminal(enabled.base, job)).status, 'succeeded');
  } finally {
    for (const [name, value] of old) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('Hunyuan retries transient read-only query POSTs but never the paid submit POST', async (context) => {
  const { base, calls } = await startHunyuan(context, { provider: { transient: true } });
  const { payload: job } = await submit(base);
  assert.equal((await terminal(base, job)).status, 'succeeded');
  assert.equal(calls.filter((call) => call.url.endsWith('/query')).length, 3);
  assert.equal(calls.filter((call) => call.url.endsWith('/submit')).length, 1);
});

test('Hunyuan uncertain network/5xx submission and missing JobId stay terminal on duplicate submissions', async (context) => {
  for (const provider of [{ uncertain: true }, { submitStatus: 503 }, { submitBody: {} }]) {
    const { base, calls } = await startHunyuan(context, { provider });
    const { payload: job } = await submit(base);
    const failed = await terminal(base, job);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.message, 'submission_uncertain');
    assert.equal((await submit(base)).payload.jobId, job.jobId);
    assert.equal(calls.filter((call) => call.url.endsWith('/submit')).length, 1);
    assert.equal(calls.filter((call) => call.url.endsWith('/query')).length, 0);
  }
});

test('Hunyuan distinguishes safe auth/resource/task errors without leaking upstream messages', async (context) => {
  const sensitive = 'provider message test-hunyuan-key signed-secret-url';
  for (const [provider, code, stage] of [
    [{ submitStatus: 401 }, 'provider_auth_failed', 'submit'],
    [
      { submitBody: { Error: { Code: 'ResourceInsufficient', Message: sensitive } } },
      'provider_resource_limited',
      'submit',
    ],
    [{ submitBody: { error: { message: sensitive } } }, 'provider_failed', 'submit'],
    [
      { queryBody: { Status: 'FAIL', ErrorCode: 'FailedOperation', ErrorMessage: sensitive } },
      'provider_failed',
      'query',
    ],
    [{ queryBody: { Status: 'UNKNOWN' } }, 'provider_failed', 'query'],
    [{ queryBody: {} }, 'provider_failed', 'query'],
    [
      { queryBody: { Status: 'DONE', ErrorCode: 'FailedOperation', ErrorMessage: sensitive } },
      'provider_failed',
      'query',
    ],
  ]) {
    const { base, diagnostics } = await startHunyuan(context, { provider });
    const { payload: job } = await submit(base);
    const failed = await terminal(base, job);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.message, code);
    assert.equal(failed.error.diagnostic.provider, 'hunyuan');
    assert.equal(failed.error.diagnostic.stage, stage);
    assert.doesNotMatch(
      JSON.stringify({ failed, diagnostics }),
      /test-hunyuan-key|signed-secret-url/,
    );
    assert.deepEqual(diagnostics, [{ jobId: job.jobId, error: code, ...failed.error.diagnostic }]);
  }
});

test('Hunyuan accepts only a GLB result and never follows unsafe or redirected URLs', async (context) => {
  for (const provider of [
    { files: [{ Type: 'OBJ', Url: hunyuanModelUrl }] },
    { modelUrl: 'https://evil.example/model.glb' },
    { modelUrl: 'https://127.0.0.1/secret.glb' },
    {
      modelUrl:
        'https://user:pass@hunyuan-prod-1258344699.cos.ap-guangzhou.tencentcos.cn/model.glb',
    },
    { modelUrl: hunyuanModelUrl + '#fragment' },
  ]) {
    const { base, calls } = await startHunyuan(context, { provider });
    const { payload: job } = await submit(base);
    assert.equal((await terminal(base, job)).error.message, 'invalid_model');
    assert.equal(
      calls.some((call) => !call.url.startsWith('https://api.ai3d.cloud.tencent.com/')),
      false,
    );
  }
  const redirected = await startHunyuan(context, { provider: { downloadRedirect: true } });
  const job = (await submit(redirected.base)).payload;
  assert.equal((await terminal(redirected.base, job)).error.message, 'provider_unavailable');
  assert.equal(
    redirected.calls.some((call) => call.url.startsWith('http://127.0.0.1')),
    false,
  );
  const external = await startHunyuan(context, {
    provider: { bytes: modelFixture({ images: [{ uri: 'https://evil.example/image.png' }] }) },
  });
  const second = (await submit(external.base)).payload;
  assert.equal((await terminal(external.base, second)).error.message, 'invalid_model');
});

test('Hunyuan enforces the combined base64 image limit before creating any paid task', async (context) => {
  const { base, calls } = await startHunyuan(context);
  const noise = await sharp(randomBytes(1024 * 1024 * 3), {
    raw: { width: 1024, height: 1024, channels: 3 },
  })
    .png()
    .toBuffer();
  assert.ok(noise.length < 5 * 1024 * 1024);
  const result = await submit(base, form(noise));
  assert.equal(result.response.status, 413);
  assert.equal(result.payload.error.message, 'request_too_large');
  assert.equal(calls.length, 0);
});

test('Hunyuan waiting is bounded and local cancellation requires per-task credentials', async (context) => {
  const { base, calls } = await startHunyuan(context, {
    provider: { statuses: ['RUN'] },
    service: { timeout: 100 },
  });
  const { payload: job } = await submit(base);
  const route = base + '/' + job.jobId;
  assert.equal((await fetch(route, { method: 'DELETE' })).status, 401);
  const response = await fetch(route, {
    method: 'DELETE',
    headers: { 'X-Model-Job-Token': job.jobToken },
  });
  assert.equal((await response.json()).status, 'cancelled');
  const second = await submit(base, form(), { 'X-Idempotency-Key': 'another-hunyuan-job-123' });
  assert.equal((await terminal(base, second.payload)).error.message, 'timed_out');
  assert.ok(calls.filter((call) => call.url.endsWith('/submit')).length <= 2);
  assert.equal(
    calls.some((call) => call.url.endsWith('/cancel')),
    false,
  );
});

const publicRequestId = 'd1c706e5-d779-4a76-a882-75b6737f529c';

test('Hunyuan reads safe error codes and RequestId from failed HTTP and flat/enveloped responses', async (context) => {
  for (const [status, code, expected] of [
    [401, 'AuthFailure.InvalidAuthorization', 'provider_auth_failed'],
    [403, 'AuthFailure.UnauthorizedOperation', 'provider_access_denied'],
    [200, 'ResourceInsufficient', 'provider_resource_limited'],
    [402, 'LimitExceeded', 'provider_resource_limited'],
    [400, 'InvalidParameter', 'provider_invalid_request'],
    [200, 'UnknownParameter', 'provider_invalid_request'],
    [200, 'NoSuchProduct', 'provider_access_denied'],
    [200, 'FailedOperation', 'provider_failed'],
  ]) {
    for (const flat of [true, false]) {
      const { base, calls, diagnostics } = await startHunyuan(context, {
        provider: {
          flat,
          submitStatus: status,
          submitBody: {
            Error: { Code: code, Message: 'test-hunyuan-key private payload' },
            RequestId: publicRequestId,
          },
        },
      });
      const { payload: job } = await submit(base);
      const failed = await terminal(base, job);
      assert.equal(failed.error.message, expected);
      assert.deepEqual(failed.error.diagnostic, {
        provider: 'hunyuan',
        stage: 'submit',
        httpStatus: status,
        providerCode: code,
        requestId: publicRequestId,
      });
      assert.equal(failed.providerTaskId, undefined);
      assert.equal((await submit(base)).payload.jobId, job.jobId);
      assert.equal(calls.filter((call) => call.url.endsWith('/submit')).length, 1);
      assert.equal(diagnostics.length, 1);
      assert.doesNotMatch(
        JSON.stringify({ failed, diagnostics }),
        /test-hunyuan-key|private payload/,
      );
    }
  }
});

test('Hunyuan HTTP 400 uses safe business-code categories instead of assuming invalid parameters', async (context) => {
  for (const [rawCode, safeCode, expected] of [
    ['ResourceUnavailable.NotExist', 'ResourceUnavailable', 'provider_unavailable'],
    ['ResourceInsufficient.UnknownDetail', 'ResourceInsufficient', 'provider_resource_limited'],
    ['AuthFailure.UnknownDetail', 'AuthFailure', 'provider_auth_failed'],
    ['UnauthorizedOperation.UnknownDetail', 'UnauthorizedOperation', 'provider_access_denied'],
    ['NoSuchVersion.UnknownDetail', 'NoSuchVersion', 'provider_access_denied'],
    ['InvalidParameter.UnknownDetail', 'InvalidParameter', 'provider_invalid_request'],
    ['FailedOperation.UnknownDetail', 'FailedOperation', 'provider_failed'],
    ['test-hunyuan-key', undefined, 'provider_rejected'],
    [undefined, undefined, 'provider_rejected'],
  ]) {
    for (const flat of [true, false]) {
      const { base, calls, diagnostics } = await startHunyuan(context, {
        provider: {
          flat,
          submitStatus: 400,
          submitBody: {
            error: { code: rawCode, message: 'test-hunyuan-key private payload' },
            RequestId: publicRequestId,
          },
        },
      });
      const { payload: job } = await submit(base);
      const failed = await terminal(base, job);
      assert.equal(failed.error.message, expected);
      assert.deepEqual(failed.error.diagnostic, {
        provider: 'hunyuan',
        stage: 'submit',
        httpStatus: 400,
        ...(safeCode ? { providerCode: safeCode } : {}),
        requestId: publicRequestId,
      });
      assert.equal((await submit(base)).payload.jobId, job.jobId);
      assert.equal(calls.length, 1);
      assert.equal(diagnostics.length, 1);
      assert.doesNotMatch(
        JSON.stringify({ failed, diagnostics }),
        /UnknownDetail|NotExist|test-hunyuan-key|private payload/,
      );
    }
  }
});

test('Hunyuan unreadable HTTP 400 is an unclassified rejection, not a confirmed parameter error', async (context) => {
  const { base, calls } = await startHunyuan(context, { provider: { submitStatus: 400 } });
  const { payload: job } = await submit(base);
  const failed = await terminal(base, job);
  assert.equal(failed.error.message, 'provider_rejected');
  assert.deepEqual(failed.error.diagnostic, {
    provider: 'hunyuan',
    stage: 'submit',
    httpStatus: 400,
  });
  assert.equal((await submit(base)).payload.jobId, job.jobId);
  assert.equal(calls.length, 1);
});

test('Hunyuan HTTP 400 reads public codes from alternate JSON fields without reflecting raw messages', async (context) => {
  for (const body of [
    { code: 'AuthFailure.InvalidAuthorization' },
    { Code: 'AuthFailure.InvalidAuthorization' },
    { error: { code: 'AuthFailure.InvalidAuthorization', request_id: publicRequestId } },
    {
      Error: { Code: 'test-hunyuan-key' },
      code: 'AuthFailure.InvalidAuthorization',
      RequestId: 'signed-secret-url',
    },
  ]) {
    for (const flat of [true, false]) {
      const { base, calls, diagnostics } = await startHunyuan(context, {
        provider: {
          flat,
          submitStatus: 400,
          submitBody: { ...body, Message: 'test-hunyuan-key private payload' },
          responseHeaders: { 'X-Request-Id': publicRequestId },
        },
      });
      const { payload: job } = await submit(base);
      const failed = await terminal(base, job);
      assert.equal(failed.error.message, 'provider_auth_failed');
      assert.deepEqual(failed.error.diagnostic, {
        provider: 'hunyuan',
        stage: 'submit',
        httpStatus: 400,
        providerCode: 'AuthFailure.InvalidAuthorization',
        requestId: publicRequestId,
      });
      assert.equal((await submit(base)).payload.jobId, job.jobId);
      assert.equal(calls.length, 1);
      assert.doesNotMatch(
        JSON.stringify({ failed, diagnostics }),
        /test-hunyuan-key|private payload|signed-secret-url/,
      );
    }
  }
});

test('Hunyuan preserves an outer-envelope RequestId when the nested error ID is unusable', async (context) => {
  const mock = hunyuanProvider();
  mock.fetcher = async (url) => {
    mock.calls.push(url);
    return Response.json(
      {
        Response: { Error: { Code: 'UnauthorizedOperation' }, RequestId: 'private-detail' },
        RequestId: publicRequestId,
      },
      { status: 400 },
    );
  };
  const { base, calls, diagnostics } = await start(context, {
    mock,
    service: { providerName: 'hunyuan', apiKey: 'test-hunyuan-key' },
  });
  const { payload: job } = await submit(base);
  const failed = await terminal(base, job);
  assert.equal(failed.error.message, 'provider_access_denied');
  assert.equal(failed.error.diagnostic.requestId, publicRequestId);
  assert.equal((await submit(base)).payload.jobId, job.jobId);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify({ failed, diagnostics }), /private-detail/);
});

test('Hunyuan keeps safe header RequestIds for unreadable responses without retrying paid submissions', async (context) => {
  for (const status of [200, 400, 429, 503]) {
    const { base, calls, diagnostics } = await startHunyuan(context, {
      provider: {
        submitStatus: status,
        responseHeaders: { 'X-TC-RequestId': publicRequestId, Authorization: 'test-hunyuan-key' },
      },
    });
    const { payload: job } = await submit(base);
    const failed = await terminal(base, job);
    assert.equal(
      failed.error.message,
      status === 400 ? 'provider_rejected' : 'submission_uncertain',
    );
    assert.deepEqual(failed.error.diagnostic, {
      provider: 'hunyuan',
      stage: 'submit',
      httpStatus: status,
      requestId: publicRequestId,
    });
    assert.equal((await submit(base)).payload.jobId, job.jobId);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(
      JSON.stringify({ failed, diagnostics }),
      /test-hunyuan-key|upstream detail/,
    );
  }
});

test('Hunyuan sanitizes header IDs and skips credential-shaped UUIDs before fallback', async (context) => {
  const secretUuid = 'b5b41468-520d-4192-b42f-595cc34b6c1c';
  for (const [apiKey, headers, expected] of [
    [
      'test-hunyuan-key',
      { 'X-TC-RequestId': 'test-hunyuan-key', 'X-Request-Id': 'https://example.com/?sign=private' },
      undefined,
    ],
    [
      secretUuid,
      { 'X-TC-RequestId': secretUuid, 'X-Request-Id': publicRequestId },
      publicRequestId,
    ],
    [
      'test-hunyuan-key',
      { 'X-TC-RequestId': accessToken, 'X-Request-Id': publicRequestId },
      publicRequestId,
    ],
    ['test-hunyuan-key', { 'X-TC-RequestId': publicRequestId + '-extra' }, undefined],
  ]) {
    const mock = {
      calls: [],
      async fetcher(url) {
        this.calls.push(url);
        return new Response('private message', { status: 400, headers });
      },
    };
    const { base, calls, diagnostics } = await start(context, {
      mock: { calls: mock.calls, fetcher: mock.fetcher.bind(mock) },
      service: { providerName: 'hunyuan', apiKey },
    });
    const { payload: job } = await submit(base);
    const failed = await terminal(base, job);
    assert.deepEqual(failed.error.diagnostic, {
      provider: 'hunyuan',
      stage: 'submit',
      httpStatus: 400,
      ...(expected ? { requestId: expected } : {}),
    });
    assert.equal((await submit(base)).payload.jobId, job.jobId);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(
      JSON.stringify({ failed, diagnostics }),
      /test-hunyuan-key|b5b41468|private|example.com|test-backend-access-token/,
    );
  }
});

test('Hunyuan paid 429/5xx stays uncertain even with a misleading known auth error', async (context) => {
  for (const status of [429, 500, 503]) {
    const { base, calls } = await startHunyuan(context, {
      provider: {
        submitStatus: status,
        submitBody: {
          Error: { Code: 'AuthFailure.InvalidAuthorization' },
          RequestId: publicRequestId,
        },
      },
    });
    const { payload: job } = await submit(base);
    const failed = await terminal(base, job);
    assert.equal(failed.error.message, 'submission_uncertain');
    assert.equal(failed.error.diagnostic.httpStatus, status);
    assert.equal(failed.error.diagnostic.requestId, publicRequestId);
    assert.equal((await submit(base)).payload.jobId, job.jobId);
    assert.equal(calls.length, 1);
  }
});

test('Hunyuan drops private suffixes and secret-shaped fields from JSON and structured logs', async (context) => {
  for (const [code, requestId, safeCode] of [
    ['AuthFailure.test-hunyuan-key', publicRequestId + String.fromCharCode(10), 'AuthFailure'],
    ['test-hunyuan-key', 'https://example.com/?sign=test-hunyuan-key', undefined],
    ['data:image/png;base64,test-hunyuan-key', 'test-hunyuan-key', undefined],
  ]) {
    const { base, diagnostics } = await startHunyuan(context, {
      provider: {
        submitBody: {
          Error: { Code: code, Message: 'signed-secret-url' },
          RequestId: requestId,
          Authorization: 'test-hunyuan-key',
        },
      },
    });
    const { payload: job } = await submit(base);
    const failed = await terminal(base, job);
    assert.deepEqual(failed.error.diagnostic, {
      provider: 'hunyuan',
      stage: 'submit',
      httpStatus: 200,
      ...(safeCode ? { providerCode: safeCode } : {}),
    });
    assert.doesNotMatch(
      JSON.stringify({ failed, diagnostics }),
      /test-hunyuan-key|signed-secret-url|data:image|example.com/,
    );
  }
});

test('Hunyuan retries temporary query errors but never retries a task-level FAIL', async (context) => {
  const running = await startHunyuan(context, {
    provider: {
      queryResponses: [
        {
          status: 200,
          body: { Error: { Code: 'ServiceUnavailable' }, RequestId: publicRequestId },
        },
        { status: 429, body: { error: { code: 'RequestLimitExceeded' } } },
      ],
    },
  });
  const { payload: first } = await submit(running.base);
  assert.equal((await terminal(running.base, first)).status, 'succeeded');
  assert.equal(running.calls.filter((call) => call.url.endsWith('/submit')).length, 1);
  assert.equal(running.diagnostics.length, 0);
  for (const code of ['ServiceUnavailable', 'ResourceInsufficient']) {
    const { base, calls } = await startHunyuan(context, {
      provider: {
        queryBody: {
          Status: 'FAIL',
          ErrorCode: code,
          ErrorMessage: 'test-hunyuan-key',
          RequestId: publicRequestId,
        },
      },
    });
    const { payload: job } = await submit(base);
    const failed = await terminal(base, job);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.providerTaskId, hunyuanJobId);
    assert.equal(failed.error.diagnostic.stage, 'query');
    assert.equal(failed.error.diagnostic.providerCode, code);
    assert.equal(failed.error.diagnostic.requestId, publicRequestId);
    assert.equal(calls.filter((call) => call.url.endsWith('/query')).length, 1);
  }
});

test('query timeout preserves the last safe upstream diagnostic without paid resubmission', async (context) => {
  const { base, calls } = await startHunyuan(context, {
    service: { timeout: 180 },
    provider: {
      queryStatus: 503,
      queryBody: { Error: { Code: 'ServiceUnavailable' }, RequestId: publicRequestId },
    },
  });
  const { payload: job } = await submit(base);
  const failed = await terminal(base, job);
  assert.equal(failed.error.message, 'timed_out');
  assert.deepEqual(failed.error.diagnostic, {
    provider: 'hunyuan',
    stage: 'query',
    httpStatus: 503,
    providerCode: 'ServiceUnavailable',
    requestId: publicRequestId,
  });
  assert.equal(calls.filter((call) => call.url.endsWith('/submit')).length, 1);
});

test('Tripo HTTP errors retain upload/submit/query stages and numeric codes only', async (context) => {
  for (const [path, stage, status, expected] of [
    ['/files', 'upload', 401, 'provider_auth_failed'],
    ['/generation/multiview-to-model', 'submit', 400, 'provider_rejected'],
    ['/tasks/test-task-123', 'query', 403, 'provider_access_denied'],
  ]) {
    const mock = provider();
    const fetcher = mock.fetcher;
    mock.fetcher = async (url, init) => {
      if (!url.endsWith(path)) return fetcher(url, init);
      mock.calls.push({ url, init });
      return Response.json(
        { code: 1234, message: 'test-tripo-key signed-secret-url', request_id: publicRequestId },
        { status },
      );
    };
    const { base, diagnostics } = await start(context, { mock });
    const { payload: job } = await submit(base);
    const failed = await terminal(base, job);
    assert.equal(failed.error.message, expected);
    assert.deepEqual(failed.error.diagnostic, {
      provider: 'tripo',
      stage,
      httpStatus: status,
      providerCode: 1234,
      requestId: publicRequestId,
    });
    assert.doesNotMatch(
      JSON.stringify({ failed, diagnostics }),
      /test-tripo-key|signed-secret-url/,
    );
    assert.equal(
      mock.calls.filter((call) => call.url.endsWith('/generation/multiview-to-model')).length,
      stage === 'upload' ? 0 : 1,
    );
  }
});

test('download errors identify the download stage without exposing signed URLs, and logging failures are harmless', async (context) => {
  const { base } = await startHunyuan(context, {
    provider: { downloadRedirect: true },
    service: {
      onDiagnostic() {
        throw Error('logging unavailable');
      },
    },
  });
  const { payload: job } = await submit(base);
  const failed = await terminal(base, job);
  assert.equal(failed.error.message, 'provider_unavailable');
  assert.deepEqual(failed.error.diagnostic, {
    provider: 'hunyuan',
    stage: 'download',
    httpStatus: 302,
  });
  assert.doesNotMatch(JSON.stringify(failed), /mock-signature|test-hunyuan-key|127.0.0.1/);
});
