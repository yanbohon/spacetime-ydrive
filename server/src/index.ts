import {
  schema,
  SenderError,
  table,
  t,
  type InferSchema,
  type ReducerCtx,
} from 'spacetimedb/server';

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

    ctx.db.storedFile.id.update({ ...file, ready: true });
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
