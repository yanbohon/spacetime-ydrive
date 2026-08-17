export const MODULE_NAME = import.meta.env.VITE_SPACETIMEDB_MODULE || 'ydrive-axerq';
export const SPACETIMEDB_URI = import.meta.env.VITE_SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com';
export const SPACETIMEDB_HTTP_URI =
  import.meta.env.VITE_SPACETIMEDB_HTTP_URI ||
  SPACETIMEDB_URI.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');

function getFileUrl(fileId: bigint, pickupCode: string, preview: boolean) {
  const baseUri = SPACETIMEDB_HTTP_URI.replace(/\/$/, '');
  const code = pickupCode.replace(/[\s-]/g, '').toUpperCase();
  const previewParam = preview ? '&preview=1' : '';
  return `${baseUri}/v1/database/${encodeURIComponent(MODULE_NAME)}/route/download?id=${fileId}&code=${encodeURIComponent(code)}${previewParam}`;
}

export function getDownloadUrl(fileId: bigint, pickupCode: string) {
  return getFileUrl(fileId, pickupCode, false);
}

export function getPreviewUrl(fileId: bigint, pickupCode: string) {
  return getFileUrl(fileId, pickupCode, true);
}

export function getBatchDownloadUrl(fileIds: bigint[], pickupCode: string) {
  const baseUri = SPACETIMEDB_HTTP_URI.replace(/\/$/, '');
  const code = pickupCode.replace(/[\s-]/g, '').toUpperCase();
  const ids = fileIds.map(String).join(',');
  return `${baseUri}/v1/database/${encodeURIComponent(MODULE_NAME)}/route/download-batch?code=${encodeURIComponent(code)}&ids=${encodeURIComponent(ids)}`;
}
