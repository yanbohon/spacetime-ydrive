import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FILE_CHUNK_SIZE,
  uploadFileInChunks,
  uploadFilesConcurrently,
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

test('keeps multiple chunks in flight for the same file', async () => {
  const file = makeFile(FILE_CHUNK_SIZE * 4, 'parallel.bin');
  let inFlight = 0;
  let maxInFlight = 0;

  await uploadFileInChunks({
    file,
    uploadToken: 'parallel-test',
    chunkConcurrency: 3,
    timeoutMs: 100,
    reducers: {
      startUpload: async () => {},
      uploadChunk: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
      finishUpload: async () => {},
      cancelUpload: async () => {},
    },
  });

  assert.equal(maxInFlight, 3);
});

test('uploads multiple files concurrently while respecting the global chunk limit', async () => {
  const files = [
    makeFile(FILE_CHUNK_SIZE * 3, 'one.bin'),
    makeFile(FILE_CHUNK_SIZE * 3, 'two.bin'),
    makeFile(FILE_CHUNK_SIZE * 3, 'three.bin'),
  ];
  const activeSessions = new Set();
  const progress = [];
  let activeChunks = 0;
  let maxActiveChunks = 0;
  let maxActiveFiles = 0;

  const result = await uploadFilesConcurrently({
    files,
    fileConcurrency: 2,
    chunkConcurrency: 4,
    timeoutMs: 100,
    reducers: {
      startUpload: async ({ uploadToken }) => {
        activeSessions.add(uploadToken);
        maxActiveFiles = Math.max(maxActiveFiles, activeSessions.size);
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      uploadChunk: async () => {
        activeChunks += 1;
        maxActiveChunks = Math.max(maxActiveChunks, activeChunks);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeChunks -= 1;
      },
      finishUpload: async ({ uploadToken }) => {
        activeSessions.delete(uploadToken);
      },
      cancelUpload: async ({ uploadToken }) => {
        activeSessions.delete(uploadToken);
      },
    },
    onProgress: (nextProgress) => progress.push(nextProgress),
  });

  assert.deepEqual(result.uploadedFiles.map((file) => file.name), [
    'one.bin',
    'two.bin',
    'three.bin',
  ]);
  assert.deepEqual(result.failedFiles, []);
  assert.equal(maxActiveFiles, 2);
  assert.equal(maxActiveChunks, 4);
  assert.ok(progress.some((item) => item.activeFiles === 2));
  assert.equal(progress.at(-1).completedFiles, 3);
  assert.equal(progress.at(-1).percent, 100);
});

test('a batch timeout aborts queued chunks instead of starting more timeout waves', async () => {
  const files = [
    makeFile(FILE_CHUNK_SIZE * 3, 'one-timeout.bin'),
    makeFile(FILE_CHUNK_SIZE * 3, 'two-timeout.bin'),
    makeFile(FILE_CHUNK_SIZE * 3, 'three-timeout.bin'),
  ];
  let uploadChunkCalls = 0;
  let cancelCalls = 0;

  const result = await uploadFilesConcurrently({
    files,
    fileConcurrency: 3,
    chunkConcurrency: 3,
    timeoutMs: 20,
    reducers: {
      startUpload: async () => {},
      uploadChunk: async () => {
        uploadChunkCalls += 1;
        return new Promise(() => {});
      },
      finishUpload: async () => {
        assert.fail('a disconnected batch must not finish');
      },
      cancelUpload: async () => {
        cancelCalls += 1;
      },
    },
  });

  assert.equal(uploadChunkCalls, 3);
  assert.equal(cancelCalls, 3);
  assert.equal(result.uploadedFiles.length, 0);
  assert.equal(result.failedFiles.length, 3);
  assert.ok(result.failedFiles.every(({ error }) => error instanceof Error));
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
