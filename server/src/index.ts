import {
  Router,
  schema,
  SenderError,
  SyncResponse,
  table,
  t,
  type InferSchema,
  type ReducerCtx,
} from 'spacetimedb/server';
import {
  assembleByteRange,
  contentDisposition,
  normalizePickupCode,
  parseByteRange,
  parseDownloadFileId,
  parsePickupCodeFromUri,
  type ByteRange,
} from './download';
import { createZipArchive } from './archive';

const LEGACY_FILE_CHUNK_SIZE = 1024 * 1024;
const MAX_FILE_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_CHUNK_COUNT = 0xffff_ffffn;
const MAX_EXPIRY_HOURS = 24 * 7;
const MICROS_PER_HOUR = 60n * 60n * 1_000_000n;

const transfer = table(
  {
    name: 'transfer',
    public: false,
    indexes: [
      {
        accessor: 'by_owner',
        algorithm: 'btree',
        columns: ['owner_identity'],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    pickup_code: t.string().unique(),
    owner_identity: t.string(),
    created_at: t.timestamp(),
    expires_at_micros: t.u64(),
    sealed: t.bool(),
  }
);

const storedFile = table(
  {
    name: 'stored_file',
    public: false,
    indexes: [
      {
        accessor: 'by_transfer',
        algorithm: 'btree',
        columns: ['transfer_id'],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    transfer_id: t.u64().default(0n),
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
    created_at: t.timestamp(),
    ready: t.bool().default(true),
    chunk_count: t.u32().default(0),
    chunk_size_bytes: t.u32().default(0),
    owner_identity: t.string().default(''),
  }
);

const fileBlob = table(
  { name: 'file_blob', public: false },
  {
    id: t.u64().primaryKey(),
    content: t.byteArray(),
  }
);

const fileChunk = table(
  {
    name: 'file_chunk',
    public: false,
    indexes: [
      {
        accessor: 'by_file_chunk',
        algorithm: 'btree',
        columns: ['file_id', 'chunk_index'],
      },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    file_id: t.u64(),
    chunk_index: t.u32(),
    content: t.byteArray(),
  }
);

const uploadSession = table(
  { name: 'upload_session', public: false },
  {
    upload_token: t.string().primaryKey(),
    file_id: t.u64().unique(),
    next_chunk_index: t.u32(),
    received_bytes: t.u64(),
    created_at: t.timestamp(),
    chunk_size_bytes: t.u32().default(LEGACY_FILE_CHUNK_SIZE),
    owner_identity: t.string().default(''),
  }
);
const uploadLease = table(
  { name: 'upload_lease', public: false },
  {
    transfer_id: t.u64().primaryKey(),
    expires_at_micros: t.u64(),
  }
);

const spacetimedb = schema({ transfer, storedFile, fileBlob, fileChunk, uploadSession, uploadLease });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

const transferFileResult = t.object('TransferFileResult', {
  id: t.u64(),
  name: t.string(),
  mime_type: t.string(),
  size_bytes: t.u64(),
  created_at: t.timestamp(),
});

const transferResult = t.object('TransferResult', {
  pickup_code: t.string(),
  expires_at_micros: t.u64(),
  files: t.array(transferFileResult),
});

const createdTransferResult = t.object('CreatedTransferResult', {
  transfer_id: t.u64(),
  pickup_code: t.string(),
  expires_at_micros: t.u64(),
});
const uploadStatusResult = t.object('UploadStatusResult', {
  transfer_id: t.u64(),
  name: t.string(),
  mime_type: t.string(),
  size_bytes: t.u64(),
  chunk_size_bytes: t.u32(),
  received_bytes: t.u64(),
  ready: t.bool(),
  uploaded_chunk_indexes: t.array(t.u32()),
});
const ownedTransferResult = t.object('OwnedTransferResult', {
  transfer_id: t.u64(),
  pickup_code: t.string(),
  created_at: t.timestamp(),
  expires_at_micros: t.u64(),
  sealed: t.bool(),
  file_count: t.u32(),
  total_size_bytes: t.u64(),
});

function assertOwner(ctx: Ctx, ownerIdentity: string) {
  if (!ownerIdentity || ownerIdentity !== ctx.sender.toHexString()) {
    throw new SenderError('Only the transfer owner can modify it.');
  }
}

function deleteChunks(ctx: Ctx, fileId: bigint) {
  for (const chunk of ctx.db.fileChunk.by_file_chunk.filter(fileId)) {
    ctx.db.fileChunk.id.delete(chunk.id);
  }
}

function deleteStoredFile(ctx: Ctx, fileId: bigint) {
  const upload = ctx.db.uploadSession.file_id.find(fileId);
  if (upload) ctx.db.uploadSession.upload_token.delete(upload.upload_token);
  deleteChunks(ctx, fileId);
  ctx.db.fileBlob.id.delete(fileId);
  ctx.db.storedFile.id.delete(fileId);
}

function deleteTransferData(ctx: Ctx, transferId: bigint) {
  for (const file of [...ctx.db.storedFile.by_transfer.filter(transferId)]) {
    deleteStoredFile(ctx, file.id);
  }
  ctx.db.uploadLease.transfer_id.delete(transferId);
  ctx.db.transfer.id.delete(transferId);
}

function isTransferExpired(expiresAtMicros: bigint, nowMicros: bigint) {
  return expiresAtMicros !== 0n && expiresAtMicros <= nowMicros;
}

function purgeExpiredTransfers(ctx: Ctx) {
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const candidate of ctx.db.transfer.iter()) {
    const lease = candidate.sealed ? undefined : ctx.db.uploadLease.transfer_id.find(candidate.id);
    const expired = candidate.sealed
      ? isTransferExpired(candidate.expires_at_micros, now)
      : Boolean(lease && lease.expires_at_micros <= now);
    if (expired) deleteTransferData(ctx, candidate.id);
  }
}

function validateFileName(name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) throw new SenderError('File name is required.');
  if (trimmedName.length > 255) throw new SenderError('File name is too long.');
  return trimmedName;
}

function validateUploadToken(ctx: Ctx, uploadToken: string) {
  const trimmedToken = uploadToken.trim();
  if (!trimmedToken || trimmedToken.length > 128 || trimmedToken !== uploadToken) {
    throw new SenderError('Invalid upload token.');
  }
  if (ctx.db.uploadSession.upload_token.find(uploadToken)) {
    throw new SenderError('Upload token is already in use.');
  }
}
function bytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function requireUploadSession(ctx: Ctx, uploadToken: string) {
  const session = ctx.db.uploadSession.upload_token.find(uploadToken);
  if (!session) throw new SenderError('Upload session not found.');
  assertOwner(ctx, session.owner_identity);
  const file = ctx.db.storedFile.id.find(session.file_id);
  if (!file) throw new SenderError('Upload session is no longer active.');
  return { session, file };
}

function matchesUpload(
  file: {
    transfer_id: bigint;
    name: string;
    mime_type: string;
    size_bytes: bigint;
    chunk_size_bytes: number;
  },
  transferId: bigint,
  name: string,
  mimeType: string,
  sizeBytes: bigint,
  chunkSizeBytes: number
) {
  return file.transfer_id === transferId &&
    file.name === name.trim() &&
    file.mime_type === (mimeType || 'application/octet-stream') &&
    file.size_bytes === sizeBytes &&
    file.chunk_size_bytes === chunkSizeBytes;
}

function validateChunkSize(chunkSizeBytes: number) {
  if (
    chunkSizeBytes !== LEGACY_FILE_CHUNK_SIZE &&
    chunkSizeBytes !== 2 * LEGACY_FILE_CHUNK_SIZE &&
    chunkSizeBytes !== MAX_FILE_CHUNK_SIZE
  ) {
    throw new SenderError('Unsupported file chunk size.');
  }
}

function requireWritableTransfer(ctx: Ctx, transferId: bigint) {
  const candidate = ctx.db.transfer.id.find(transferId);
  if (!candidate) throw new SenderError('Transfer not found.');
  assertOwner(ctx, candidate.owner_identity);
  if (candidate.sealed) throw new SenderError('Transfer has already been sent.');
  let lease = ctx.db.uploadLease.transfer_id.find(candidate.id);
  if (!lease) {
    lease = ctx.db.uploadLease.insert({
      transfer_id: candidate.id,
      expires_at_micros: ctx.timestamp.microsSinceUnixEpoch + 24n * MICROS_PER_HOUR,
    });
  }
  if (lease.expires_at_micros <= ctx.timestamp.microsSinceUnixEpoch) {
    deleteTransferData(ctx, candidate.id);
    throw new SenderError('Upload session has expired.');
  }
  return candidate;
}
function startUploadSession(
  ctx: Ctx,
  transferId: bigint,
  uploadToken: string,
  name: string,
  mimeType: string,
  sizeBytes: bigint,
  chunkSizeBytes: number
) {
  requireWritableTransfer(ctx, transferId);
  const trimmedName = validateFileName(name);
  validateUploadToken(ctx, uploadToken);
  validateChunkSize(chunkSizeBytes);

  const sizePerChunk = BigInt(chunkSizeBytes);
  const chunkCount = sizeBytes === 0n ? 0n : (sizeBytes - 1n) / sizePerChunk + 1n;
  if (chunkCount > MAX_CHUNK_COUNT) throw new SenderError('File requires too many chunks.');

  const file = ctx.db.storedFile.insert({
    id: 0n,
    transfer_id: transferId,
    name: trimmedName,
    mime_type: mimeType || 'application/octet-stream',
    size_bytes: sizeBytes,
    created_at: ctx.timestamp,
    owner_identity: ctx.sender.toHexString(),
    ready: false,
    chunk_count: Number(chunkCount),
    chunk_size_bytes: chunkSizeBytes,
  });
  ctx.db.uploadSession.insert({
    upload_token: uploadToken,
    file_id: file.id,
    next_chunk_index: 0,
    received_bytes: 0n,
    created_at: ctx.timestamp,
    owner_identity: ctx.sender.toHexString(),
    chunk_size_bytes: chunkSizeBytes,
  });
}

export const createTransfer = spacetimedb.procedure(
  { expires_in_hours: t.u32() },
  createdTransferResult,
  (ctx, { expires_in_hours }) => {
    const expiryHours = expires_in_hours;
    if (expiryHours > MAX_EXPIRY_HOURS) {
      throw new SenderError('Transfers can be kept for at most 7 days or forever.');
    }
    const pickupCode = ctx.newUuidV4().toString().replace(/-/g, '').slice(0, 16).toUpperCase();
    return ctx.withTx((tx) => {
      purgeExpiredTransfers(tx);
      if (tx.db.transfer.pickup_code.find(pickupCode)) {
        throw new SenderError('Could not allocate a pickup code. Please retry.');
      }
      const expiresAtMicros = expiryHours === 0
        ? 0n
        : tx.timestamp.microsSinceUnixEpoch + BigInt(expiryHours) * MICROS_PER_HOUR;
      const created = tx.db.transfer.insert({
        id: 0n,
        pickup_code: pickupCode,
        owner_identity: tx.sender.toHexString(),
        created_at: tx.timestamp,
        expires_at_micros: expiresAtMicros,
        sealed: false,
      });
      tx.db.uploadLease.insert({
        transfer_id: created.id,
        expires_at_micros: tx.timestamp.microsSinceUnixEpoch + 24n * MICROS_PER_HOUR,
      });
      return {
        transfer_id: created.id,
        pickup_code: created.pickup_code,
        expires_at_micros: created.expires_at_micros,
      };
    });
  }
);

export const receiveTransfer = spacetimedb.procedure(
  { pickup_code: t.string() },
  transferResult,
  (ctx, { pickup_code }) => {
    const normalizedCode = normalizePickupCode(pickup_code);
    if (!normalizedCode) throw new SenderError('Invalid pickup code.');
    return ctx.withTx((tx) => {
      const candidate = tx.db.transfer.pickup_code.find(normalizedCode);
      if (!candidate || !candidate.sealed) throw new SenderError('Transfer not found.');
      if (isTransferExpired(candidate.expires_at_micros, tx.timestamp.microsSinceUnixEpoch)) {
        deleteTransferData(tx, candidate.id);
        throw new SenderError('Transfer has expired.');
      }
      const files = [...tx.db.storedFile.by_transfer.filter(candidate.id)]
        .filter((file) => file.ready)
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map((file) => ({
          id: file.id,
          name: file.name,
          mime_type: file.mime_type,
          size_bytes: file.size_bytes,
          created_at: file.created_at,
        }));
      return {
        pickup_code: candidate.pickup_code,
        expires_at_micros: candidate.expires_at_micros,
        files,
      };
    });
  }
);
export const getUploadStatus = spacetimedb.procedure(
  { upload_token: t.string() },
  uploadStatusResult,
  (ctx, { upload_token }) => ctx.withTx((tx) => {
    const { session, file } = requireUploadSession(tx, upload_token);
    const uploadedChunkIndexes = file.chunk_count === 0
      ? []
      : [...tx.db.fileChunk.by_file_chunk.filter(file.id)]
        .map((chunk) => chunk.chunk_index)
        .sort((left, right) => left - right);
    return {
      transfer_id: file.transfer_id,
      name: file.name,
      mime_type: file.mime_type,
      size_bytes: file.size_bytes,
      chunk_size_bytes: file.chunk_size_bytes,
      received_bytes: session.received_bytes,
      ready: file.ready,
      uploaded_chunk_indexes: uploadedChunkIndexes,
    };
  })
);
export const listOwnedTransfers = spacetimedb.procedure(
  {},
  t.array(ownedTransferResult),
  (ctx) => ctx.withTx((tx) => {
    purgeExpiredTransfers(tx);
    return [...tx.db.transfer.by_owner.filter(tx.sender.toHexString())]
      .sort((left, right) => left.id > right.id ? -1 : left.id < right.id ? 1 : 0)
      .map((candidate) => {
        const files = [...tx.db.storedFile.by_transfer.filter(candidate.id)]
          .filter((file) => file.ready);
        return {
          transfer_id: candidate.id,
          pickup_code: candidate.pickup_code,
          created_at: candidate.created_at,
          expires_at_micros: candidate.expires_at_micros,
          sealed: candidate.sealed,
          file_count: files.length,
          total_size_bytes: files.reduce((sum, file) => sum + file.size_bytes, 0n),
        };
      });
  })
);



export const uploadFile = spacetimedb.reducer(
  {
    transfer_id: t.u64(),
    upload_token: t.string(),
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
    content: t.byteArray(),
  },
  (ctx, { transfer_id, upload_token, name, mime_type, size_bytes, content }) => {
    const existingSession = ctx.db.uploadSession.upload_token.find(upload_token);
    if (existingSession) {
      const { file } = requireUploadSession(ctx, upload_token);
      const blob = ctx.db.fileBlob.id.find(file.id);
      if (
        !matchesUpload(file, transfer_id, name, mime_type, size_bytes, 0) ||
        !blob ||
        !bytesEqual(blob.content, content)
      ) {
        throw new SenderError('Upload token is already in use.');
      }
      return;
    }

    requireWritableTransfer(ctx, transfer_id);
    const trimmedName = validateFileName(name);
    validateUploadToken(ctx, upload_token);
    if (content.byteLength > MAX_FILE_CHUNK_SIZE) {
      throw new SenderError('File is too large for direct upload.');
    }
    if (BigInt(content.byteLength) !== size_bytes) {
      throw new SenderError('File size does not match its content.');
    }

    const file = ctx.db.storedFile.insert({
      id: 0n,
      transfer_id,
      name: trimmedName,
      mime_type: mime_type || 'application/octet-stream',
      size_bytes,
      created_at: ctx.timestamp,
      owner_identity: ctx.sender.toHexString(),
      ready: false,
      chunk_count: 0,
      chunk_size_bytes: 0,
    });
    ctx.db.fileBlob.insert({ id: file.id, content });
    ctx.db.uploadSession.insert({
      upload_token,
      file_id: file.id,
      next_chunk_index: 0,
      received_bytes: size_bytes,
      created_at: ctx.timestamp,
      owner_identity: ctx.sender.toHexString(),
      chunk_size_bytes: LEGACY_FILE_CHUNK_SIZE,
    });
  }
);

export const startUploadV2 = spacetimedb.reducer(
  {
    transfer_id: t.u64(),
    upload_token: t.string(),
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
    chunk_size_bytes: t.u32(),
  },
  (ctx, { transfer_id, upload_token, name, mime_type, size_bytes, chunk_size_bytes }) => {
    const existingSession = ctx.db.uploadSession.upload_token.find(upload_token);
    if (existingSession) {
      const { file } = requireUploadSession(ctx, upload_token);
      if (!matchesUpload(file, transfer_id, name, mime_type, size_bytes, chunk_size_bytes)) {
        throw new SenderError('Upload token is already in use.');
      }
      return;
    }
    startUploadSession(
      ctx,
      transfer_id,
      upload_token,
      name,
      mime_type,
      size_bytes,
      chunk_size_bytes
    );
  }
);

export const uploadChunk = spacetimedb.reducer(
  {
    upload_token: t.string(),
    chunk_index: t.u32(),
    content: t.byteArray(),
  },
  (ctx, { upload_token, chunk_index, content }) => {
    const { session, file } = requireUploadSession(ctx, upload_token);
    if (chunk_index >= file.chunk_count) throw new SenderError('Unexpected file chunk.');

    const existingChunks = [...ctx.db.fileChunk.by_file_chunk.filter([file.id, chunk_index])];
    if (existingChunks.length) {
      if (existingChunks.length === 1 && bytesEqual(existingChunks[0].content, content)) return;
      throw new SenderError('File chunk has already been uploaded with different content.');
    }
    if (file.ready) throw new SenderError('Upload session is no longer active.');
    requireWritableTransfer(ctx, file.transfer_id);

    const chunkOffset = BigInt(chunk_index) * BigInt(session.chunk_size_bytes);
    const remainingBytes = file.size_bytes - chunkOffset;
    const expectedBytes = Number(
      remainingBytes > BigInt(session.chunk_size_bytes)
        ? BigInt(session.chunk_size_bytes)
        : remainingBytes
    );
    if (content.byteLength !== expectedBytes) {
      throw new SenderError('File chunk size does not match the upload session.');
    }

    ctx.db.fileChunk.insert({
      id: 0n,
      file_id: file.id,
      chunk_index,
      content,
    });
    ctx.db.uploadSession.upload_token.update({
      ...session,
      next_chunk_index: session.next_chunk_index + 1,
      received_bytes: session.received_bytes + BigInt(content.byteLength),
    });
  }
);

export const finishUpload = spacetimedb.reducer(
  { upload_token: t.string() },
  (ctx, { upload_token }) => {
    const { session, file } = requireUploadSession(ctx, upload_token);
    if (file.ready) return;
    requireWritableTransfer(ctx, file.transfer_id);
    if (
      session.received_bytes !== file.size_bytes ||
      session.next_chunk_index !== file.chunk_count
    ) {
      throw new SenderError('Upload is incomplete.');
    }

    ctx.db.storedFile.id.update({
      ...file,
      ready: true,
      chunk_size_bytes: file.chunk_size_bytes || session.chunk_size_bytes,
    });
  }
);

export const cancelUpload = spacetimedb.reducer(
  { upload_token: t.string() },
  (ctx, { upload_token }) => {
    const session = ctx.db.uploadSession.upload_token.find(upload_token);
    if (!session) return;
    const { file } = requireUploadSession(ctx, upload_token);
    if (file.ready) return;
    deleteStoredFile(ctx, session.file_id);
  }
);

export const sealTransfer = spacetimedb.reducer(
  { transfer_id: t.u64() },
  (ctx, { transfer_id }) => {
    const candidate = requireWritableTransfer(ctx, transfer_id);
    const hasReadyFile = [...ctx.db.storedFile.by_transfer.filter(transfer_id)]
      .some((file) => file.ready);
    if (!hasReadyFile) throw new SenderError('Upload at least one file before sending.');
    ctx.db.transfer.id.update({ ...candidate, sealed: true });
    ctx.db.uploadLease.transfer_id.delete(transfer_id);
  }
);
export const updateTransferExpiry = spacetimedb.reducer(
  { transfer_id: t.u64(), expires_in_hours: t.u32() },
  (ctx, { transfer_id, expires_in_hours }) => {
    if (expires_in_hours > MAX_EXPIRY_HOURS) {
      throw new SenderError('Transfers can be kept for at most 7 days or forever.');
    }
    const candidate = ctx.db.transfer.id.find(transfer_id);
    if (!candidate) throw new SenderError('Transfer not found.');
    assertOwner(ctx, candidate.owner_identity);
    if (!candidate.sealed) throw new SenderError('Finish uploading before changing expiry.');
    const expiresAtMicros = expires_in_hours === 0
      ? 0n
      : ctx.timestamp.microsSinceUnixEpoch + BigInt(expires_in_hours) * MICROS_PER_HOUR;
    ctx.db.transfer.id.update({ ...candidate, expires_at_micros: expiresAtMicros });
  }
);


export const deleteTransfer = spacetimedb.reducer(
  { transfer_id: t.u64() },
  (ctx, { transfer_id }) => {
    const candidate = ctx.db.transfer.id.find(transfer_id);
    if (!candidate) return;
    assertOwner(ctx, candidate.owner_identity);
    deleteTransferData(ctx, transfer_id);
  }
);

function parseBatchFileIds(uri: string) {
  const queryStart = uri.indexOf('?');
  if (queryStart === -1) return null;
  const fragmentStart = uri.indexOf('#', queryStart + 1);
  const query = uri.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
  let rawIds: string | null = null;
  for (const parameter of query.split('&')) {
    const separator = parameter.indexOf('=');
    const rawKey = separator === -1 ? parameter : parameter.slice(0, separator);
    const rawValue = separator === -1 ? '' : parameter.slice(separator + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      return null;
    }
    if (key !== 'ids') continue;
    if (rawIds !== null) return null;
    rawIds = value;
  }
  if (!rawIds) return null;
  const parts = rawIds.split(',');
  if (!parts.length || parts.length > 1000) return null;
  const ids: bigint[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (!/^(0|[1-9]\d*)$/.test(part) || seen.has(part)) return null;
    const id = BigInt(part);
    if (id > 0xffff_ffff_ffff_ffffn) return null;
    seen.add(part);
    ids.push(id);
  }
  return ids;
}

function archiveEntryNames(names: string[]) {
  const used = new Set<string>();
  return names.map((name) => {
    const safeName = name.replace(/[\\/]/g, '_').replace(/^\.+/, '') || 'file';
    let candidate = safeName;
    let suffix = 2;
    while (used.has(candidate)) {
      const dot = safeName.lastIndexOf('.');
      candidate = dot > 0
        ? `${safeName.slice(0, dot)} (${suffix})${safeName.slice(dot)}`
        : `${safeName} (${suffix})`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

const DOWNLOAD_CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Range, If-Range',
  'access-control-expose-headers':
    'Accept-Ranges, Content-Length, Content-Range, Content-Disposition, ETag',
};

function textResponse(message: string, status: number) {
  return new SyncResponse(message, {
    status,
    headers: {
      ...DOWNLOAD_CORS_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(new TextEncoder().encode(message).byteLength),
    },
  });
}

function fileHeaders(file: {
  id: bigint;
  name: string;
  mime_type: string;
  size_bytes: bigint;
  chunk_count: number;
}, inlinePreview: boolean) {
  return {
    ...DOWNLOAD_CORS_HEADERS,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-disposition': contentDisposition(file.name, inlinePreview ? 'inline' : 'attachment'),
    'content-type': file.mime_type || 'application/octet-stream',
    etag: `"ydrive-${file.id}-${file.size_bytes}-${file.chunk_count}"`,
  };
}
function readWholeFile(ctx: Ctx, file: {
  id: bigint;
  size_bytes: bigint;
  chunk_count: number;
  chunk_size_bytes: number;
}) {
  if (file.size_bytes === 0n) return new Uint8Array();
  if (file.chunk_count === 0) {
    const blob = ctx.db.fileBlob.id.find(file.id);
    if (!blob || BigInt(blob.content.byteLength) !== file.size_bytes) return null;
    return new Uint8Array(blob.content);
  }
  const getChunk = (chunkIndex: number) => {
    const matches = [...ctx.db.fileChunk.by_file_chunk.filter([file.id, chunkIndex])];
    return matches.length === 1 ? new Uint8Array(matches[0].content) : undefined;
  };
  const chunkSizeBytes = file.chunk_size_bytes || getChunk(0)?.byteLength || 0;
  try {
    return assembleByteRange(
      { start: 0n, end: file.size_bytes - 1n },
      chunkSizeBytes,
      getChunk
    );
  } catch {
    return null;
  }
}

export const downloadBatch = spacetimedb.httpHandler((ctx, request) => {
  const pickupCode = parsePickupCodeFromUri(request.uri);
  const fileIds = parseBatchFileIds(request.uri);
  if (!pickupCode || !fileIds) return textResponse('A pickup code and file ids are required.', 400);

  return ctx.withTx((tx) => {
    const transferRow = tx.db.transfer.pickup_code.find(pickupCode);
    if (!transferRow || !transferRow.sealed) return textResponse('Transfer not found.', 404);
    if (isTransferExpired(transferRow.expires_at_micros, tx.timestamp.microsSinceUnixEpoch)) {
      deleteTransferData(tx, transferRow.id);
      return textResponse('Transfer expired.', 410);
    }
    const files = fileIds.map((fileId) => tx.db.storedFile.id.find(fileId));
    if (files.some((file) => !file || !file.ready || file.transfer_id !== transferRow.id)) {
      return textResponse('File not found.', 404);
    }
    const readyFiles = files.filter((file): file is NonNullable<typeof file> => Boolean(file));
    try {
      const names = archiveEntryNames(readyFiles.map((file) => file.name));
      const entries: Array<{ name: string; content: Uint8Array }> = [];
      for (let index = 0; index < readyFiles.length; index += 1) {
        const content = readWholeFile(tx, readyFiles[index]);
        if (!content) return textResponse('File content is unavailable.', 500);
        entries.push({ name: names[index], content });
      }
      const body = createZipArchive(entries);
      return new SyncResponse(body, {
        status: 200,
        headers: {
          ...DOWNLOAD_CORS_HEADERS,
          'cache-control': 'private, no-store',
          'content-type': 'application/zip',
          'content-disposition': contentDisposition(`YDrive-${pickupCode}.zip`),
          'content-length': String(body.byteLength),
        },
      });
    } catch (error) {
      if (error instanceof RangeError) return textResponse(error.message, 413);
      return textResponse('File content is unavailable.', 500);
    }
  });
});


function downloadHandler(headOnly: boolean) {
  return spacetimedb.httpHandler((ctx, request) => {
    const fileId = parseDownloadFileId(request.uri);
    const pickupCode = parsePickupCodeFromUri(request.uri);
    if (fileId === null || pickupCode === null) {
      return textResponse('A valid file id and pickup code are required.', 400);
    }

    return ctx.withTx((tx) => {
      const transferRow = tx.db.transfer.pickup_code.find(pickupCode);
      if (!transferRow || !transferRow.sealed) return textResponse('File not found.', 404);
      if (isTransferExpired(transferRow.expires_at_micros, tx.timestamp.microsSinceUnixEpoch)) {
        deleteTransferData(tx, transferRow.id);
        return textResponse('Transfer expired.', 410);
      }

      const file = tx.db.storedFile.id.find(fileId);
      if (!file || !file.ready || file.transfer_id !== transferRow.id) {
        return textResponse('File not found.', 404);
      }

      const inlinePreview = /(?:[?&])preview=1(?:[&#]|$)/.test(request.uri) &&
        /^(image|audio|video)\//i.test(file.mime_type);
      const headers = fileHeaders(file, inlinePreview);
      if (headOnly) {
        return new SyncResponse(null, {
          status: 200,
          headers: { ...headers, 'content-length': String(file.size_bytes) },
        });
      }

      const ifRange = request.headers.get('if-range');
      const requestedRange = ifRange && ifRange !== headers.etag
        ? null
        : request.headers.get('range');
      const parsedRange = parseByteRange(requestedRange, file.size_bytes);
      if (parsedRange.kind === 'unsatisfiable') {
        return new SyncResponse(null, {
          status: 416,
          headers: {
            ...headers,
            'content-length': '0',
            'content-range': `bytes */${file.size_bytes}`,
          },
        });
      }

      const range: ByteRange = parsedRange.kind === 'partial'
        ? parsedRange.range
        : { start: 0n, end: file.size_bytes - 1n };
      let body: Uint8Array;

      if (file.size_bytes === 0n) {
        body = new Uint8Array();
      } else if (parsedRange.kind === 'full') {
        const content = readWholeFile(tx, file);
        if (!content) return textResponse('File content is unavailable.', 500);
        body = content;
      } else if (file.chunk_count === 0) {
        const blob = tx.db.fileBlob.id.find(file.id);
        if (!blob || BigInt(blob.content.byteLength) !== file.size_bytes) {
          return textResponse('File content is unavailable.', 500);
        }
        body = new Uint8Array(blob.content).subarray(Number(range.start), Number(range.end + 1n));
      } else {
        const getChunk = (chunkIndex: number) => {
          const matches = [...tx.db.fileChunk.by_file_chunk.filter([file.id, chunkIndex])];
          return matches.length === 1 ? new Uint8Array(matches[0].content) : undefined;
        };
        const chunkSizeBytes = file.chunk_size_bytes || getChunk(0)?.byteLength || 0;
        try {
          body = assembleByteRange(range, chunkSizeBytes, getChunk);
        } catch {
          return textResponse('File content is unavailable.', 500);
        }
      }

      const responseHeaders: Record<string, string> = {
        ...headers,
        'content-length': String(body.byteLength),
      };
      if (parsedRange.kind === 'partial') {
        responseHeaders['content-range'] =
          `bytes ${range.start}-${range.end}/${file.size_bytes}`;
      }
      return new SyncResponse(body, {
        status: parsedRange.kind === 'partial' ? 206 : 200,
        headers: responseHeaders,
      });
    });
  });
}

export const downloadFile = downloadHandler(false);
export const headDownloadFile = downloadHandler(true);
export const downloadOptions = spacetimedb.httpHandler(() =>
  new SyncResponse(null, {
    status: 204,
    headers: {
      ...DOWNLOAD_CORS_HEADERS,
      allow: 'GET, HEAD, OPTIONS',
      'content-length': '0',
    },
  })
);

export const httpRoutes = spacetimedb.httpRouter(
  new Router()
    .get('/download', downloadFile)
    .get('/download-batch', downloadBatch)
    .head('/download', headDownloadFile)
    .options('/download', downloadOptions)
    .options('/download-batch', downloadOptions)
);
