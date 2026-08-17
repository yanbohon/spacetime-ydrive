import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FILE_CHUNK_SIZE,
  uploadFileInChunks,
} from './upload.ts';

function makeFile(size, name = 'large.bin') {
  const blob = new Blob([new Uint8Array(size)], {
    type: 'application/octet-stream',
  });
  return {
    name,
    type: blob.type,
    size: blob.size,
    slice: blob.slice.bind(blob),
  };
}

test('uploads a large file as bounded chunks and reports committed bytes', async () => {
  const file = makeFile(FILE_CHUNK_SIZE * 3 + 137);
  const chunkSizes = [];
  const progress = [];
  let finished = false;

  await uploadFileInChunks({
    file,
    uploadToken: 'large-file-test',
    timeoutMs: 100,
    reducers: {
      startUpload: async () => {},
      uploadChunk: async ({ content }) => {
        chunkSizes.push(content.byteLength);
      },
      finishUpload: async () => {
        finished = true;
      },
      cancelUpload: async () => {
        assert.fail('a successful upload must not be cancelled');
      },
    },
    onProgress: (uploadedBytes) => progress.push(uploadedBytes),
  });

  assert.equal(finished, true);
  assert.deepEqual(chunkSizes, [
    FILE_CHUNK_SIZE,
    FILE_CHUNK_SIZE,
    FILE_CHUNK_SIZE,
    137,
  ]);
  assert.ok(chunkSizes.every((size) => size <= FILE_CHUNK_SIZE));
  assert.deepEqual(progress, [
    0,
    FILE_CHUNK_SIZE,
    FILE_CHUNK_SIZE * 2,
    FILE_CHUNK_SIZE * 3,
    file.size,
  ]);
});

test('rejects and cancels when a reducer promise never settles', async () => {
  const file = makeFile(FILE_CHUNK_SIZE + 1, 'disconnected.bin');
  let cancelled = false;

  await assert.rejects(
    uploadFileInChunks({
      file,
      uploadToken: 'disconnect-test',
      timeoutMs: 10,
      reducers: {
        startUpload: async () => {},
        uploadChunk: async () => new Promise(() => {}),
        finishUpload: async () => {
          assert.fail('a timed-out upload must not finish');
        },
        cancelUpload: async () => {
          cancelled = true;
        },
      },
    }),
    /上传分块超时/
  );

  assert.equal(cancelled, true);
});
