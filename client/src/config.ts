export const MODULE_NAME = import.meta.env.VITE_SPACETIMEDB_MODULE || 'ydrive-axerq';
export const SPACETIMEDB_URI = import.meta.env.VITE_SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com';
export const SPACETIMEDB_HTTP_URI =
  import.meta.env.VITE_SPACETIMEDB_HTTP_URI ||
  SPACETIMEDB_URI.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');

export function getDownloadUrl(fileId: bigint) {
  const baseUri = SPACETIMEDB_HTTP_URI.replace(/\/$/, '');
  return `${baseUri}/v1/database/${encodeURIComponent(MODULE_NAME)}/route/download?id=${fileId}`;
}
