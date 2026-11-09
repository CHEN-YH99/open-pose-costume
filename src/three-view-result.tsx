import { useEffect, useRef, useState } from 'react';
import { sanitizeModelDiagnostic } from '../shared/model-contract.mjs';
import type { ModelDiagnostic } from '../shared/model-contract.mjs';
import { Box, Download, LoaderCircle, Maximize2, RotateCcw } from 'lucide-react';
import { ImageDownloadButton } from './generation-ui';
import { ModelViewport } from './model-viewport';
import { ThreeViewEditor } from './three-view-editor';
import { cropThreeViewImages, loadThreeViewSheet } from './three-view-crop';
import type { ThreeViewSheet } from './three-view-crop';
import { defaultThreeViewCrops, validateThreeViewCrops } from './three-view';
import type { CropRect, CropView, SideView } from './three-view';
import { threeViewCopy } from './three-view-copy';
import {
  generateThreeViewModel,
  loadModelServiceConfig,
  ModelGenerationError,
  readModelBlob,
  saveModelServiceConfig,
} from './model-generation';
import type { ModelProgress, ModelTaskRequest } from './model-generation';
import type { Lang } from './types';
import './three-view.css';

export function ModelFailureNotice({
  code,
  diagnostic,
  lang,
}: {
  code: string;
  diagnostic?: ModelDiagnostic;
  lang: Lang;
}) {
  const text = threeViewCopy[lang];
  const safe = sanitizeModelDiagnostic(diagnostic);
  const message = text[code as keyof typeof text];
  return (
    <p className="studio-inline-error" role="alert">
      {typeof message === 'string' ? message : text.unknown}
      {safe && (
        <>
          <br />
          <small>
            {text.failureDetails}: {safe.provider === 'hunyuan' ? text.hunyuan : 'Tripo'}
            {' · '}
            {text[('stage_' + safe.stage) as keyof typeof text]}
            {safe.httpStatus !== undefined && <> · HTTP {safe.httpStatus}</>}
            {safe.providerCode !== undefined && (
              <>
                {' '}
                · {text.providerCode}: <code>{safe.providerCode}</code>
              </>
            )}
            {safe.requestId && (
              <>
                {' '}
                · RequestId: <code>{safe.requestId}</code>
              </>
            )}
          </small>
        </>
      )}
    </p>
  );
}

export function ThreeViewResult({
  source,
  lang,
  onOpen,
}: {
  source: string;
  lang: Lang;
  onOpen: () => void;
}) {
  const text = threeViewCopy[lang];
  const [sheet, setSheet] = useState<ThreeViewSheet | null>(null);
  const [sheetFailed, setSheetFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [crops, setCrops] = useState(defaultThreeViewCrops);
  const [sideView, setSideView] = useState<SideView>('left');
  const [confirmed, setConfirmed] = useState(false);
  const [service, setService] = useState(loadModelServiceConfig);
  const [view, setView] = useState<'image' | 'model'>('image');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ModelProgress | null>(null);
  const [error, setError] = useState('');
  const [diagnostic, setDiagnostic] = useState<ModelDiagnostic>();
  const [modelBlob, setModelBlob] = useState<Blob | null>(null);
  const [modelSource, setModelSource] = useState('');
  const controller = useRef<AbortController | null>(null);
  const request = useRef<ModelTaskRequest | null>(null);
  const imported = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cropError = sheet ? validateThreeViewCrops(crops, sheet.width, sheet.height) : null;

  useEffect(() => {
    const abort = new AbortController();
    let loaded: ThreeViewSheet | undefined;
    setSheet(null);
    setSheetFailed(false);
    void loadThreeViewSheet(source, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) {
          value.dispose();
          return;
        }
        loaded = value;
        setSheet(value);
      })
      .catch(() => {
        if (!abort.signal.aborted) setSheetFailed(true);
      });
    return () => {
      abort.abort();
      loaded?.dispose();
    };
  }, [source, attempt]);
  useEffect(() => {
    if (!modelBlob) {
      setModelSource('');
      return;
    }
    const owned = URL.createObjectURL(modelBlob);
    setModelSource(owned);
    return () => URL.revokeObjectURL(owned);
  }, [modelBlob]);
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [],
  );

  useEffect(() => {
    if (view === 'model' && modelSource) stage.current?.scrollIntoView({ block: 'center' });
  }, [view, modelSource]);

  function invalidate() {
    controller.current?.abort();
    controller.current = null;
    request.current = null;
    setBusy(false);
    setConfirmed(false);
    setProgress(null);
    setError('');
    setDiagnostic(undefined);
    setModelBlob(null);
    setView('image');
  }

  function changeCrop(view: CropView, field: keyof CropRect, value: number) {
    invalidate();
    setCrops((current) => ({ ...current, [view]: { ...current[view], [field]: value } }));
  }

  async function generate() {
    if (!sheet || cropError || !confirmed || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError('');
    setDiagnostic(undefined);
    setProgress({ status: 'preparing', progress: 0 });
    if (!request.current || request.current.finished) {
      setModelBlob(null);
      setView('image');
    }
    try {
      const settings = saveModelServiceConfig(service);
      setService(settings);
      const images = await cropThreeViewImages(sheet, crops, abort.signal);
      if (!request.current || request.current.finished)
        request.current = { requestId: crypto.randomUUID() };
      const result = await generateThreeViewModel(
        settings,
        images,
        sideView,
        request.current,
        abort.signal,
        (value) => {
          if (controller.current === abort) setProgress(value);
        },
      );
      if (controller.current !== abort) return;
      setModelBlob(result);
      setView('model');
      setProgress((value) => ({ ...value, status: 'succeeded', progress: 100 }));
    } catch (failure) {
      if (controller.current !== abort) return;
      const code =
        failure instanceof ModelGenerationError
          ? failure.code
          : failure instanceof Error
            ? failure.message
            : 'unknown';
      setError(code);
      setDiagnostic(failure instanceof ModelGenerationError ? failure.diagnostic : undefined);
      setProgress((value) => ({
        ...value,
        status: code === 'cancelled' ? 'cancelled' : 'failed',
        progress: value?.progress || 0,
      }));
      setConfirmed(false);
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  async function importModel(file?: File) {
    if (!file || busy) return;
    invalidate();
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      const blob = await readModelBlob(file);
      if (controller.current !== abort) return;
      setModelBlob(blob);
      setView('model');
    } catch (failure) {
      if (controller.current === abort)
        setError(failure instanceof ModelGenerationError ? failure.code : 'invalid_model');
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setBusy(false);
      }
    }
  }

  function changeService(field: 'apiUrl' | 'accessToken', value: string) {
    if (field === 'apiUrl' && request.current)
      request.current = {
        requestId: request.current.requestId,
        finished: request.current.finished,
      };
    setError('');
    setDiagnostic(undefined);
    setConfirmed(false);
    setService((current) => ({ ...current, [field]: value }));
  }

  return (
    <div className="three-view-result">
      <div className="studio-result-toolbar">
        <div className="generation-preview-switch" role="group" aria-label={text.model}>
          {(['image', 'model'] as const).map((key) => (
            <button key={key} aria-pressed={view === key} onClick={() => setView(key)}>
              {text[key]}
            </button>
          ))}
        </div>
        {view === 'image' && (
          <button className="icon-button" aria-label={text.image} onClick={onOpen}>
            <Maximize2 size={17} />
          </button>
        )}
      </div>
      <div ref={stage} className="studio-canvas three-view-canvas">
        {view === 'image' ? (
          <div className="studio-result-image">
            <button aria-label={text.image} onClick={onOpen}>
              <img src={sheet?.source || source} alt={text.image} referrerPolicy="no-referrer" />
            </button>
          </div>
        ) : modelSource ? (
          <ModelViewport key={modelSource} source={modelSource} lang={lang} />
        ) : (
          <div className="studio-placeholder">
            <Box size={31} />
            <p>{busy ? text.generating : text.noModel}</p>
          </div>
        )}
      </div>
      <div className="studio-result-actions three-view-actions">
        <ImageDownloadButton
          source={source}
          filename="three-view-character"
          lang={lang}
          showLabel
        />
        {modelSource && (
          <a className="secondary-button" href={modelSource} download="character.glb">
            <Download size={15} />
            {text.download}
          </a>
        )}
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => imported.current?.click()}
        >
          <Box size={15} />
          {text.importModel}
        </button>
        <input
          ref={imported}
          type="file"
          accept=".glb"
          hidden
          onChange={(event) => {
            void importModel(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </div>
      <p className="studio-result-note">
        {view === 'model' && modelSource ? text.modelHint : text.importHint}
      </p>
      <section className="three-view-workflow" aria-label={text.cropTitle}>
        <div className="studio-section-heading">
          <h3>{text.cropTitle}</h3>
          <button
            className="text-action"
            disabled={busy}
            onClick={() => {
              invalidate();
              setCrops(defaultThreeViewCrops());
            }}
          >
            <RotateCcw size={13} />
            {text.resetCrops}
          </button>
        </div>
        <p className="three-view-hint">{text.cropHint}</p>
        {sheet ? (
          <ThreeViewEditor
            sheet={sheet}
            crops={crops}
            lang={lang}
            disabled={busy}
            onChange={changeCrop}
          />
        ) : (
          <p role={sheetFailed ? 'alert' : 'status'}>
            {sheetFailed ? text.imageFailed : text.loadingSheet}
            {sheetFailed && (
              <button className="text-action" onClick={() => setAttempt((value) => value + 1)}>
                {text.retry}
              </button>
            )}
          </p>
        )}
        {cropError && (
          <p className="studio-inline-error" role="alert">
            {text[cropError]}
          </p>
        )}
        <label className="three-view-side-label">
          {text.sideView}
          <select
            className="studio-select"
            value={sideView}
            disabled={busy}
            onChange={(event) => {
              invalidate();
              setSideView(event.target.value as SideView);
            }}
          >
            <option value="left">{text.left}</option>
            <option value="right">{text.right}</option>
          </select>
        </label>
        <details className="three-view-service">
          <summary>{text.service}</summary>
          <label>
            {text.serviceUrl}
            <input
              type="url"
              className="studio-select"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              value={service.apiUrl}
              onChange={(event) => changeService('apiUrl', event.target.value)}
            />
          </label>
          <label>
            {text.accessToken}
            <input
              type="password"
              className="studio-select"
              autoComplete="off"
              disabled={busy}
              value={service.accessToken}
              onChange={(event) => changeService('accessToken', event.target.value)}
            />
          </label>
          <p className="three-view-hint">{text.serviceHint}</p>
        </details>
        <label className="three-view-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            disabled={busy || !sheet || !!cropError}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          {text.confirm}
        </label>
        <p className="three-view-hint">{text.costHint}</p>
        {progress && (
          <div className="three-view-progress" role="status">
            <span>
              {text[progress.status]} · {Math.round(progress.progress)}%
            </span>
            <progress max={100} value={progress.progress} aria-label={text.generating} />
            {progress.providerTaskId && (
              <code>
                {progress.provider === 'hunyuan'
                  ? text.hunyuan
                  : progress.provider === 'tripo'
                    ? 'Tripo'
                    : text.providerTask}
                : {progress.providerTaskId}
              </code>
            )}
          </div>
        )}
        {error && <ModelFailureNotice code={error} diagnostic={diagnostic} lang={lang} />}
        <div className="three-view-actions">
          <button
            className="primary-button"
            disabled={busy || !sheet || !!cropError || !confirmed}
            onClick={() => void generate()}
          >
            {busy ? <LoaderCircle size={16} className="spinner" /> : <Box size={16} />}
            {busy
              ? text.generating
              : error && request.current
                ? request.current.finished
                  ? text.newTask
                  : text.reconnect
                : text.generate}
          </button>
          {busy && (
            <button
              className="secondary-button"
              onClick={() => {
                controller.current?.abort();
                controller.current = null;
                setBusy(false);
                setConfirmed(false);
                setProgress((value) => ({
                  ...value,
                  status: 'cancelled',
                  progress: value?.progress || 0,
                }));
              }}
            >
              {text.cancel}
            </button>
          )}
        </div>
        <p className="three-view-hint">{text.cancelHint}</p>
      </section>
    </div>
  );
}
