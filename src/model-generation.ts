import {
  MAX_MODEL_BYTES,
  sanitizeModelDiagnostic,
  validateGlb,
} from '../shared/model-contract.mjs';
import type { ModelDiagnostic } from '../shared/model-contract.mjs';
import type { CropView, SideView } from './three-view';

export type ModelStatus =
  'queued' | 'preparing' | 'running' | 'downloading' | 'succeeded' | 'failed' | 'cancelled';
export interface ModelProgress {
  status: ModelStatus;
  progress: number;
  providerTaskId?: string;
  provider?: 'hunyuan' | 'tripo';
}
export interface ModelServiceConfig {
  apiUrl: string;
  accessToken: string;
}
export interface ModelTaskRequest {
  requestId: string;
  session?: { jobId: string; jobToken: string };
  finished?: boolean;
}

export class ModelGenerationError extends Error {
  readonly diagnostic?: ModelDiagnostic;
  constructor(
    public readonly code: string,
    diagnostic?: unknown,
  ) {
    super(code);
    this.diagnostic = sanitizeModelDiagnostic(diagnostic);
  }
}

function modelFailure(value: unknown): ModelGenerationError {
  const error = value as { message?: unknown; diagnostic?: unknown } | undefined;
  const code = error?.message;
  return new ModelGenerationError(
    typeof code === 'string' && /^[a-z_]{1,60}$/.test(code) ? code : 'unknown',
    error?.diagnostic,
  );
}

export function modelApiBase(value: string, origin = location.origin): string {
  try {
    const url = new URL(value.trim(), origin);
    if (
      !value.trim() ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      )
    )
      throw Error();
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new ModelGenerationError('invalidService');
  }
}

export function loadModelServiceConfig(): ModelServiceConfig {
  const local =
    typeof location === 'undefined' || ['127.0.0.1', 'localhost'].includes(location.hostname);
  const apiUrl =
    import.meta.env.VITE_IMAGE_JOB_API_URL ||
    (local ? 'http://127.0.0.1:8788/api' : `${location.origin}/api`);
  try {
    return {
      apiUrl: localStorage.getItem('opc-model-api') || apiUrl,
      accessToken: sessionStorage.getItem('opc-model-access') || '',
    };
  } catch {
    return { apiUrl, accessToken: '' };
  }
}

export function saveModelServiceConfig(config: ModelServiceConfig) {
  const apiUrl = modelApiBase(config.apiUrl);
  if (
    !config.accessToken.trim() ||
    /[\r\n]/.test(config.accessToken) ||
    config.accessToken.length > 8192
  )
    throw new ModelGenerationError('missingToken');
  try {
    localStorage.setItem('opc-model-api', apiUrl);
    sessionStorage.setItem('opc-model-access', config.accessToken.trim());
  } catch {}
  return { apiUrl, accessToken: config.accessToken.trim() };
}

async function readBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') || 0) > limit || !response.body)
    throw new ModelGenerationError('invalid_model');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new ModelGenerationError('invalid_model');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(await readBytes(response, 64 * 1024)));
  } catch {
    throw new ModelGenerationError('network_failed');
  }
  if (!response.ok) throw modelFailure(value?.error);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ModelGenerationError('network_failed');
  return value;
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
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

export async function readModelBlob(file: Blob): Promise<Blob> {
  if (!file.size || file.size > MAX_MODEL_BYTES) throw new ModelGenerationError('invalid_model');
  try {
    validateGlb(new Uint8Array(await file.arrayBuffer()));
    return new Blob([file], { type: 'model/gltf-binary' });
  } catch {
    throw new ModelGenerationError('invalid_model');
  }
}

export async function generateThreeViewModel(
  config: ModelServiceConfig,
  images: Record<CropView, Blob>,
  sideView: SideView,
  request: ModelTaskRequest,
  signal: AbortSignal,
  onProgress: (value: ModelProgress) => void,
): Promise<Blob> {
  const base = modelApiBase(config.apiUrl);
  const deadline = AbortSignal.timeout(15 * 60_000);
  const combined = AbortSignal.any([signal, deadline]);
  const cancel = () => {
    if (!request.session) return;
    void fetch(`${base}/model-jobs/${encodeURIComponent(request.session.jobId)}`, {
      method: 'DELETE',
      credentials: 'omit',
      keepalive: true,
      headers: { 'X-Model-Job-Token': request.session.jobToken },
    }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    combined.throwIfAborted();
    if (!request.session) {
      const form = new FormData();
      for (const view of ['front', 'side', 'back'] as const)
        form.set(view, images[view], `${view}.png`);
      form.set('sideView', sideView);
      const submitted = await readJson(
        await fetch(`${base}/model-jobs`, {
          method: 'POST',
          signal: combined,
          credentials: 'omit',
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            'X-Idempotency-Key': request.requestId,
          },
          body: form,
        }),
      );
      if (
        typeof submitted.jobId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(submitted.jobId) ||
        typeof submitted.jobToken !== 'string' ||
        !/^[a-zA-Z0-9_-]{32,128}$/.test(submitted.jobToken)
      )
        throw new ModelGenerationError('network_failed');
      request.session = { jobId: submitted.jobId, jobToken: submitted.jobToken };
    }
    const session = request.session;
    const url = `${base}/model-jobs/${encodeURIComponent(session.jobId)}`;
    const headers = { 'X-Model-Job-Token': session.jobToken };
    const statuses: ModelStatus[] = [
      'queued',
      'preparing',
      'running',
      'downloading',
      'succeeded',
      'failed',
      'cancelled',
    ];
    while (true) {
      combined.throwIfAborted();
      const result = await readJson(
        await fetch(url, { signal: combined, credentials: 'omit', cache: 'no-store', headers }),
      );
      if (
        !statuses.includes(result.status as ModelStatus) ||
        typeof result.progress !== 'number' ||
        !Number.isFinite(result.progress) ||
        result.progress < 0 ||
        result.progress > 100
      )
        throw new ModelGenerationError('network_failed');
      onProgress({
        status: result.status as ModelStatus,
        progress: result.progress,
        provider:
          result.provider === 'hunyuan' || result.provider === 'tripo'
            ? result.provider
            : undefined,
        providerTaskId:
          typeof result.providerTaskId === 'string'
            ? result.providerTaskId.slice(0, 128)
            : undefined,
      });
      if (result.status === 'failed' || result.status === 'cancelled') {
        request.finished = true;
        throw result.status === 'cancelled'
          ? new ModelGenerationError('cancelled')
          : modelFailure(result.error);
      }
      if (result.status === 'succeeded') {
        const response = await fetch(`${url}/result`, {
          signal: combined,
          credentials: 'omit',
          headers,
        });
        if (!response.ok) await readJson(response);
        const bytes = await readBytes(response, MAX_MODEL_BYTES);
        try {
          validateGlb(bytes);
        } catch {
          throw new ModelGenerationError('invalid_model');
        }
        request.finished = true;
        return new Blob([bytes.buffer as ArrayBuffer], { type: 'model/gltf-binary' });
      }
      await pause(1_500, combined);
    }
  } catch (error) {
    if (signal.aborted) {
      request.finished = true;
      throw new ModelGenerationError('cancelled');
    }
    if (deadline.aborted) throw new ModelGenerationError('timed_out');
    if (error instanceof ModelGenerationError) {
      if (error.code === 'task_not_found' || (error.code === 'unauthorized' && request.session))
        request.finished = true;
      throw error;
    }
    throw new ModelGenerationError('network_failed');
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
