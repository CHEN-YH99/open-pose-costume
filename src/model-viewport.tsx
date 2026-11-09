import { createElement, useEffect, useRef, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { threeViewCopy } from './three-view-copy';
import type { Lang } from './types';

type ViewerElement = HTMLElement & {
  cameraOrbit: string;
  fieldOfView: string;
  jumpCameraToGoal(): void;
};

export function ModelViewport({ source, lang }: { source: string; lang: Lang }) {
  const text = threeViewCopy[lang];
  const element = useRef<ViewerElement>(null);
  const [defined, setDefined] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rotating, setRotating] = useState(false);
  useEffect(() => {
    let disposed = false;
    void import('@google/model-viewer')
      .then(() => {
        if (!disposed) setDefined(true);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    setLoaded(false);
    if (!defined || !element.current) return;
    setFailed(false);
    const viewer = element.current;
    const timer = setTimeout(() => setFailed(true), 60_000);
    const ready = () => {
      clearTimeout(timer);
      setFailed(false);
      setLoaded(true);
    };
    const error = () => {
      clearTimeout(timer);
      setFailed(true);
    };
    viewer.addEventListener('load', ready);
    viewer.addEventListener('error', error);
    return () => {
      clearTimeout(timer);
      viewer.removeEventListener('load', ready);
      viewer.removeEventListener('error', error);
    };
  }, [defined, source]);
  return (
    <div className="model-viewport">
      {defined &&
        createElement('model-viewer', {
          ref: element,
          src: source,
          loading: 'eager',
          alt: text.model,
          'camera-controls': '',
          'auto-rotate': rotating ? '' : undefined,
          'camera-orbit': '0deg 75deg 115%',
          'field-of-view': '30deg',
          'camera-target': 'auto auto auto',
          'touch-action': 'pan-y',
          'shadow-intensity': '0.6',
          'interaction-prompt': 'auto',
        })}
      {(!loaded || failed) && (
        <div className="studio-placeholder model-viewer-status" role={failed ? 'alert' : 'status'}>
          {!failed && <LoaderCircle size={25} className="spinner" />}
          <p>{failed ? text.viewerFailed : text.viewerLoading}</p>
        </div>
      )}
      {loaded && !failed && (
        <div className="model-viewer-controls">
          <label>
            <input
              type="checkbox"
              checked={rotating}
              onChange={(event) => setRotating(event.target.checked)}
            />
            {text.rotate}
          </label>
          <button
            className="secondary-button"
            onClick={() => {
              if (!element.current) return;
              element.current.cameraOrbit = '0deg 75deg 115%';
              element.current.fieldOfView = '30deg';
              element.current.jumpCameraToGoal();
            }}
          >
            <RotateCcw size={14} />
            {text.resetCamera}
          </button>
        </div>
      )}
    </div>
  );
}
