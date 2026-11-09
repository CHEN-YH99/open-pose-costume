export const MAX_MODEL_BYTES = 50 * 1024 * 1024;

export function validateGlb(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 24 || bytes.byteLength > MAX_MODEL_BYTES)
    throw Error('invalid_model');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    header.getUint32(0, true) !== 0x46546c67 ||
    header.getUint32(4, true) !== 2 ||
    header.getUint32(8, true) !== bytes.byteLength ||
    header.getUint32(16, true) !== 0x4e4f534a
  )
    throw Error('invalid_model');
  let offset = 12;
  let chunks = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw Error('invalid_model');
    const length = header.getUint32(offset, true);
    const type = header.getUint32(offset + 4, true);
    if (
      !length ||
      length % 4 ||
      offset + 8 + length > bytes.byteLength ||
      (chunks > 0 && type !== 0x004e4942) ||
      chunks > 1
    )
      throw Error('invalid_model');
    offset += 8 + length;
    chunks++;
  }
  let document;
  try {
    const length = header.getUint32(12, true);
    document = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  } catch {
    throw Error('invalid_model');
  }
  if (
    document?.asset?.version !== '2.0' ||
    !Array.isArray(document.meshes) ||
    !document.meshes.length
  )
    throw Error('invalid_model');
  const pending = [document];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri' && (typeof child !== 'string' || !child.startsWith('data:')))
        throw Error('invalid_model');
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return bytes;
}

// Only fixed public error codes/categories may be reflected. Never copy upstream messages or unknown suffixes.
const HUNYUAN_PUBLIC_CODES = new Set([
  'ActionOffline',
  'AuthFailure',
  'AuthFailure.InvalidAuthorization',
  'AuthFailure.InvalidSecretId',
  'AuthFailure.MFAFailure',
  'AuthFailure.SecretIdNotFound',
  'AuthFailure.SignatureExpire',
  'AuthFailure.SignatureFailure',
  'AuthFailure.TokenFailure',
  'AuthFailure.UnauthorizedOperation',
  'DryRunOperation',
  'FailedOperation',
  'InternalError',
  'InvalidAction',
  'InvalidParameter',
  'InvalidParameterValue',
  'InvalidRequest',
  'IpInBlacklist',
  'IpNotInWhitelist',
  'LimitExceeded',
  'MissingParameter',
  'NoSuchProduct',
  'NoSuchVersion',
  'RequestLimitExceeded',
  'RequestLimitExceeded.GlobalRegionUinLimitExceeded',
  'RequestLimitExceeded.IPLimitExceeded',
  'RequestLimitExceeded.UinLimitExceeded',
  'RequestSizeLimitExceeded',
  'ResourceInUse',
  'ResourceInsufficient',
  'ResourceNotFound',
  'ResourceUnavailable',
  'ResponseSizeLimitExceeded',
  'ServiceUnavailable',
  'UnauthorizedOperation',
  'UnknownParameter',
  'UnsupportedOperation',
  'UnsupportedProtocol',
  'UnsupportedRegion',
]);

export function sanitizeModelDiagnostic(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['tripo', 'hunyuan'].includes(value.provider) ||
    !['upload', 'submit', 'query', 'download'].includes(value.stage)
  )
    return undefined;
  const diagnostic = { provider: value.provider, stage: value.stage };
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599)
    diagnostic.httpStatus = value.httpStatus;
  if (value.provider === 'hunyuan' && typeof value.providerCode === 'string') {
    const code = value.providerCode;
    // Unknown business subcodes still identify a public category. Reflect only the
    // fixed root, never a suffix that could contain a key, URL or private detail.
    const root = code.split('.')[0];
    if (HUNYUAN_PUBLIC_CODES.has(code)) diagnostic.providerCode = code;
    else if (HUNYUAN_PUBLIC_CODES.has(root)) diagnostic.providerCode = root;
  }
  // Tripo API errors use numeric codes, not arbitrary strings or messages.
  if (
    value.provider === 'tripo' &&
    Number.isInteger(value.providerCode) &&
    value.providerCode > 0 &&
    value.providerCode <= 999999
  )
    diagnostic.providerCode = value.providerCode;
  if (
    typeof value.requestId === 'string' &&
    value.requestId.length === 36 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.requestId)
  )
    diagnostic.requestId = value.requestId;
  return diagnostic;
}
