import {
  schema,
  SenderError,
  table,
  t,
  type InferSchema,
  type ReducerCtx,
} from 'spacetimedb/server';

const FILE_CHUNK_SIZE = 1024 * 1024;
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
  { name: 'file_chunk', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    file_id: t.u64().index('btree'),
    chunk_index: t.u32(),
    content: t.byteArray(),
  }
);

const uploadSession = table(
  { name: 'upload_session' },
  {
    upload_token: t.string().primaryKey(),
    file_id: t.u64().unique(),
    next_chunk_index: t.u32(),
    received_bytes: t.u64(),
    created_at: t.timestamp(),
  }
);

const spacetimedb = schema({ storedFile, fileBlob, fileChunk, uploadSession });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

function deleteChunks(ctx: Ctx, fileId: bigint) {
  const chunks = [...ctx.db.fileChunk.file_id.filter(fileId)];
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

export const startUpload = spacetimedb.reducer(
  {
    upload_token: t.string(),
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
  },
  (ctx, { upload_token, name, mime_type, size_bytes }) => {
    const trimmedName = name.trim();
    const trimmedToken = upload_token.trim();
    if (!trimmedName) {
      throw new SenderError('File name is required.');
    }
    if (!trimmedToken || trimmedToken.length > 128 || trimmedToken !== upload_token) {
      throw new SenderError('Invalid upload token.');
    }
    if (ctx.db.uploadSession.upload_token.find(upload_token)) {
      throw new SenderError('Upload token is already in use.');
    }

    const sizePerChunk = BigInt(FILE_CHUNK_SIZE);
    const chunkCount = size_bytes === 0n ? 0n : (size_bytes - 1n) / sizePerChunk + 1n;
    if (chunkCount > MAX_CHUNK_COUNT) {
      throw new SenderError('File is too large.');
    }

    const file = ctx.db.storedFile.insert({
      id: 0n,
      name: trimmedName,
      mime_type: mime_type || 'application/octet-stream',
      size_bytes,
      created_at: ctx.timestamp,
      ready: false,
      chunk_count: Number(chunkCount),
    });
    ctx.db.uploadSession.insert({
      upload_token,
      file_id: file.id,
      next_chunk_index: 0,
      received_bytes: 0n,
      created_at: ctx.timestamp,
    });
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
    if (chunk_index !== session.next_chunk_index) {
      throw new SenderError('File chunks must be uploaded in order.');
    }
    if (chunk_index >= file.chunk_count) {
      throw new SenderError('Unexpected file chunk.');
    }

    const remainingBytes = file.size_bytes - session.received_bytes;
    const expectedBytes = Number(
      remainingBytes > BigInt(FILE_CHUNK_SIZE)
        ? BigInt(FILE_CHUNK_SIZE)
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
    const session = ctx.db.uploadSession.upload_token.find(upload_token);
    if (!session) {
      throw new SenderError('Upload session not found.');
    }
    const file = ctx.db.storedFile.id.find(session.file_id);
    if (!file || file.ready) {
      throw new SenderError('Upload session is no longer active.');
    }
    if (
      session.received_bytes !== file.size_bytes ||
      session.next_chunk_index !== file.chunk_count
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
