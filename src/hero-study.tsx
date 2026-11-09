import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, RefObject } from 'react';
import { Maximize2, Move, Pause, Play, Scan, Sparkles, X, ZoomIn, ZoomOut } from 'lucide-react';
import { Modal } from './ui';
import type { Lang } from './types';

const labels = {
  zh: {
    title: '三种参考，一个角色',
    pose: '姿势',
    costume: '服饰',
    character: '人物',
    result: '生成结果',
    example: '生成示例',
    preview: '人物预览',
    pending: '男生组合效果待生成',
    open: '放大查看',
    close: '关闭',
    pauseMotion: '暂停背景动画',
    resumeMotion: '播放背景动画',
  },
  en: {
    title: 'Three references. One character.',
    pose: 'Pose',
    costume: 'Costume',
    character: 'Character',
    result: 'Generated result',
    example: 'Example output',
    preview: 'Character preview',
    pending: 'Combined male example pending',
    open: 'View larger',
    close: 'Close',
    pauseMotion: 'Pause background animation',
    resumeMotion: 'Play background animation',
  },
};
type ImageKind = 'pose' | 'costume' | 'character' | 'result';

type HeroFlowRect = { x: number; y: number; width: number; height: number };

// Measure against the real cards so the streams follow their edges at every breakpoint.
export function heroFlowRoute(card: HeroFlowRect, targetX: number, branch: 'upper' | 'lower') {
  const clearance = 3;
  const radius = 10;
  const left = card.x - clearance;
  const right = card.x + card.width + clearance;
  const center = card.y + card.height / 2;
  const edge = branch === 'upper' ? card.y - clearance : card.y + card.height + clearance;
  const turn = branch === 'upper' ? edge + radius : edge - radius;
  return {
    path:
      'M0 ' +
      center +
      'H' +
      left +
      'V' +
      turn +
      'Q' +
      left +
      ' ' +
      edge +
      ' ' +
      (left + radius) +
      ' ' +
      edge +
      'H' +
      (right - radius) +
      'Q' +
      right +
      ' ' +
      edge +
      ' ' +
      right +
      ' ' +
      turn +
      'V' +
      center +
      'H' +
      targetX,
    entryLength: left,
    exitLength: targetX - right,
    left,
    right,
    center,
  };
}

function heroFlowKeyframes(path: SVGPathElement, entry: number, exit: number, lower: boolean) {
  const length = path.getTotalLength();
  const perimeter = length - entry - exit;
  const frame = (time: number, distance: number, opacity: number) => {
    const point = path.getPointAtLength(distance);
    return (
      time.toFixed(3) +
      '%{transform:translate(' +
      point.x.toFixed(3) +
      'px,' +
      point.y.toFixed(3) +
      'px);opacity:' +
      opacity +
      '}'
    );
  };
  const frames = [frame(0, 0, 0), frame(3, (entry * 3) / 14, lower ? 0 : 0.85)];
  // The branches share the entry and exit; only the upper dot is visible on those sections.
  for (let step = 0; step <= 64; step++) {
    frames.push(
      frame(
        14 + (60 * step) / 64,
        entry + (perimeter * step) / 64,
        lower && (step === 0 || step === 64) ? 0 : 0.85,
      ),
    );
  }
  frames.push(frame(78, length - exit, lower ? 0 : 0.85));
  frames.push(frame(91, length - (exit * 3) / 16, lower ? 0 : 0.85));
  frames.push(frame(94, length, 0), frame(100, length, 0));
  return frames.join('');
}

// Decorative only. CSS drives playback; geometry is rebuilt only when the layout changes.
function HeroStudyBackdrop({ studyRef }: { studyRef: RefObject<HTMLElement | null> }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const motionStyleRef = useRef<HTMLStyleElement | null>(null);
  const motionId = 'hero-flow-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');

  useEffect(() => {
    const study = studyRef.current;
    const svg = svgRef.current;
    const motionStyle = motionStyleRef.current;
    if (!study || !svg || !motionStyle) return;
    const cards = Array.from(study.querySelectorAll<HTMLElement>('.hero-input'));
    const result = study.querySelector<HTMLElement>('.hero-result');
    if (!result) return;
    let previousGeometry = '';
    const updateGeometry = () => {
      const bounds = study.getBoundingClientRect();
      const localRect = (element: HTMLElement): HeroFlowRect => {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.x - bounds.x,
          y: rect.y - bounds.y,
          width: rect.width,
          height: rect.height,
        };
      };
      const inputs = cards.map(localRect);
      const output = localRect(result);
      const geometry = JSON.stringify([bounds.width, bounds.height, inputs, output]);
      if (!bounds.width || geometry === previousGeometry) return;
      previousGeometry = geometry;
      svg.setAttribute('viewBox', '0 0 ' + bounds.width + ' ' + bounds.height);
      const rules: string[] = [];
      inputs.forEach((card, index) => {
        const group = svg.querySelectorAll<SVGGElement>('.hero-flow-reference')[index];
        for (const branch of ['upper', 'lower'] as const) {
          const route = heroFlowRoute(card, output.x - 2, branch);
          const path = group.querySelector<SVGPathElement>('[data-branch="' + branch + '"]')!;
          path.setAttribute('d', route.path);
          rules.push(
            '@keyframes ' +
              motionId +
              '-' +
              index +
              '-' +
              branch +
              '{' +
              heroFlowKeyframes(path, route.entryLength, route.exitLength, branch === 'lower') +
              '}',
          );
          const joint = group.querySelector<SVGCircleElement>('[data-joint="' + branch + '"]')!;
          joint.setAttribute('cx', String(branch === 'upper' ? route.left : route.right));
          joint.setAttribute('cy', String(route.center));
        }
      });
      // Update keyframes without changing their names, preserving the current animation phase.
      motionStyle.textContent = rules.join('');
      const x = output.x - 4;
      const y = output.y - 4;
      const right = output.x + output.width + 4;
      const bottom = output.y + output.height + 4;
      svg
        .querySelector('.hero-flow-result path')!
        .setAttribute(
          'd',
          'M' +
            (x + 12) +
            ' ' +
            y +
            'H' +
            x +
            'V' +
            (y + 12) +
            'M' +
            (right - 12) +
            ' ' +
            y +
            'H' +
            right +
            'V' +
            (y + 12) +
            'M' +
            (x + 12) +
            ' ' +
            bottom +
            'H' +
            x +
            'V' +
            (bottom - 12) +
            'M' +
            (right - 12) +
            ' ' +
            bottom +
            'H' +
            right +
            'V' +
            (bottom - 12),
        );
    };
    const observer = new ResizeObserver(updateGeometry);
    [study, result, ...cards].forEach((element) => observer.observe(element));
    window.addEventListener('resize', updateGeometry);
    updateGeometry();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateGeometry);
    };
  }, [motionId, studyRef]);

  return (
    <div className="hero-study-backdrop" aria-hidden="true">
      <style ref={motionStyleRef} />
      <svg ref={svgRef} className="hero-flow" focusable="false">
        {(['pose', 'costume', 'character'] as const).map((kind, index) => (
          <g className="hero-flow-reference" key={kind}>
            <g className="hero-flow-tracks" fill="none">
              <path className={'hero-flow-track hero-flow-track-' + kind} data-branch="upper" />
              <path className={'hero-flow-track hero-flow-track-' + kind} data-branch="lower" />
            </g>
            <g className="hero-flow-joints">
              <circle data-joint="upper" r="2" />
              <circle data-joint="lower" r="2" />
            </g>
            {(['upper', 'lower'] as const).map((branch) => (
              <g
                key={branch}
                className={'hero-flow-particle hero-flow-particle-' + kind}
                data-particle={branch}
                style={
                  {
                    '--hero-flow-animation': motionId + '-' + index + '-' + branch,
                  } as CSSProperties
                }
              >
                <circle r="2.5" />
              </g>
            ))}
          </g>
        ))}
        <g className="hero-flow-result" fill="none">
          <path />
        </g>
      </svg>
    </div>
  );
}

export function HeroStudy({ lang }: { lang: Lang }) {
  const t = labels[lang];
  // Display the user-supplied generated example from the existing hero assets.
  const hasGeneratedResult = true;
  const resultKind: ImageKind = hasGeneratedResult ? 'result' : 'character';
  const resultTitle = hasGeneratedResult ? t.result : t.preview;
  const [selected, setSelected] = useState<ImageKind | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const studyRef = useRef<HTMLElement | null>(null);
  const [motionPaused, setMotionPaused] = useState(false);
  const [motionActive, setMotionActive] = useState(false);

  useEffect(() => {
    const study = studyRef.current;
    if (!study) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let inView = false;
    const updateMotion = () => setMotionActive(inView && !document.hidden && !preference.matches);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      updateMotion();
    });
    observer.observe(study);
    preference.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateMotion);
    return () => {
      observer.disconnect();
      preference.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateMotion);
    };
  }, []);
  const openImage = (kind: ImageKind, opener: HTMLButtonElement) => {
    openerRef.current = opener;
    setSelected(kind);
  };
  const closeImage = () => {
    setSelected(null);
    // Restore focus after React removes the modal from the top layer.
    requestAnimationFrame(() => openerRef.current?.focus({ preventScroll: true }));
  };
  const source = (kind: ImageKind) =>
    `${import.meta.env.BASE_URL}images/hero/${kind}.webp?v=${kind === 'result' ? 'male-result-20261109' : 'male-20261109'}`;
  return (
    <section
      ref={studyRef}
      className="hero-study"
      aria-label={t.title}
      data-motion={motionActive && !motionPaused && !selected ? 'running' : 'paused'}
    >
      <HeroStudyBackdrop studyRef={studyRef} />
      <div className="hero-study-heading">
        <span>{t.title}</span>
        <div className="hero-study-heading-tools">
          <Sparkles size={14} aria-hidden="true" />
          <button
            type="button"
            className="hero-motion-toggle"
            aria-label={motionPaused ? t.resumeMotion : t.pauseMotion}
            title={motionPaused ? t.resumeMotion : t.pauseMotion}
            onClick={() => setMotionPaused((paused) => !paused)}
          >
            {motionPaused ? <Play size={11} /> : <Pause size={11} />}
          </button>
        </div>
      </div>
      <div className="hero-equation">
        <div className="hero-inputs">
          {(['pose', 'costume', 'character'] as const).map((kind, index) => (
            <div className="hero-input-group" key={kind}>
              {index > 0 && (
                <span className="hero-plus" aria-hidden="true">
                  +
                </span>
              )}
              <button
                type="button"
                className="hero-input"
                onClick={(event) => openImage(kind, event.currentTarget)}
                aria-label={`${t.open}: ${t[kind]}`}
              >
                <img src={source(kind)} alt={t[kind]} width={60} height={72} />
                <span>
                  {t[kind]}
                  <small>{kind.toUpperCase()}</small>
                </span>
              </button>
            </div>
          ))}
        </div>
        <span className="hero-equals" aria-hidden="true">
          =
        </span>
        <button
          type="button"
          className="hero-result"
          onClick={(event) => openImage(resultKind, event.currentTarget)}
          aria-label={`${t.open}: ${resultTitle}`}
        >
          <img
            src={source(resultKind)}
            alt={resultTitle}
            width={941}
            height={1672}
            fetchPriority="high"
          />
          <span>
            <span>
              {resultTitle}
              <small>{hasGeneratedResult ? t.example : t.pending}</small>
            </span>
            <Maximize2 size={13} />
          </span>
        </button>
      </div>
      {selected && (
        <HeroImageViewer
          key={selected}
          src={source(selected)}
          title={t[selected]}
          lang={lang}
          onClose={closeImage}
        />
      )}
    </section>
  );
}

const viewerLabels = {
  zh: {
    close: '关闭图片查看器',
    zoomIn: '放大',
    zoomOut: '缩小',
    fit: '适应窗口',
    reset: '重置视图',
    zoom: '缩放比例（适应窗口为 100%）',
    hint: '滚轮缩放 · 拖动查看',
    keyboard: '也可使用加减键缩放、方向键移动，按 0 重置，Esc 关闭。',
    loading: '正在加载图片…',
    error: '图片加载失败，请关闭后重试。',
  },
  en: {
    close: 'Close image viewer',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fit: 'Fit to window',
    reset: 'Reset view',
    zoom: 'Zoom level (100% fits the window)',
    hint: 'Scroll to zoom · Drag to pan',
    keyboard: 'Use plus/minus to zoom, arrow keys to pan, 0 to reset, and Escape to close.',
    loading: 'Loading image…',
    error: 'Could not load the image. Close the viewer and try again.',
  },
};

type ImageSize = { width: number; height: number };
type ImageView = { zoom: number; x: number; y: number };
const INITIAL_VIEW: ImageView = { zoom: 1, x: 0, y: 0 };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const VIEWER_INSET = 12;

export function fitImageToViewport(image: ImageSize, viewport: ImageSize): number {
  if (
    ![image.width, image.height, viewport.width, viewport.height].every(
      (n) => Number.isFinite(n) && n > 0,
    )
  )
    return 0;
  return Math.max(
    0,
    Math.min(
      (viewport.width - VIEWER_INSET * 2) / image.width,
      (viewport.height - VIEWER_INSET * 2) / image.height,
    ),
  );
}

export function constrainImageView(
  view: ImageView,
  image: ImageSize,
  viewport: ImageSize,
): ImageView {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom));
  const fit = fitImageToViewport(image, viewport);
  const maxX = Math.max(0, (image.width * fit * zoom - viewport.width) / 2 + VIEWER_INSET);
  const maxY = Math.max(0, (image.height * fit * zoom - viewport.height) / 2 + VIEWER_INSET);
  return {
    zoom,
    x: maxX > 0 ? Math.max(-maxX, Math.min(maxX, view.x)) : 0,
    y: maxY > 0 ? Math.max(-maxY, Math.min(maxY, view.y)) : 0,
  };
}

export function zoomImageView(
  view: ImageView,
  nextZoom: number,
  anchor: { x: number; y: number },
  image: ImageSize,
  viewport: ImageSize,
): ImageView {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  const ratio = zoom / view.zoom;
  return constrainImageView(
    { zoom, x: anchor.x - (anchor.x - view.x) * ratio, y: anchor.y - (anchor.y - view.y) * ratio },
    image,
    viewport,
  );
}

export function HeroImageViewer({
  src,
  title,
  lang,
  onClose,
}: {
  src: string;
  title: string;
  lang: Lang;
  onClose: () => void;
}) {
  const t = viewerLabels[lang];
  const hintId = useId();
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const viewRef = useRef<ImageView>(INITIAL_VIEW);
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const metricsRef = useRef({ image: { width: 0, height: 0 }, viewport: { width: 0, height: 0 } });
  const [metrics, setMetrics] = useState(metricsRef.current);
  const [view, setView] = useState(INITIAL_VIEW);
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  const fit = fitImageToViewport(metrics.image, metrics.viewport);
  const ready = fit > 0 && !failed;

  const updateView = (next: ImageView) => {
    viewRef.current = next;
    setView(next);
  };
  const resetView = () => updateView(INITIAL_VIEW);
  const zoomBy = (factor: number) => {
    if (!ready) return;
    const { image, viewport } = metricsRef.current;
    updateView(
      zoomImageView(
        viewRef.current,
        viewRef.current.zoom * factor,
        { x: 0, y: 0 },
        image,
        viewport,
      ),
    );
  };

  useEffect(() => {
    const stage = stageRef.current!;
    const image = imageRef.current!;
    const measure = () => {
      const next = {
        image: { width: image.naturalWidth, height: image.naturalHeight },
        viewport: { width: stage.clientWidth, height: stage.clientHeight },
      };
      const previous = metricsRef.current;
      if (
        next.image.width === previous.image.width &&
        next.image.height === previous.image.height &&
        next.viewport.width === previous.viewport.width &&
        next.viewport.height === previous.viewport.height
      )
        return;
      metricsRef.current = next;
      setMetrics(next);
      viewRef.current = INITIAL_VIEW;
      setView(INITIAL_VIEW);
    };
    const wheel = (event: WheelEvent) => {
      // React's delegated wheel handler may be passive; prevent page scrolling here.
      event.preventDefault();
      const { image: size, viewport } = metricsRef.current;
      if (!fitImageToViewport(size, viewport)) return;
      const bounds = stage.getBoundingClientRect();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1);
      const factor = Math.exp(-Math.max(-600, Math.min(600, delta)) * 0.002);
      const next = zoomImageView(
        viewRef.current,
        viewRef.current.zoom * factor,
        {
          x: event.clientX - bounds.left - viewport.width / 2,
          y: event.clientY - bounds.top - viewport.height / 2,
        },
        size,
        viewport,
      );
      viewRef.current = next;
      setView(next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    image.addEventListener('load', measure);
    stage.addEventListener('wheel', wheel, { passive: false });
    measure();
    return () => {
      observer.disconnect();
      image.removeEventListener('load', measure);
      stage.removeEventListener('wheel', wheel);
    };
  }, [src]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!ready || event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const { image, viewport } = metricsRef.current;
    updateView(
      constrainImageView(
        {
          ...viewRef.current,
          x: viewRef.current.x + event.clientX - drag.x,
          y: viewRef.current.y + event.clientY - drag.y,
        },
        image,
        viewport,
      ),
    );
    drag.x = event.clientX;
    drag.y = event.clientY;
  };
  const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey || !ready) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(1.25);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomBy(1 / 1.25);
    } else if (event.key === '0' || event.key === 'Home') {
      event.preventDefault();
      resetView();
    } else if (
      event.target === stageRef.current &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      event.preventDefault();
      const { image, viewport } = metricsRef.current;
      updateView(
        constrainImageView(
          {
            ...viewRef.current,
            x:
              viewRef.current.x +
              (event.key === 'ArrowLeft' ? -40 : event.key === 'ArrowRight' ? 40 : 0),
            y:
              viewRef.current.y +
              (event.key === 'ArrowUp' ? -40 : event.key === 'ArrowDown' ? 40 : 0),
          },
          image,
          viewport,
        ),
      );
    }
  };

  return (
    <Modal onClose={onClose} label={title} className="hero-study-modal">
      <div className="hero-viewer" onKeyDown={onKeyDown}>
        <header className="hero-viewer-header">
          <div className="hero-viewer-title">
            <span className="hero-viewer-mark" aria-hidden="true">
              <Maximize2 size={18} />
            </span>
            <h2>{title}</h2>
            {ready && (
              <span className="hero-viewer-dimensions">
                {metrics.image.width} × {metrics.image.height}
              </span>
            )}
          </div>
          <button
            type="button"
            className="hero-viewer-button hero-viewer-close"
            onClick={onClose}
            aria-label={t.close}
            title={t.close + ' (Esc)'}
            autoFocus
          >
            <X size={20} />
          </button>
        </header>
        <div
          ref={stageRef}
          className={'hero-viewer-stage' + (dragging ? ' is-dragging' : '')}
          tabIndex={0}
          role="region"
          aria-label={title}
          aria-describedby={hintId}
          aria-busy={!ready && !failed}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onLostPointerCapture={stopDrag}
        >
          <img
            ref={imageRef}
            src={src}
            alt={title}
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
            onError={() => setFailed(true)}
            style={{
              width: metrics.image.width * fit,
              height: metrics.image.height * fit,
              visibility: ready ? 'visible' : 'hidden',
              transform:
                'translate(-50%, -50%) translate(' +
                view.x +
                'px, ' +
                view.y +
                'px) scale(' +
                view.zoom +
                ')',
            }}
          />
          {!ready && (
            <p className="hero-viewer-status" role="status">
              {failed ? t.error : t.loading}
            </p>
          )}
        </div>
        <footer className="hero-viewer-footer">
          <p className="hero-viewer-hint" id={hintId}>
            <Move size={14} aria-hidden="true" />
            <span>
              {t.hint}
              <span className="hero-viewer-sr-only">{t.keyboard}</span>
            </span>
          </p>
          <div className="hero-viewer-tools" role="group" aria-label={t.zoom}>
            <button
              type="button"
              className="hero-viewer-button"
              onClick={() => zoomBy(1 / 1.25)}
              disabled={!ready || view.zoom <= MIN_ZOOM}
              aria-label={t.zoomOut}
              title={t.zoomOut + ' (-)'}
            >
              <ZoomOut size={18} />
            </button>
            <output className="hero-viewer-zoom" aria-label={t.zoom} title={t.zoom}>
              {Math.round(view.zoom * 100)}%
            </output>
            <button
              type="button"
              className="hero-viewer-button"
              onClick={() => zoomBy(1.25)}
              disabled={!ready || view.zoom >= MAX_ZOOM}
              aria-label={t.zoomIn}
              title={t.zoomIn + ' (+)'}
            >
              <ZoomIn size={18} />
            </button>
            <span className="hero-viewer-divider" aria-hidden="true" />
            <button
              type="button"
              className="hero-viewer-button hero-viewer-fit"
              onClick={resetView}
              disabled={!ready}
              title={t.reset + ' (0)'}
            >
              <Scan size={18} />
              <span>{t.fit}</span>
            </button>
          </div>
        </footer>
      </div>
    </Modal>
  );
}
