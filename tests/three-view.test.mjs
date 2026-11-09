import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { modelFixture } from './helpers/model-fixture.mjs';
import { MAX_MODEL_BYTES, validateGlb } from '../shared/model-contract.mjs';

const vite = await createServer({
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  appType: 'custom',
});
after(() => vite.close());
const views = await vite.ssrLoadModule('/src/three-view.ts');
const model = await vite.ssrLoadModule('/src/model-generation.ts');
const crop = await vite.ssrLoadModule('/src/three-view-crop.ts');
const history = await vite.ssrLoadModule('/src/generation-history.ts');
const { GenerationStudio } = await vite.ssrLoadModule('/src/generation-studio.tsx');
const references = ['character', 'costume', 'pose'].map((kind) => ({
  kind,
  title: { zh: kind, en: kind },
  keywords: { zh: '', en: '' },
  variant: { id: kind, original: 'https://example.com/image.png' },
}));

test('viewer loads selected GLB eagerly instead of timing out while outside the viewport', () => {
  const source = readFileSync(new URL('../src/model-viewport.tsx', import.meta.url), 'utf8');
  assert.match(source, /loading: 'eager'/);
  assert.match(source, /import\('@google\/model-viewer'\)/);
  assert.doesNotMatch(source, /^import ['"]@google\/model-viewer/m);
});

test('three-view sizes only permit supported wide canvases', () => {
  assert.deepEqual(views.threeViewSizes, ['1536x864', '1536x1024']);
  for (const size of ['auto', '1024x1024', '864x1536', '1536x1152', 'unknown']) {
    assert.equal(views.isThreeViewSize(size), false);
    assert.equal(views.resolveThreeViewSize(size), '1536x864');
  }
  assert.equal(views.resolveThreeViewSize('1536x1024'), '1536x1024');
});

test('three-view prompt is separate, consistent, full body and not bound to complex poses', () => {
  const chinese = views.threeViewPrompt(references, 'zh');
  assert.match(chinese, /正面.*左侧.*背面/);
  assert.match(chinese, /同一套服饰和鞋履/);
  assert.match(chinese, /头部到鞋底/);
  assert.match(chinese, /不沿用此图的动作/);
  assert.match(chinese, /一张横向三视图拼图/);
  assert.doesNotMatch(chinese, /最终输出只有一张连续画面|禁止多面板|仅采用此图当前展示的动作/);
  const english = views.threeViewPrompt(references, 'en');
  assert.match(english, /FRONT.*LEFT PROFILE.*BACK/);
  assert.match(english, /head-to-sole/);
  assert.match(english, /same person/);
});

test('three-view prompts require hyperrealistic materials and do not inherit reference art styles', () => {
  const chinese = views.threeViewPrompt(references, 'zh');
  assert.match(chinese, /超写实、摄影级真实感/);
  for (const detail of [
    '皮肤微纹理',
    '真实发丝',
    '织物纤维与缝线',
    '皮革纹理',
    '金属反射',
    '柔和漫射棚光',
    '全身清晰',
  ])
    assert.ok(chinese.includes(detail), detail);
  assert.match(chinese, /不复制原图的动作、裁切或画风/);
  assert.match(chinese, /不继承插画画风/);
  assert.match(chinese, /不得输出动漫、卡通、插画/);
  assert.doesNotMatch(chinese, /体型与画风/);
  const english = views.threeViewPrompt(references, 'en');
  for (const detail of [
    'hyperrealistic',
    'photographic-quality',
    'skin microtexture',
    'hair strands',
    'fabric fibers',
    'leather grain',
    'diffuse studio lighting',
    'full body in focus',
  ])
    assert.ok(english.includes(detail), detail);
  assert.match(english, /not the source pose, crop or art style/);
  assert.match(english, /No anime, cartoon, illustration/);
  assert.doesNotMatch(english, /build and style/);
});

test('fixed three-view style covers supplemental, custom and legacy prompts without enabling empty drafts', () => {
  for (const lang of ['zh', 'en']) {
    for (const draft of [
      views.threeViewPrompt(references, lang),
      views.threeViewPrompt(references, lang) + '\nAnime style',
      'Custom cartoon prompt',
      'Legacy illustration prompt',
    ]) {
      const enforced = views.enforceThreeViewStyle(draft, lang);
      assert.ok(enforced.startsWith(draft));
      assert.match(
        enforced,
        lang === 'zh'
          ? /三视图最终风格固定为超写实摄影级效果/
          : /final three-view output must use a hyperrealistic/,
      );
      assert.match(
        enforced,
        lang === 'zh' ? /优先于参考图原画风/ : /overrides conflicting reference art styles/,
      );
      assert.equal(views.enforceThreeViewStyle(enforced, lang), enforced);
      assert.equal(views.enforceThreeViewStyle(enforced + '  \n', lang), enforced);
    }
    for (const empty of ['', '  \n']) assert.equal(views.enforceThreeViewStyle(empty, lang), empty);
  }
});

test('crop validation handles boundaries, floating thirds, small images, missing and invalid numbers', () => {
  const defaults = views.defaultThreeViewCrops();
  assert.equal(views.validateThreeViewCrops(defaults, 1536, 864), null);
  assert.deepEqual(views.cropPixels(defaults.back, 1536, 864), {
    left: 1024,
    top: 0,
    width: 512,
    height: 864,
  });
  assert.equal(views.validateThreeViewCrops(defaults, 600, 864), 'cropTooSmall');
  assert.equal(views.validateThreeViewCrops(defaults, 900, 9000), 'cropTooSmall');
  assert.equal(views.validateThreeViewCrops(defaults, 0, 864), 'invalidCrop');
  assert.equal(
    views.validateThreeViewCrops({ ...defaults, front: undefined }, 1536, 864),
    'invalidCrop',
  );
  for (const value of [NaN, Infinity, -0.01, 1])
    assert.equal(
      views.validateThreeViewCrops(
        { ...defaults, front: { ...defaults.front, x: value } },
        1536,
        864,
      ),
      'invalidCrop',
    );
  assert.equal(
    views.validateThreeViewCrops({ ...defaults, side: { ...defaults.side, x: 0.3 } }, 1536, 864),
    'cropOverlap',
  );
  const changed = views.defaultThreeViewCrops();
  changed.front.x = 0.1;
  assert.equal(defaults.front.x, 0);
});

test('three-view studio and old single-image results render without browser or 3D side effects', () => {
  for (const threeView of [true, false]) {
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(GenerationStudio, {
        lang: 'zh',
        references: [],
        items: [],
        job: {
          status: 'success',
          result: 'data:image/png;base64,AA==',
          model: 'test',
          size: '1536x864',
          references: [],
          threeView,
        },
        config: {
          baseUrl: '',
          apiKey: '',
          model: 'gpt-image-2',
          size: '864x1536',
          quality: 'auto',
        },
        characterLoading: false,
        characterError: '',
        poseDepth: false,
        onDepth: noop,
        onChoose: noop,
        onRemove: noop,
        onAngle: noop,
        onUpload: noop,
        onOpenCostumeUpload: noop,
        onSettings: noop,
        onRun: noop,
        onCancel: noop,
        onRestore: noop,
        notify: noop,
      }),
    );
    const select = html.match(/<select id="studio-size"[^>]*>(.*?)<\/select>/)?.[1];
    assert.ok(select);
    assert.match(select, /1536x864/);
    assert.equal(select.includes('864x1536'), !threeView);
    assert.equal(html.includes('确认三张建模参考图'), threeView);
    const styles = html.match(/<div class="studio-styles">(.*?)<\/div>/)?.[1];
    assert.ok(styles);
    assert.equal((styles.match(/<button/g) || []).length, threeView ? 1 : 4);
    if (threeView) {
      assert.match(styles, /aria-pressed="true" disabled=""/);
      assert.match(styles, /超写实（固定）/);
      assert.match(html, /补充或自定义提示词不改变固定风格/);
    } else {
      assert.doesNotMatch(styles, /超写实（固定）/);
      assert.doesNotMatch(html, /studio-three-view-style-hint/);
    }
    assert.doesNotMatch(html, /<model-viewer/);
    assert.match(html, /studio-canvas/);
  }
});

test('GLB contract rejects corrupted, oversized and externally referenced assets', async () => {
  const valid = modelFixture();
  assert.equal(validateGlb(valid), valid);
  for (const bytes of [
    new Uint8Array(),
    valid.subarray(0, 20),
    valid.subarray(0, valid.length - 1),
    modelFixture({ images: [{ uri: 'https://evil.example/texture.png' }] }),
    modelFixture({ buffers: [{ uri: 'file:///secret', byteLength: 0 }] }),
    modelFixture({ meshes: [] }),
    new Uint8Array(MAX_MODEL_BYTES + 1),
  ])
    assert.throws(() => validateGlb(bytes), /invalid_model/);
  const corrupt = Buffer.from(valid);
  corrupt.writeUInt32LE(1, 4);
  assert.throws(() => validateGlb(corrupt), /invalid_model/);
  const blob = await model.readModelBlob(new Blob([valid]));
  assert.equal(blob.type, 'model/gltf-binary');
  await assert.rejects(model.readModelBlob(new Blob(['not a model'])), /invalid_model/);
});

test('model backend URL excludes remote HTTP, credentials, query and fragment', () => {
  assert.equal(
    model.modelApiBase('http://127.0.0.1:8788/api/', 'https://site.example'),
    'http://127.0.0.1:8788/api',
  );
  assert.equal(model.modelApiBase('/api', 'https://site.example'), 'https://site.example/api');
  for (const url of [
    '',
    'http://remote.example/api',
    'https://key@remote.example/api',
    'https://remote.example/api?q=secret',
    'https://remote.example/api#secret',
    'file:///api',
  ])
    assert.throws(() => model.modelApiBase(url, 'https://site.example'), /invalidService/);
});

test('three-view reads cap declared and streamed bytes without changing ordinary history reads', async (context) => {
  const previous = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { href: 'https://site.example' } };
  context.after(() => {
    globalThis.fetch = previous;
    globalThis.window = previousWindow;
  });
  const url = 'https://images.example/large.png';
  globalThis.fetch = async () =>
    new Response('x', { headers: { 'Content-Type': 'image/png', 'Content-Length': '101' } });
  await assert.rejects(history.readResultBlob(url, undefined, 100), /invalidResult/);
  globalThis.fetch = async () =>
    new Response('123456', { headers: { 'Content-Type': 'image/png' } });
  await assert.rejects(history.readResultBlob(url, undefined, 5), /invalidResult/);
  assert.equal((await history.readResultBlob(url, undefined, 6)).size, 6);
  assert.equal((await history.readResultBlob(url)).size, 6);
});

test('cropping exports three bounded PNGs without stretching or losing edges', async (context) => {
  const previous = globalThis.document;
  context.after(() => {
    globalThis.document = previous;
  });
  const drawn = [];
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillRect() {}, drawImage: (...args) => drawn.push(args) }),
      toBlob: (callback) => callback(new Blob(['png'], { type: 'image/png' })),
    }),
  };
  const images = await crop.cropThreeViewImages(
    { width: 1536, height: 864, image: {} },
    views.defaultThreeViewCrops(),
    new AbortController().signal,
  );
  assert.deepEqual(Object.keys(images), ['front', 'side', 'back']);
  assert.deepEqual(
    drawn.map((args) => args.slice(1, 5)),
    [
      [0, 0, 512, 864],
      [512, 0, 512, 864],
      [1024, 0, 512, 864],
    ],
  );
  assert.deepEqual(
    drawn.map((args) => args.slice(5)),
    [
      [0, 0, 512, 864],
      [0, 0, 512, 864],
      [0, 0, 512, 864],
    ],
  );
  await assert.rejects(
    crop.cropThreeViewImages(
      { width: 1536, height: 864, image: {} },
      views.defaultThreeViewCrops(),
      AbortSignal.abort(),
    ),
  );
});

const config = { apiUrl: 'https://backend.example/api', accessToken: 'test-access' };
const images = { front: new Blob(['png']), side: new Blob(['png']), back: new Blob(['png']) };
const taskId = '11111111-1111-4111-8111-111111111111';
const response = (value) => Response.json(value);

test('model client reconnects to the same task after a network failure without a second submission', async (context) => {
  const previousFetch = globalThis.fetch,
    previousLocation = globalThis.location;
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.location = previousLocation;
  });
  globalThis.location = { origin: 'https://site.example' };
  const calls = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return response({ jobId: taskId, jobToken: 'a'.repeat(64) });
    if (url.endsWith('/result')) return new Response(modelFixture());
    if (++polls === 1) throw Error('network lost');
    return response({ status: 'succeeded', progress: 100 });
  };
  const request = { requestId: 'same-request-id-123' };
  await assert.rejects(
    model.generateThreeViewModel(
      config,
      images,
      'left',
      request,
      new AbortController().signal,
      () => {},
    ),
    /network_failed/,
  );
  assert.equal(request.session.jobId, taskId);
  const result = await model.generateThreeViewModel(
    config,
    images,
    'left',
    request,
    new AbortController().signal,
    () => {},
  );
  assert.equal(result.type, 'model/gltf-binary');
  assert.equal(calls.filter((call) => call.init.method === 'POST').length, 1);
  assert.equal(calls[0].init.headers['X-Idempotency-Key'], request.requestId);
  assert.equal(calls[0].init.body.get('sideView'), 'left');
  assert.equal(request.finished, true);
});

test('model client retains the idempotency key if submission response is lost', async (context) => {
  const previousFetch = globalThis.fetch,
    previousLocation = globalThis.location;
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.location = previousLocation;
  });
  globalThis.location = { origin: 'https://site.example' };
  const keys = [];
  globalThis.fetch = async (url, init) => {
    if (init.method === 'POST') {
      keys.push(init.headers['X-Idempotency-Key']);
      if (keys.length === 1) throw Error('response lost');
      return response({ jobId: taskId, jobToken: 'a'.repeat(64) });
    }
    return url.endsWith('/result')
      ? new Response(modelFixture())
      : response({ status: 'succeeded', progress: 100 });
  };
  const request = { requestId: 'submission-id-12345' };
  await assert.rejects(
    model.generateThreeViewModel(
      config,
      images,
      'right',
      request,
      new AbortController().signal,
      () => {},
    ),
    /network_failed/,
  );
  await model.generateThreeViewModel(
    config,
    images,
    'right',
    request,
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(keys, ['submission-id-12345', 'submission-id-12345']);
});

test('client cancellation attempts a scoped backend cancel and terminal failure is never resubmitted', async (context) => {
  const previousFetch = globalThis.fetch,
    previousLocation = globalThis.location;
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.location = previousLocation;
  });
  globalThis.location = { origin: 'https://site.example' };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return response({ jobId: taskId, jobToken: 'a'.repeat(64) });
    return response({ status: 'queued', progress: 0 });
  };
  const abort = new AbortController();
  await assert.rejects(
    model.generateThreeViewModel(
      config,
      images,
      'left',
      { requestId: 'cancel-id-1234567' },
      abort.signal,
      () => abort.abort(),
    ),
    /cancelled/,
  );
  assert.equal(calls.filter((call) => call.init.method === 'DELETE').length, 1);
  assert.equal(calls.at(-1).init.headers['X-Model-Job-Token'], 'a'.repeat(64));
  globalThis.fetch = async (_url, init) =>
    init.method === 'POST'
      ? response({ jobId: taskId, jobToken: 'a'.repeat(64) })
      : response({ status: 'failed', progress: 20, error: { message: 'submission_uncertain' } });
  const request = { requestId: 'failed-id-1234567' };
  await assert.rejects(
    model.generateThreeViewModel(
      config,
      images,
      'left',
      request,
      new AbortController().signal,
      () => {},
    ),
    /submission_uncertain/,
  );
  assert.equal(request.finished, true);
});

const safeDiagnostic = {
  provider: 'hunyuan',
  stage: 'submit',
  httpStatus: 400,
  providerCode: 'InvalidParameter',
  requestId: 'd1c706e5-d779-4a76-a882-75b6737f529c',
};

test('model diagnostic contract strips private, malformed and unknown fields at the client boundary', () => {
  const error = new model.ModelGenerationError('provider_invalid_request', {
    ...safeDiagnostic,
    Message: 'sk-private-key',
    Authorization: 'Bearer sk-private-key',
    image: 'data:image/png;base64,private',
    url: 'https://example.com/?sign=private',
  });
  assert.deepEqual(error.diagnostic, safeDiagnostic);
  const hostile = new model.ModelGenerationError('provider_failed', {
    ...safeDiagnostic,
    httpStatus: '400',
    providerCode: 'InvalidParameter.sk-private-key',
    requestId: safeDiagnostic.requestId + String.fromCharCode(10),
  });
  assert.deepEqual(hostile.diagnostic, {
    provider: 'hunyuan',
    stage: 'submit',
    providerCode: 'InvalidParameter',
  });
  for (const value of [
    null,
    [],
    { ...safeDiagnostic, provider: 'sk-private-key' },
    { ...safeDiagnostic, stage: 'https://example.com/?sign=private' },
  ])
    assert.equal(new model.ModelGenerationError('provider_failed', value).diagnostic, undefined);
});

test('model diagnostics retain only a known public category for unknown Hunyuan subcodes', () => {
  for (const [rawCode, safeCode] of [
    ['ResourceUnavailable.NotExist', 'ResourceUnavailable'],
    ['AuthFailure.sk-private-key', 'AuthFailure'],
    ['InvalidParameter.private-detail', 'InvalidParameter'],
    ['AuthFailure.InvalidAuthorization', 'AuthFailure.InvalidAuthorization'],
    ['NotAPublicCode.sk-private-key', undefined],
    ['ResourceUnavailableNotExist', undefined],
    [null, undefined],
    [123, undefined],
  ]) {
    const error = new model.ModelGenerationError('provider_failed', {
      provider: 'hunyuan',
      stage: 'submit',
      providerCode: rawCode,
    });
    assert.deepEqual(error.diagnostic, {
      provider: 'hunyuan',
      stage: 'submit',
      ...(safeCode ? { providerCode: safeCode } : {}),
    });
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /sk-private-key|private-detail|NotExist/);
  }
});

test('model client carries safe terminal diagnostics and marks failure finished without resubmitting', async (context) => {
  const previousFetch = globalThis.fetch,
    previousLocation = globalThis.location;
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.location = previousLocation;
  });
  globalThis.location = { origin: 'https://site.example' };
  let submissions = 0;
  globalThis.fetch = async (_url, init) => {
    if (init.method === 'POST') {
      submissions++;
      return response({ jobId: taskId, jobToken: 'a'.repeat(64) });
    }
    return response({
      status: 'failed',
      progress: 0,
      provider: 'hunyuan',
      error: {
        message: 'provider_invalid_request',
        diagnostic: { ...safeDiagnostic, Message: 'sk-private-key' },
      },
    });
  };
  const request = { requestId: 'stable-diagnostic-request' },
    progress = [];
  await assert.rejects(
    model.generateThreeViewModel(
      config,
      images,
      'left',
      request,
      new AbortController().signal,
      (value) => progress.push(value),
    ),
    (error) => {
      assert.equal(error.code, 'provider_invalid_request');
      assert.deepEqual(error.diagnostic, safeDiagnostic);
      return true;
    },
  );
  assert.equal(submissions, 1);
  assert.equal(request.finished, true);
  assert.equal(progress[0].provider, 'hunyuan');
});

test('model client sanitizes diagnostics on HTTP failures and rejects raw terminal messages', async (context) => {
  const previousFetch = globalThis.fetch,
    previousLocation = globalThis.location;
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.location = previousLocation;
  });
  globalThis.location = { origin: 'https://site.example' };
  globalThis.fetch = async () =>
    Response.json(
      {
        error: {
          message: 'provider_invalid_request',
          diagnostic: { ...safeDiagnostic, Message: 'sk-private-key' },
        },
      },
      { status: 502 },
    );
  await assert.rejects(
    model.generateThreeViewModel(
      config,
      images,
      'left',
      { requestId: 'safe-request' },
      new AbortController().signal,
      () => {},
    ),
    (error) => {
      assert.equal(error.code, 'provider_invalid_request');
      assert.deepEqual(error.diagnostic, safeDiagnostic);
      return true;
    },
  );
  globalThis.fetch = async () =>
    response({
      status: 'failed',
      progress: 0,
      error: { message: 'sk-private-key https://example.com/?sign=private' },
    });
  await assert.rejects(
    model.generateThreeViewModel(
      config,
      images,
      'left',
      {
        requestId: 'safe-request',
        session: { jobId: taskId, jobToken: 'a'.repeat(64) },
      },
      new AbortController().signal,
      () => {},
    ),
    (error) => {
      assert.equal(error.code, 'unknown');
      assert.equal(error.diagnostic, undefined);
      return true;
    },
  );
});

test('model failure notice renders actionable bilingual diagnostics without reflecting arbitrary provider content', async () => {
  const { ModelFailureNotice } = await vite.ssrLoadModule('/src/three-view-result.tsx');
  for (const [lang, title, stage] of [
    ['zh', '脱敏诊断', '提交建模'],
    ['en', 'Safe diagnostics', 'Submit modeling'],
  ]) {
    const html = renderToStaticMarkup(
      createElement(ModelFailureNotice, {
        code: 'provider_invalid_request',
        diagnostic: safeDiagnostic,
        lang,
      }),
    );
    assert.match(html, /role="alert"/);
    assert.ok(html.includes(title));
    assert.ok(html.includes(stage));
    assert.match(html, /HTTP 400/);
    assert.match(html, /InvalidParameter/);
    assert.ok(html.includes(safeDiagnostic.requestId));
  }
  const html = renderToStaticMarkup(
    createElement(ModelFailureNotice, {
      code: 'provider_failed',
      lang: 'zh',
      diagnostic: {
        ...safeDiagnostic,
        providerCode: 'sk-private-key',
        requestId: 'https://example.com/?sign=private',
      },
    }),
  );
  assert.doesNotMatch(html, /sk-private-key|example.com|RequestId/);
  for (const code of ['constructor', '__proto__', 'toString']) {
    const notice = renderToStaticMarkup(createElement(ModelFailureNotice, { code, lang: 'zh' }));
    assert.ok(notice.includes('建模失败'));
  }
});

test('an unclassified HTTP 400 notice does not assert invalid parameters in either language', async () => {
  const { ModelFailureNotice } = await vite.ssrLoadModule('/src/three-view-result.tsx');
  for (const [lang, expected] of [
    ['zh', '不能仅凭 HTTP 400 判断是参数错误'],
    ['en', 'HTTP 400 alone does not prove invalid parameters'],
  ]) {
    const html = renderToStaticMarkup(
      createElement(ModelFailureNotice, {
        code: 'provider_rejected',
        diagnostic: { provider: 'hunyuan', stage: 'submit', httpStatus: 400 },
        lang,
      }),
    );
    assert.ok(html.includes(expected));
    assert.doesNotMatch(html, /InvalidParameter|RequestId/);
  }
});
