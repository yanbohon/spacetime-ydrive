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
  parseByteRange,
  parseDownloadFileId,
  type ByteRange,
} from './download';

const LEGACY_FILE_CHUNK_SIZE = 1024 * 1024;
const MAX_FILE_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_CHUNK_COUNT = 0xffff_ffffn;

const storedFile = table(
  { name: 'stored_file', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
    created_at: t.timestamp(),
    ready: t.bool().default(true),
    chunk_count: t.u32().default(0),
    // Zero marks rows created before this column existed; the handler infers from chunk 0.
    chunk_size_bytes: t.u32().default(0),
  }
);

const fileBlob = table(
  { name: 'file_blob', public: true },
  {
    id: t.u64().primaryKey(),
    content: t.byteArray(),
  }
);

const fileChunk = table(
  {
    name: 'file_chunk',
    public: true,
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
  { name: 'upload_session' },
  {
    upload_token: t.string().primaryKey(),
    file_id: t.u64().unique(),
    // Kept for migration compatibility; parallel uploads use this as the accepted chunk count.
    next_chunk_index: t.u32(),
    received_bytes: t.u64(),
    created_at: t.timestamp(),
    chunk_size_bytes: t.u32().default(LEGACY_FILE_CHUNK_SIZE),
  }
);

const spacetimedb = schema({ storedFile, fileBlob, fileChunk, uploadSession });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

function deleteChunks(ctx: Ctx, fileId: bigint) {
  const chunks = [...ctx.db.fileChunk.by_file_chunk.filter(fileId)];
  for (const chunk of chunks) {
    ctx.db.fileChunk.id.delete(chunk.id);
  }
}

function deleteUpload(ctx: Ctx, uploadToken: string) {
  const session = ctx.db.uploadSession.upload_token.find(uploadToken);
  if (!session) return;

  deleteChunks(ctx, session.file_id);
  ctx.db.fileBlob.id.delete(session.file_id);
  ctx.db.storedFile.id.delete(session.file_id);
  ctx.db.uploadSession.upload_token.delete(uploadToken);
}

function validateFileName(name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new SenderError('File name is required.');
  }
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

function validateChunkSize(chunkSizeBytes: number) {
  if (
    chunkSizeBytes !== LEGACY_FILE_CHUNK_SIZE &&
    chunkSizeBytes !== 2 * LEGACY_FILE_CHUNK_SIZE &&
    chunkSizeBytes !== MAX_FILE_CHUNK_SIZE
  ) {
    throw new SenderError('Unsupported file chunk size.');
  }
}

function startUploadSession(
  ctx: Ctx,
  uploadToken: string,
  name: string,
  mimeType: string,
  sizeBytes: bigint,
  chunkSizeBytes: number
) {
  const trimmedName = validateFileName(name);
  validateUploadToken(ctx, uploadToken);
  validateChunkSize(chunkSizeBytes);

  const sizePerChunk = BigInt(chunkSizeBytes);
  const chunkCount = sizeBytes === 0n ? 0n : (sizeBytes - 1n) / sizePerChunk + 1n;
  if (chunkCount > MAX_CHUNK_COUNT) {
    throw new SenderError('File is too large.');
  }

  const file = ctx.db.storedFile.insert({
    id: 0n,
    name: trimmedName,
    mime_type: mimeType || 'application/octet-stream',
    size_bytes: sizeBytes,
    created_at: ctx.timestamp,
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
    chunk_size_bytes: chunkSizeBytes,
  });
}

export const uploadFile = spacetimedb.reducer(
  {
    upload_token: t.string(),
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
    content: t.byteArray(),
  },
  (ctx, { upload_token, name, mime_type, size_bytes, content }) => {
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
      name: trimmedName,
      mime_type: mime_type || 'application/octet-stream',
      size_bytes,
      created_at: ctx.timestamp,
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
      chunk_size_bytes: LEGACY_FILE_CHUNK_SIZE,
    });
  }
);

export const startUpload = spacetimedb.reducer(
  {
    upload_token: t.string(),
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
  },
  (ctx, { upload_token, name, mime_type, size_bytes }) => {
    startUploadSession(
      ctx,
      upload_token,
      name,
      mime_type,
      size_bytes,
      LEGACY_FILE_CHUNK_SIZE
    );
  }
);

export const startUploadV2 = spacetimedb.reducer(
  {
    upload_token: t.string(),
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
    chunk_size_bytes: t.u32(),
  },
  (ctx, { upload_token, name, mime_type, size_bytes, chunk_size_bytes }) => {
    startUploadSession(
      ctx,
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
    const session = ctx.db.uploadSession.upload_token.find(upload_token);
    if (!session) {
      throw new SenderError('Upload session not found.');
    }
    const file = ctx.db.storedFile.id.find(session.file_id);
    if (!file || file.ready) {
      throw new SenderError('Upload session is no longer active.');
    }
    if (chunk_index >= file.chunk_count) {
      throw new SenderError('Unexpected file chunk.');
    }
    if ([...ctx.db.fileChunk.by_file_chunk.filter([file.id, chunk_index])].length) {
      throw new SenderError('File chunk has already been uploaded.');
    }

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
    const receivedChunkCount = session.next_chunk_index + 1;
    ctx.db.uploadSession.upload_token.update({
      ...session,
      next_chunk_index: receivedChunkCount,
      received_bytes: session.received_bytes + BigInt(content.byteLength),
    });
  }
);

export const finishUpload = spacetimedb.reducer(
  { upload_token: t.string() },
  (ctx, { upload_token }) => {
    const session = ctx.db.uploadSession.upload_token.find(upload_token);
    if (!session) {
      throw new SenderError('Upload session not found.');
    }
    const file = ctx.db.storedFile.id.find(session.file_id);
    if (!file) {
      throw new SenderError('Upload session is no longer active.');
    }
    const receivedChunkCount = session.next_chunk_index;
    if (
      session.received_bytes !== file.size_bytes ||
      receivedChunkCount !== file.chunk_count
    ) {
      throw new SenderError('Upload is incomplete.');
    }

    ctx.db.storedFile.id.update({
      ...file,
      ready: true,
      chunk_size_bytes: file.chunk_size_bytes || session.chunk_size_bytes,
    });
    ctx.db.uploadSession.upload_token.delete(upload_token);
  }
);

export const cancelUpload = spacetimedb.reducer(
  { upload_token: t.string() },
  (ctx, { upload_token }) => {
    deleteUpload(ctx, upload_token);
  }
);

export const deleteFile = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    if (!ctx.db.storedFile.id.find(id)) {
      throw new SenderError('File not found.');
    }
    const upload = ctx.db.uploadSession.file_id.find(id);
    if (upload) {
      ctx.db.uploadSession.upload_token.delete(upload.upload_token);
    }
    deleteChunks(ctx, id);
    ctx.db.fileBlob.id.delete(id);
    ctx.db.storedFile.id.delete(id);
  }
);

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
}) {
  return {
    ...DOWNLOAD_CORS_HEADERS,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-cache',
    'content-disposition': contentDisposition(file.name),
    'content-type': file.mime_type || 'application/octet-stream',
    etag: `"ydrive-${file.id}-${file.size_bytes}-${file.chunk_count}"`,
  };
}

function downloadHandler(headOnly: boolean) {
  return spacetimedb.httpHandler((ctx, request) => {
    const fileId = parseDownloadFileId(request.uri);
    if (fileId === null) return textResponse('A valid file id is required.', 400);

    return ctx.withTx((tx) => {
      const file = tx.db.storedFile.id.find(fileId);
      if (!file || !file.ready) return textResponse('File not found.', 404);

      const headers = fileHeaders(file);
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
      } else if (file.chunk_count === 0) {
        const blob = tx.db.fileBlob.id.find(file.id);
        if (!blob || BigInt(blob.content.byteLength) !== file.size_bytes) {
          return textResponse('File content is unavailable.', 500);
        }
        body = new Uint8Array(blob.content).subarray(
          Number(range.start),
          Number(range.end + 1n)
        );
      } else {
        const cachedChunks = new Map<number, Uint8Array>();
        const getChunk = (chunkIndex: number) => {
          const cached = cachedChunks.get(chunkIndex);
          if (cached) return cached;
          const matches = [
            ...tx.db.fileChunk.by_file_chunk.filter([file.id, chunkIndex]),
          ];
          if (matches.length !== 1) return undefined;
          const content = new Uint8Array(matches[0].content);
          cachedChunks.set(chunkIndex, content);
          return content;
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
    .head('/download', headDownloadFile)
    .options('/download', downloadOptions)
);
