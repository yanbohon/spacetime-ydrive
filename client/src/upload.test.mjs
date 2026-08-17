import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CHUNK_CONCURRENCY,
  DEFAULT_FILE_CHUNK_SIZE,
  DEFAULT_MAX_IN_FLIGHT_BYTES,
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

test('uses larger v2 chunks while keeping the default in-flight window bounded', async () => {
  const fourMiB = 4 * 1024 * 1024;
  const file = makeFile(fourMiB * 3 + 137, 'optimized.bin');
  const chunkSizes = [];
  let advertisedChunkSize = 0;
  let activeBytes = 0;
  let maxActiveBytes = 0;

  await uploadFileInChunks({
    transferId: 1n,
    file,
    uploadToken: 'optimized-file-test',
    timeoutMs: 100,
    reducers: {
      uploadFile: async () => assert.fail('large files must use chunked upload'),
      startUploadV2: async ({ transferId, chunkSizeBytes }) => {
        assert.equal(transferId, 1n);
        advertisedChunkSize = chunkSizeBytes;
      },
      uploadChunk: async ({ content }) => {
        chunkSizes.push(content.byteLength);
        activeBytes += content.byteLength;
        maxActiveBytes = Math.max(maxActiveBytes, activeBytes);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeBytes -= content.byteLength;
      },
      finishUpload: async () => {},
      cancelUpload: async () => {},
    },
  });

  assert.equal(DEFAULT_FILE_CHUNK_SIZE, fourMiB);
  assert.equal(advertisedChunkSize, fourMiB);
  assert.deepEqual(chunkSizes, [fourMiB, fourMiB, fourMiB, 137]);
  assert.equal(DEFAULT_CHUNK_CONCURRENCY, 2);
  assert.equal(DEFAULT_MAX_IN_FLIGHT_BYTES, 8 * 1024 * 1024);
  assert.ok(maxActiveBytes <= DEFAULT_MAX_IN_FLIGHT_BYTES);
});

test('uploads files larger than the former 64 MiB limit', async () => {
  const fourMiB = 4 * 1024 * 1024;
  const fileSize = 64 * 1024 * 1024 + 1;
  let advertisedSize = 0n;
  let uploadedChunks = 0;

  await uploadFileInChunks({
    transferId: 1n,
    file: {
      name: 'unlimited.bin',
      type: 'application/octet-stream',
      size: fileSize,
      slice: (start, end) => ({
        arrayBuffer: async () => new ArrayBuffer(end - start),
      }),
    },
    transferPolicy: {
      chunkSizeBytes: fourMiB,
      chunkConcurrency: 1,
      maxInFlightBytes: fourMiB,
    },
    reducers: {
      uploadFile: async () => assert.fail('large files must use chunked upload'),
      startUploadV2: async ({ sizeBytes }) => { advertisedSize = sizeBytes; },
      uploadChunk: async () => { uploadedChunks += 1; },
      finishUpload: async () => {},
      cancelUpload: async () => {},
    },
  });

  assert.equal(advertisedSize, BigInt(fileSize));
  assert.equal(uploadedChunks, 17);
});

test('uploads a file no larger than one chunk with one binary write', async () => {
  const file = makeFile(1024 * 1024 + 137, 'small-fast-path.bin');
  const progress = [];
  let uploadedContent;
  let finalized = false;

  await uploadFileInChunks({
    transferId: 1n,
    file,
    uploadToken: 'unused-on-fast-path',
    timeoutMs: 100,
    reducers: {
      uploadFile: async ({ transferId, content }) => {
        assert.equal(transferId, 1n);
        uploadedContent = content;
      },
      startUploadV2: async () => assert.fail('the fast path must not create a session'),
      uploadChunk: async () => assert.fail('the fast path must not upload a chunk'),
      finishUpload: async () => {
        finalized = true;
      },
      cancelUpload: async () => assert.fail('the fast path must not cancel a session'),
    },
    onProgress: (uploadedBytes) => progress.push(uploadedBytes),
  });

  assert.equal(uploadedContent?.byteLength, file.size);
  assert.equal(finalized, true);
  assert.deepEqual(progress, [0, file.size]);
});

test('preserves a timed-out direct upload so it can be resumed', async () => {
  const file = makeFile(1024, 'small-timeout.bin');

  await assert.rejects(
    uploadFileInChunks({
      transferId: 1n,
      file,
      uploadToken: 'small-timeout-token',
      timeoutMs: 10,
      retryAttempts: 1,
      reducers: {
        uploadFile: async () => new Promise(() => {}),
        startUploadV2: async () => assert.fail('direct uploads must not create a chunk session'),
        uploadChunk: async () => assert.fail('direct uploads must not send chunks'),
        finishUpload: async () => assert.fail('a timed-out direct upload must not finish'),
        cancelUpload: async () => assert.fail('a timed-out upload must remain resumable'),
      },
    }),
    /上传文件超时/
  );
});

test('uploads a large file as bounded chunks and reports committed bytes', async () => {
  const file = makeFile(FILE_CHUNK_SIZE * 3 + 137);
  const chunkSizes = [];
  const progress = [];
  let finished = false;

  await uploadFileInChunks({
    transferId: 1n,
    file,
    uploadToken: 'large-file-test',
    timeoutMs: 100,
    reducers: {
      startUploadV2: async () => {},
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
    transferId: 1n,
    file,
    uploadToken: 'parallel-test',
    transferPolicy: {
      chunkSizeBytes: FILE_CHUNK_SIZE,
      chunkConcurrency: 3,
      maxInFlightBytes: FILE_CHUNK_SIZE * 3,
    },
    timeoutMs: 100,
    reducers: {
      startUploadV2: async () => {},
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
test('retries a transient chunk failure with the same chunk index', async () => {
  const file = makeFile(FILE_CHUNK_SIZE + 1, 'retry.bin');
  const chunkIndexes = [];

  await uploadFileInChunks({
    transferId: 1n,
    file,
    uploadToken: 'retry-token',
    retryDelayMs: 1,
    reducers: {
      startUploadV2: async () => {},
      uploadChunk: async ({ chunkIndex }) => {
        chunkIndexes.push(chunkIndex);
        if (chunkIndex === 0 && chunkIndexes.length === 1) throw new Error('temporary disconnect');
      },
      finishUpload: async () => {},
      cancelUpload: async () => assert.fail('a successful retry must not cancel the upload'),
    },
  });

  assert.deepEqual(chunkIndexes, [0, 1, 0]);
});
test('does not retry deterministic sender errors', async () => {
  const file = makeFile(1024, 'invalid.bin');
  let uploadCalls = 0;
  let cancelCalls = 0;

  await assert.rejects(
    uploadFileInChunks({
      transferId: 1n,
      file,
      retryDelayMs: 1,
      reducers: {
        uploadFile: async () => {
          uploadCalls += 1;
          throw new Error('SenderError: Invalid upload token.');
        },
        startUploadV2: async () => assert.fail('direct uploads must not create a chunk session'),
        uploadChunk: async () => assert.fail('direct uploads must not upload chunks'),
        finishUpload: async () => assert.fail('a rejected upload must not finish'),
        cancelUpload: async () => { cancelCalls += 1; },
      },
    }),
    /Invalid upload token/
  );

  assert.equal(uploadCalls, 1);
  assert.equal(cancelCalls, 1);
});

test('resumes by skipping chunks already confirmed by the server', async () => {
  const file = makeFile(FILE_CHUNK_SIZE * 3, 'resume.bin');
  const uploadedChunkIndexes = [];
  const progress = [];

  await uploadFileInChunks({
    transferId: 1n,
    file,
    resumeState: {
      uploadToken: 'resume-token',
      ready: false,
      receivedBytes: FILE_CHUNK_SIZE * 2,
      uploadedChunkIndexes: [0, 2],
    },
    reducers: {
      startUploadV2: async ({ uploadToken }) => assert.equal(uploadToken, 'resume-token'),
      uploadChunk: async ({ chunkIndex }) => uploadedChunkIndexes.push(chunkIndex),
      finishUpload: async () => {},
      cancelUpload: async () => assert.fail('a resumed upload must not be cancelled'),
    },
    onProgress: (uploadedBytes) => progress.push(uploadedBytes),
  });

  assert.deepEqual(uploadedChunkIndexes, [1]);
  assert.deepEqual(progress, [FILE_CHUNK_SIZE * 2, FILE_CHUNK_SIZE * 3]);
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
    transferId: 1n,
    files,
    fileConcurrency: 2,
    transferPolicy: {
      chunkSizeBytes: FILE_CHUNK_SIZE,
      chunkConcurrency: 4,
      maxInFlightBytes: FILE_CHUNK_SIZE * 4,
    },
    timeoutMs: 100,
    reducers: {
      startUploadV2: async ({ uploadToken }) => {
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
    transferId: 1n,
    files,
    fileConcurrency: 3,
    transferPolicy: {
      chunkSizeBytes: FILE_CHUNK_SIZE,
      chunkConcurrency: 3,
      maxInFlightBytes: DEFAULT_MAX_IN_FLIGHT_BYTES,
    },
    timeoutMs: 20,
    retryAttempts: 1,
    reducers: {
      startUploadV2: async () => {},
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

  assert.equal(uploadChunkCalls, 2);
  assert.equal(cancelCalls, 0);
  assert.equal(result.uploadedFiles.length, 0);
  assert.equal(result.failedFiles.length, 3);
  assert.ok(result.failedFiles.every(({ error }) => error instanceof Error));
});

test('preserves a chunk upload when its reducer promise never settles', async () => {
  const file = makeFile(FILE_CHUNK_SIZE + 1, 'disconnected.bin');

  await assert.rejects(
    uploadFileInChunks({
      transferId: 1n,
      file,
      uploadToken: 'disconnect-test',
      timeoutMs: 10,
      retryAttempts: 1,
      reducers: {
        startUploadV2: async () => {},
        uploadChunk: async () => new Promise(() => {}),
        finishUpload: async () => {
          assert.fail('a timed-out upload must not finish');
        },
        cancelUpload: async () => assert.fail('a timed-out upload must remain resumable'),
      },
    }),
    /上传分块超时/
  );
});
