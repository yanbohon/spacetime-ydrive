import { schema, SenderError, table, t } from 'spacetimedb/server';

const storedFile = table(
  { name: 'stored_file', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
    created_at: t.timestamp(),
  }
);

const fileBlob = table(
  { name: 'file_blob', public: true },
  {
    id: t.u64().primaryKey(),
    content: t.byteArray(),
  }
);

const spacetimedb = schema({ storedFile, fileBlob });
export default spacetimedb;

export const uploadFile = spacetimedb.reducer(
  {
    name: t.string(),
    mime_type: t.string(),
    size_bytes: t.u64(),
    content: t.byteArray(),
  },
  (ctx, { name, mime_type, size_bytes, content }) => {
    if (!name.trim()) {
      throw new SenderError('File name is required.');
    }
    if (BigInt(content.byteLength) !== size_bytes) {
      throw new SenderError('File size does not match its content.');
    }

    const file = ctx.db.storedFile.insert({
      id: 0n,
      name: name.trim(),
      mime_type: mime_type || 'application/octet-stream',
      size_bytes,
      created_at: ctx.timestamp,
    });
    ctx.db.fileBlob.insert({ id: file.id, content });
  }
);

export const deleteFile = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    if (!ctx.db.storedFile.id.find(id)) {
      throw new SenderError('File not found.');
    }
    ctx.db.fileBlob.id.delete(id);
    ctx.db.storedFile.id.delete(id);
  }
);
