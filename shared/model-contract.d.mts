export const MAX_MODEL_BYTES: number;
export function validateGlb(bytes: Uint8Array): Uint8Array;

export interface ModelDiagnostic {
  provider: 'tripo' | 'hunyuan';
  stage: 'upload' | 'submit' | 'query' | 'download';
  httpStatus?: number;
  providerCode?: string | number;
  requestId?: string;
}
export function sanitizeModelDiagnostic(value: unknown): ModelDiagnostic | undefined;
