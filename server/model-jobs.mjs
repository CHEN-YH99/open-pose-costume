import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import sharp from 'sharp';
import {
  MAX_MODEL_BYTES,
  sanitizeModelDiagnostic,
  validateGlb,
} from '../shared/model-contract.mjs';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_BYTES = 3 * MAX_UPLOAD_BYTES + 64 * 1024;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const API_ORIGINS = {
  tripo: new Set(['https://openapi.tripo3d.ai', 'https://openapi.tripo3d.com']),
  hunyuan: new Set(['https://api.ai3d.cloud.tencent.com']),
};
const HUNYUAN_RESULT_HOST = 'hunyuan-prod-1258344699.cos.ap-guangzhou.tencentcos.cn';
const MAX_HUNYUAN_BASE64_BYTES = 8 * 1024 * 1024;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

class ModelApiError extends Error {
  constructor(status, code, diagnostic) {
    super(code);
    this.status = status;
    this.code = code;
    this.diagnostic = sanitizeModelDiagnostic(diagnostic);
  }
}

const hash = (value) => createHash('sha256').update(value).digest();
const matches = (expected, supplied = '') =>
  typeof supplied === 'string' && timingSafeEqual(hash(expected), hash(supplied));

async function readLimitedBody(body, limit) {
  if (!body) throw new ModelApiError(502, 'provider_unavailable');
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > limit) throw new ModelApiError(413, 'request_too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createModelJobService({
  providerName = process.env.MODEL_PROVIDER || 'tripo',
  apiKey = (providerName === 'hunyuan' ? process.env.HUNYUAN_API_KEY : process.env.TRIPO_API_KEY) ||
    '',
  accessToken = process.env.MODEL_ACCESS_TOKEN || '',
  apiOrigin = providerName === 'hunyuan'
    ? process.env.HUNYUAN_API_ORIGIN || 'https://api.ai3d.cloud.tencent.com'
    : process.env.TRIPO_API_ORIGIN || 'https://openapi.tripo3d.ai',
  model = providerName === 'hunyuan'
    ? process.env.HUNYUAN_MODEL || '3.0'
    : process.env.TRIPO_MODEL || 'v3.1-20260211',
  allowedOrigins = (
    process.env.MODEL_ALLOWED_ORIGINS ||
    'http://127.0.0.1:5199,http://localhost:5199,http://127.0.0.1:5200,http://localhost:5200,https://chen-yh99.github.io'
  ).split(','),
  resultHosts = (
    process.env.MODEL_RESULT_HOSTS ||
    (providerName === 'hunyuan' ? HUNYUAN_RESULT_HOST : 'cdn.tripo3d.ai,cdn.tripo3d.com')
  ).split(','),
  fetcher = fetch,
  pollInterval = 2_000,
  timeout = 12 * 60_000,
  ttl = 30 * 60_000,
  maxJobs = 8,
  maxPending = 4,
  onDiagnostic = (record) => console.warn('[model-jobs]', JSON.stringify(record)),
} = {}) {
  const origins = new Set(allowedOrigins.map((value) => value.trim()).filter(Boolean));
  const hosts = new Set(resultHosts.map((value) => value.trim().toLowerCase()).filter(Boolean));
  const isHunyuan = providerName === 'hunyuan';
  const enabled =
    typeof apiKey === 'string' &&
    !!apiKey.trim() &&
    !/[\r\n]/.test(apiKey) &&
    typeof accessToken === 'string' &&
    accessToken.length >= 32 &&
    ['tripo', 'hunyuan'].includes(providerName) &&
    API_ORIGINS[providerName].has(apiOrigin) &&
    (isHunyuan ? ['3.0', '3.1'].includes(model) : /^[a-zA-Z0-9._-]{1,80}$/.test(model));
  const jobs = new Map();
  const queue = [];
  let active = false;
  let validating = 0;
  let closed = false;

  function cleanup() {
    const cutoff = Date.now() - ttl;
    for (const [id, job] of jobs)
      if (TERMINAL.has(job.status) && job.updatedAt < cutoff) jobs.delete(id);
  }

  function makeRoom(bytes = 0) {
    const removable = [...jobs.values()]
      .filter((job) => TERMINAL.has(job.status))
      .sort((first, second) => first.updatedAt - second.updatedAt);
    let cached = [...jobs.values()].reduce((sum, job) => sum + (job.result?.length || 0), 0);
    while ((jobs.size >= maxJobs || cached + bytes > MAX_CACHE_BYTES) && removable.length) {
      const old = removable.shift();
      cached -= old.result?.length || 0;
      jobs.delete(old.id);
    }
  }

  function payload(job) {
    return {
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      provider: providerName,
      ...(job.error ? { error: { message: job.error, diagnostic: job.diagnostic } } : {}),
      ...(job.taskId ? { providerTaskId: job.taskId } : {}),
    };
  }

  function diagnostic(stage, httpStatus, data, { envelope, headers } = {}) {
    const context = { provider: providerName, stage, httpStatus };
    const safe = sanitizeModelDiagnostic(context);
    const sources = data === envelope ? [data] : [data, envelope];
    const codes = isHunyuan
      ? sources.flatMap((source) => [
          source?.Error?.Code,
          source?.error?.code,
          source?.ErrorCode,
          source?.Code,
          source?.code,
        ])
      : [data?.code];
    // Sanitize each candidate before choosing it: a private/unknown field must
    // neither leak nor hide a later public error code or valid request ID.
    for (const providerCode of codes) {
      const candidate = sanitizeModelDiagnostic({ ...context, providerCode });
      if (candidate?.providerCode !== undefined) {
        safe.providerCode = candidate.providerCode;
        break;
      }
    }
    const ids = [
      ...sources.flatMap((source) => [
        source?.RequestId,
        source?.request_id,
        source?.Error?.RequestId,
        source?.error?.request_id,
      ]),
      headers?.get('x-tc-requestid'),
      headers?.get('x-request-id'),
    ];
    for (const requestId of ids) {
      const candidate = sanitizeModelDiagnostic({ ...context, requestId });
      if (candidate?.requestId && requestId !== apiKey && requestId !== accessToken) {
        safe.requestId = candidate.requestId;
        break;
      }
    }
    return safe;
  }

  function providerError(info) {
    if (info?.httpStatus >= 500) return new ModelApiError(502, 'provider_unavailable', info);
    if (info?.httpStatus === 429) return new ModelApiError(502, 'provider_rate_limited', info);
    const code = typeof info?.providerCode === 'string' ? info.providerCode : '';
    const root = code.split('.')[0];
    let error = 'provider_failed';
    // Hunyuan may use HTTP 400 for business errors unrelated to parameters.
    // Prefer its safe public code/category over a generic HTTP-status fallback.
    if (
      ['UnauthorizedOperation', 'IpInBlacklist', 'IpNotInWhitelist'].includes(root) ||
      code === 'AuthFailure.UnauthorizedOperation'
    )
      error = 'provider_access_denied';
    else if (root === 'AuthFailure') error = 'provider_auth_failed';
    else if (['ResourceInsufficient', 'LimitExceeded', 'ResourceInUse'].includes(root))
      error = 'provider_resource_limited';
    else if (root === 'RequestLimitExceeded') error = 'provider_rate_limited';
    else if (
      [
        'InvalidParameter',
        'InvalidParameterValue',
        'InvalidRequest',
        'MissingParameter',
        'UnknownParameter',
        'RequestSizeLimitExceeded',
      ].includes(root)
    )
      error = 'provider_invalid_request';
    else if (
      [
        'ActionOffline',
        'NoSuchProduct',
        'NoSuchVersion',
        'InvalidAction',
        'UnsupportedOperation',
        'UnsupportedRegion',
      ].includes(root)
    )
      error = 'provider_access_denied';
    else if (['InternalError', 'ServiceUnavailable', 'ResourceUnavailable'].includes(root))
      error = 'provider_unavailable';
    else if (!code || !isHunyuan) {
      if (info?.httpStatus === 403) error = 'provider_access_denied';
      else if (info?.httpStatus === 401) error = 'provider_auth_failed';
      else if (info?.httpStatus === 402) error = 'provider_resource_limited';
      else if (info?.httpStatus === 400) error = 'provider_rejected';
    }
    return new ModelApiError(502, error, info);
  }

  async function provider(path, options, signal, stage) {
    let response;
    try {
      response = await fetcher(apiOrigin + (isHunyuan ? '/v1/ai3d' : '/v3') + path, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        headers: { Authorization: isHunyuan ? apiKey : 'Bearer ' + apiKey, ...options.headers },
      });
    } catch {
      throw new ModelApiError(502, 'provider_unavailable', diagnostic(stage));
    }
    let value;
    try {
      value = JSON.parse((await readLimitedBody(response.body, 512 * 1024)).toString());
    } catch {
      const info = diagnostic(stage, response.status, undefined, { headers: response.headers });
      throw response.ok
        ? new ModelApiError(502, 'provider_unavailable', info)
        : providerError(info);
    }
    const data = isHunyuan ? (value?.Response ?? value) : value;
    const info = diagnostic(stage, response.status, data, {
      envelope: value,
      headers: response.headers,
    });
    if (!response.ok) throw providerError(info);
    if (isHunyuan) {
      // Compatible responses may be enveloped or flat. Raw error messages stay private.
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.Error || data.error)
        throw providerError(info);
      return { data, diagnostic: info };
    }
    if (value?.code !== 0 || !value.data) throw providerError(info);
    return { data: value.data, diagnostic: info };
  }

  async function modelBytes(source, signal) {
    let url;
    try {
      url = new URL(source);
    } catch {
      throw new ModelApiError(502, 'invalid_model');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      isIP(url.hostname) ||
      !hosts.has(url.hostname.toLowerCase())
    )
      throw new ModelApiError(502, 'invalid_model');
    let response;
    try {
      response = await fetcher(url.href, {
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
        headers: { Accept: 'model/gltf-binary,application/octet-stream' },
      });
    } catch {
      throw new ModelApiError(502, 'provider_unavailable');
    }
    if (!response.ok)
      throw new ModelApiError(502, 'provider_unavailable', diagnostic('download', response.status));
    if (Number(response.headers.get('content-length') || 0) > MAX_MODEL_BYTES)
      throw new ModelApiError(502, 'invalid_model', diagnostic('download', response.status));
    try {
      return Buffer.from(validateGlb(await readLimitedBody(response.body, MAX_MODEL_BYTES)));
    } catch {
      throw new ModelApiError(502, 'invalid_model', diagnostic('download', response.status));
    }
  }

  async function paidSubmission(path, body, signal) {
    try {
      return await provider(
        path,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        signal,
        'submit',
      );
    } catch (error) {
      // HTTP 429/5xx and unreadable responses may still have created a paid task.
      const info = error.diagnostic;
      if (
        error instanceof ModelApiError &&
        (error.code !== 'provider_unavailable' ||
          (info?.httpStatus === 400 && info?.providerCode)) &&
        info?.httpStatus !== 429 &&
        !(info?.httpStatus >= 500)
      )
        throw error;
      throw new ModelApiError(502, 'submission_uncertain', info || diagnostic('submit'));
    }
  }

  async function submitToProvider(job, signal) {
    if (isHunyuan) {
      signal.throwIfAborted();
      job.stage = 'submit';
      const submitted = await paidSubmission(
        '/submit',
        {
          Model: model,
          // The compatible interface documents ImageUrl.Url as a URL or data URL.
          ImageUrl: { Url: PNG_DATA_URL_PREFIX + job.images.front.toString('base64') },
          MultiViewImages: ['side', 'back'].map((field) => ({
            ViewType: field === 'side' ? job.sideView : field,
            ViewImageBase64: job.images[field].toString('base64'),
          })),
          // Default Normal already returns GLB + OBJ. Do not request paid add-ons.
        },
        signal,
      );
      return { taskId: submitted.data.JobId, diagnostic: submitted.diagnostic };
    }
    const inputs = [];
    for (const [index, field] of ['front', 'side', 'back'].entries()) {
      signal.throwIfAborted();
      const form = new FormData();
      form.set('file', new Blob([job.images[field]], { type: 'image/png' }), field + '.png');
      const { data: uploaded, diagnostic: info } = await provider(
        '/files',
        { method: 'POST', body: form },
        signal,
        'upload',
      );
      if (
        typeof uploaded.file_token !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,256}$/.test(uploaded.file_token)
      )
        throw new ModelApiError(502, 'provider_failed', info);
      inputs.push({
        [field === 'side' ? job.sideView : field]: { file_token: uploaded.file_token },
      });
      job.progress = (index + 1) * 5;
    }
    signal.throwIfAborted();
    job.stage = 'submit';
    const submitted = await paidSubmission(
      '/generation/multiview-to-model',
      {
        inputs,
        model,
        texture: true,
        pbr: true,
        face_limit: 30_000,
        texture_quality: 'standard',
      },
      signal,
    );
    return { taskId: submitted.data.task_id, diagnostic: submitted.diagnostic };
  }

  async function queryProvider(taskId, signal) {
    const { data: result, diagnostic: info } = await provider(
      isHunyuan ? '/query' : '/tasks/' + encodeURIComponent(taskId),
      isHunyuan
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ JobId: taskId }),
          }
        : { method: 'GET' },
      signal,
      'query',
    );
    if (!isHunyuan)
      return {
        failed: ['failed', 'cancelled', 'banned', 'expired'].includes(result.status),
        failure: new ModelApiError(502, 'provider_failed', info),
        complete: result.status === 'success',
        progress: result.progress,
        modelUrl: result.output?.model_url,
      };
    if (!['WAIT', 'RUN', 'FAIL', 'DONE'].includes(result.Status))
      throw new ModelApiError(502, 'provider_failed', info);
    return {
      failed: result.Status === 'FAIL' || !!result.ErrorCode,
      // A failed task is terminal even if its ErrorCode describes a temporary provider outage.
      failure: providerError(info),
      complete: result.Status === 'DONE',
      progress: result.Status === 'WAIT' ? 15 : 20,
      modelUrl: Array.isArray(result.ResultFile3Ds)
        ? result.ResultFile3Ds.find((file) => file?.Type === 'GLB')?.Url
        : undefined,
    };
  }

  async function execute(job) {
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(timeout)]);
    let lastQueryError;
    try {
      job.status = 'preparing';
      job.stage = isHunyuan ? 'submit' : 'upload';
      const { taskId, diagnostic: info } = await submitToProvider(job, signal);
      if (typeof taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(taskId))
        throw new ModelApiError(502, 'submission_uncertain', info);
      job.taskId = taskId;
      job.status = 'running';
      job.stage = 'query';
      job.progress = 15;
      job.images = null;
      while (true) {
        signal.throwIfAborted();
        await wait(pollInterval, signal);
        let result;
        try {
          result = await queryProvider(job.taskId, signal);
          lastQueryError = undefined;
        } catch (error) {
          if (['provider_unavailable', 'provider_rate_limited'].includes(error.code)) {
            lastQueryError = error;
            continue;
          }
          throw error;
        }
        if (result.failed) throw result.failure;
        if (Number.isFinite(result.progress))
          job.progress = Math.max(job.progress, Math.min(95, Math.max(15, result.progress)));
        if (!result.complete) continue;
        job.status = 'downloading';
        job.stage = 'download';
        job.progress = 95;
        const bytes = await modelBytes(result.modelUrl, signal);
        signal.throwIfAborted();
        makeRoom(bytes.length);
        job.result = bytes;
        job.progress = 100;
        job.status = 'succeeded';
        break;
      }
    } catch (error) {
      if (job.controller.signal.aborted) job.status = 'cancelled';
      else {
        job.status = 'failed';
        job.error = signal.aborted
          ? 'timed_out'
          : error instanceof ModelApiError
            ? error.code
            : 'provider_failed';
        job.diagnostic =
          error?.diagnostic ||
          (signal.aborted && lastQueryError?.diagnostic) ||
          diagnostic(job.stage);
        try {
          onDiagnostic({ jobId: job.id, error: job.error, ...job.diagnostic });
        } catch {
          /* Logging must not change task state or break the queue. */
        }
      }
    } finally {
      job.images = null;
      job.updatedAt = Date.now();
    }
  }

  function pump() {
    if (active || closed) return;
    const job = queue.shift();
    if (!job) return;
    if (job.status === 'cancelled') return pump();
    active = true;
    void execute(job).finally(() => {
      active = false;
      pump();
    });
  }

  async function parseAndSubmit(request) {
    if (!enabled || closed) throw new ModelApiError(503, 'service_unavailable');
    if (!matches(`Bearer ${accessToken}`, request.headers.authorization))
      throw new ModelApiError(401, 'unauthorized');
    const requestId = request.headers['x-idempotency-key'];
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId))
      throw new ModelApiError(400, 'invalid_images');
    const contentType = request.headers['content-type'] || '';
    if (!contentType.startsWith('multipart/form-data;'))
      throw new ModelApiError(400, 'invalid_images');
    const declared = Number(request.headers['content-length'] || 0);
    if (
      declared &&
      (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_REQUEST_BYTES)
    )
      throw new ModelApiError(413, 'request_too_large');
    const body = await readLimitedBody(request, MAX_REQUEST_BYTES);
    let form;
    try {
      form = await new Request('http://localhost', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      }).formData();
    } catch {
      throw new ModelApiError(400, 'invalid_images');
    }
    if (
      [...form.keys()].length !== 4 ||
      ['front', 'side', 'back', 'sideView'].some((field) => form.getAll(field).length !== 1)
    )
      throw new ModelApiError(400, 'invalid_images');
    const sideView = form.get('sideView');
    if (!['left', 'right'].includes(sideView)) throw new ModelApiError(400, 'invalid_images');
    const images = {};
    const fingerprint = createHash('sha256').update(sideView);
    for (const field of ['front', 'side', 'back']) {
      const file = form.get(field);
      if (
        !(file instanceof Blob) ||
        !['image/png', 'image/jpeg'].includes(file.type) ||
        !file.size ||
        file.size > MAX_UPLOAD_BYTES
      )
        throw new ModelApiError(400, 'invalid_images');
      const bytes = Buffer.from(await file.arrayBuffer());
      fingerprint.update(field).update(bytes);
      try {
        const image = sharp(bytes, { animated: false, limitInputPixels: 16_000_000 });
        const metadata = await image.metadata();
        if (
          !['png', 'jpeg'].includes(metadata.format) ||
          metadata.pages > 1 ||
          !Number.isSafeInteger(metadata.width) ||
          metadata.width < 256 ||
          !Number.isSafeInteger(metadata.height) ||
          metadata.height < 256
        )
          throw Error('invalid');
        const scale = Math.min(1, 2048 / Math.max(metadata.width, metadata.height));
        if (Math.round(metadata.width * scale) < 256 || Math.round(metadata.height * scale) < 256)
          throw Error('invalid');
        images[field] = await image
          .rotate()
          .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        if (images[field].length > MAX_UPLOAD_BYTES) throw Error('invalid');
      } catch {
        throw new ModelApiError(400, 'invalid_images');
      }
    }
    if (isHunyuan) {
      const encodedBytes = Object.values(images).reduce(
        (sum, bytes) => sum + 4 * Math.ceil(bytes.length / 3),
        PNG_DATA_URL_PREFIX.length,
      );
      if (encodedBytes > MAX_HUNYUAN_BASE64_BYTES)
        throw new ModelApiError(413, 'request_too_large');
    }
    const digest = fingerprint.digest('hex');
    const existing = [...jobs.values()].find((job) => job.requestId === requestId);
    if (existing) {
      if (existing.fingerprint !== digest) throw new ModelApiError(409, 'conflict');
      return { ...payload(existing), jobToken: existing.token };
    }
    if (queue.filter((job) => job.status === 'queued').length + (active ? 1 : 0) >= maxPending)
      throw new ModelApiError(429, 'queue_full');
    makeRoom();
    if (jobs.size >= maxJobs) throw new ModelApiError(429, 'queue_full');
    const job = {
      id: randomUUID(),
      token: randomBytes(32).toString('hex'),
      requestId,
      fingerprint: digest,
      images,
      sideView,
      status: 'queued',
      progress: 0,
      updatedAt: Date.now(),
      controller: new AbortController(),
    };
    jobs.set(job.id, job);
    queue.push(job);
    queueMicrotask(pump);
    return { ...payload(job), jobToken: job.token };
  }

  async function submit(request) {
    if (validating >= 2) throw new ModelApiError(429, 'queue_full');
    validating++;
    try {
      return await parseAndSubmit(request);
    } finally {
      validating--;
    }
  }

  async function handle(request, response, url) {
    if (!/^\/api\/model-jobs(?:\/|$)/.test(url.pathname)) return false;
    cleanup();
    function json(status, value) {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    }
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const origin = request.headers.origin;
      if (origin && !origins.has(origin)) throw new ModelApiError(403, 'origin_not_allowed');
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        response.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization,Content-Type,X-Model-Job-Token,X-Idempotency-Key',
        );
      }
      if (url.search || url.hash) throw new ModelApiError(400, 'invalid_images');
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return true;
      }
      if (url.pathname === '/api/model-jobs' && request.method === 'POST') {
        json(202, await submit(request));
        return true;
      }
      const match = url.pathname.match(/^\/api\/model-jobs\/([0-9a-f-]{36})(\/result)?$/i);
      const job = match && jobs.get(match[1]);
      if (!job) throw new ModelApiError(404, 'task_not_found');
      if (!matches(job.token, request.headers['x-model-job-token']))
        throw new ModelApiError(401, 'unauthorized');
      if (request.method === 'GET' && match[2]) {
        if (job.status !== 'succeeded' || !job.result)
          throw new ModelApiError(409, 'invalid_model');
        response.writeHead(200, {
          'Content-Type': 'model/gltf-binary',
          'Content-Length': job.result.length,
          'Content-Disposition': 'attachment; filename="character.glb"',
        });
        response.end(job.result);
      } else if (request.method === 'GET') json(200, payload(job));
      else if (request.method === 'DELETE' && !match[2]) {
        if (!TERMINAL.has(job.status)) {
          job.status = 'cancelled';
          job.updatedAt = Date.now();
          job.images = null;
          job.controller.abort();
        }
        json(200, payload(job));
      } else throw new ModelApiError(405, 'method_not_allowed');
    } catch (error) {
      json(error instanceof ModelApiError ? error.status : 500, {
        error: { message: error instanceof ModelApiError ? error.code : 'internal_error' },
      });
    }
    return true;
  }

  return {
    handle,
    close() {
      closed = true;
      for (const job of jobs.values()) if (!TERMINAL.has(job.status)) job.controller.abort();
      queue.length = 0;
      jobs.clear();
    },
  };
}
