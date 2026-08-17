export const FILE_CHUNK_SIZE = 1024 * 1024;
export const DEFAULT_REDUCER_TIMEOUT_MS = 30_000;
export const DEFAULT_CHUNK_CONCURRENCY = 3;
export const DEFAULT_FILE_CONCURRENCY = 3;

export class UploadTimeoutError extends Error {
  constructor(operation: string) {
    super(`${operation}超时，请检查网络后重试。`);
    this.name = 'UploadTimeoutError';
  }
}

type UploadFileLike = Pick<File, 'name' | 'type' | 'size' | 'slice'>;

type UploadReducers = {
  startUpload: (args: {
    uploadToken: string;
    name: string;
    mimeType: string;
    sizeBytes: bigint;
  }) => Promise<unknown>;
  uploadChunk: (args: {
    uploadToken: string;
    chunkIndex: number;
    content: Uint8Array;
  }) => Promise<unknown>;
  finishUpload: (args: { uploadToken: string }) => Promise<unknown>;
  cancelUpload: (args: { uploadToken: string }) => Promise<unknown>;
};

type TaskScheduler = <T>(task: () => Promise<T>) => Promise<T>;

type UploadFileOptions = {
  file: UploadFileLike;
  reducers: UploadReducers;
  uploadToken?: string;
  timeoutMs?: number;
  chunkConcurrency?: number;
  scheduleChunk?: TaskScheduler;
  signal?: AbortSignal;
  onTimeout?: () => void;
  onProgress?: (uploadedBytes: number) => void;
};

export type BatchUploadProgress = {
  activeFileNames: string[];
  activeFiles: number;
  completedFiles: number;
  fileCount: number;
  latestProgressFileName: string;
  latestProgressUploadedBytes: number;
  latestProgressFileSizeBytes: number;
  totalUploadedBytes: number;
  totalSizeBytes: number;
  percent: number;
};

export type BatchUploadFailure = {
  file: UploadFileLike;
  error: unknown;
};

export type BatchUploadResult = {
  uploadedFiles: UploadFileLike[];
  failedFiles: BatchUploadFailure[];
};

type UploadBatchOptions = {
  files: UploadFileLike[];
  reducers: UploadReducers;
  timeoutMs?: number;
  chunkConcurrency?: number;
  fileConcurrency?: number;
  onProgress?: (progress: BatchUploadProgress) => void;
};

function normalizeConcurrency(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
  return value;
}

function createConcurrencyLimiter(
  concurrency: number,
  signal?: AbortSignal
): TaskScheduler {
  const limit = normalizeConcurrency(concurrency, 'Concurrency');
  const queue: Array<{ run: () => void; reject: (error: unknown) => void }> = [];
  let activeTasks = 0;

  const abortError = () => new UploadTimeoutError('上传连接');
  const rejectQueuedTasks = () => {
    while (queue.length) queue.shift()?.reject(abortError());
  };
  signal?.addEventListener('abort', rejectQueuedTasks, { once: true });

  const runNext = () => {
    while (activeTasks < limit && queue.length) {
      const queuedTask = queue.shift();
      if (!queuedTask) return;
      if (signal?.aborted) {
        queuedTask.reject(abortError());
        continue;
      }
      activeTasks += 1;
      queuedTask.run();
    }
  };

  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      queue.push({
        reject,
        run: () => {
          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              activeTasks -= 1;
              runNext();
            });
        },
      });
      runNext();
    });
}

function timedCall<T>(
  call: () => Promise<T>,
  timeoutMs: number,
  operation: string,
  signal?: AbortSignal,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new UploadTimeoutError(operation));
      onTimeout?.();
    }, timeoutMs);
  });
  let rejectOnAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectOnAbort = () => reject(new UploadTimeoutError('上传连接'));
    if (signal?.aborted) rejectOnAbort();
    else signal?.addEventListener('abort', rejectOnAbort, { once: true });
  });
  let result: Promise<T>;
  try {
    result = call();
  } catch (error) {
    result = Promise.reject(error);
  }
  return Promise.race([result, timeout, aborted]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (rejectOnAbort) signal?.removeEventListener('abort', rejectOnAbort);
  });
}

export async function uploadFileInChunks({
  file,
  reducers,
  uploadToken = crypto.randomUUID(),
  timeoutMs = DEFAULT_REDUCER_TIMEOUT_MS,
  chunkConcurrency = DEFAULT_CHUNK_CONCURRENCY,
  scheduleChunk,
  signal,
  onTimeout,
  onProgress,
}: UploadFileOptions): Promise<void> {
  const concurrency = normalizeConcurrency(chunkConcurrency, 'Chunk concurrency');
  const schedule = scheduleChunk ?? createConcurrencyLimiter(concurrency, signal);
  let uploadMayExist = false;
  onProgress?.(0);

  try {
    uploadMayExist = true;
    await timedCall(
      () =>
        reducers.startUpload({
          uploadToken,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: BigInt(file.size),
        }),
      timeoutMs,
      '创建上传任务',
      signal,
      onTimeout
    );

    const chunkCount = Math.ceil(file.size / FILE_CHUNK_SIZE);
    let nextChunkIndex = 0;
    let uploadedBytes = 0;
    let firstError: unknown;
    let hasError = false;

    const uploadNextChunks = async () => {
      while (!hasError) {
        const chunkIndex = nextChunkIndex;
        nextChunkIndex += 1;
        if (chunkIndex >= chunkCount) return;

        const start = chunkIndex * FILE_CHUNK_SIZE;
        const end = Math.min(start + FILE_CHUNK_SIZE, file.size);
        try {
          const committedBytes = await schedule(async () => {
            const content = new Uint8Array(await file.slice(start, end).arrayBuffer());
            await timedCall(
              () => reducers.uploadChunk({ uploadToken, chunkIndex, content }),
              timeoutMs,
              '上传分块',
              signal,
              onTimeout
            );
            return content.byteLength;
          });
          uploadedBytes += committedBytes;
          onProgress?.(uploadedBytes);
        } catch (error) {
          if (!hasError) {
            hasError = true;
            firstError = error;
          }
        }
      }
    };

    const workerCount = Math.min(concurrency, chunkCount);
    await Promise.all(Array.from({ length: workerCount }, uploadNextChunks));
    if (hasError) throw firstError;

    await timedCall(
      () => reducers.finishUpload({ uploadToken }),
      timeoutMs,
      '完成上传',
      signal,
      onTimeout
    );
  } catch (error) {
    if (uploadMayExist) {
      await timedCall(
        () => reducers.cancelUpload({ uploadToken }),
        Math.min(timeoutMs, 5_000),
        '清理上传任务'
      ).catch(() => undefined);
    }
    throw error;
  }
}

export async function uploadFilesConcurrently({
  files,
  reducers,
  timeoutMs = DEFAULT_REDUCER_TIMEOUT_MS,
  chunkConcurrency = DEFAULT_CHUNK_CONCURRENCY,
  fileConcurrency = DEFAULT_FILE_CONCURRENCY,
  onProgress,
}: UploadBatchOptions): Promise<BatchUploadResult> {
  if (!files.length) return { uploadedFiles: [], failedFiles: [] };

  const chunkLimit = normalizeConcurrency(chunkConcurrency, 'Chunk concurrency');
  const fileLimit = normalizeConcurrency(fileConcurrency, 'File concurrency');
  const uploadAbortController = new AbortController();
  const scheduleChunk = createConcurrencyLimiter(
    chunkLimit,
    uploadAbortController.signal
  );
  const uploadedBytesByFile = files.map(() => 0);
  const activeFileIndexes = new Set<number>();
  const uploadedFileIndexes: number[] = [];
  const failuresByIndex = new Map<number, unknown>();
  const totalSizeBytes = files.reduce((sum, file) => sum + file.size, 0);
  let nextFileIndex = 0;
  let connectionTimedOut = false;

  const emitProgress = (fileIndex: number) => {
    const totalUploadedBytes = uploadedBytesByFile.reduce((sum, size) => sum + size, 0);
    const completedFiles = uploadedFileIndexes.length;
    const bytesPercent = totalSizeBytes === 0
      ? 0
      : Math.round((totalUploadedBytes / totalSizeBytes) * 100);
    const percent = completedFiles === files.length ? 100 : Math.min(bytesPercent, 99);
    onProgress?.({
      activeFileNames: [...activeFileIndexes].map((index) => files[index].name),
      activeFiles: activeFileIndexes.size,
      completedFiles,
      fileCount: files.length,
      latestProgressFileName: files[fileIndex].name,
      latestProgressUploadedBytes: uploadedBytesByFile[fileIndex],
      latestProgressFileSizeBytes: files[fileIndex].size,
      totalUploadedBytes,
      totalSizeBytes,
      percent,
    });
  };

  const uploadNextFiles = async () => {
    while (!connectionTimedOut) {
      const fileIndex = nextFileIndex;
      nextFileIndex += 1;
      if (fileIndex >= files.length) return;

      const file = files[fileIndex];
      activeFileIndexes.add(fileIndex);
      emitProgress(fileIndex);
      try {
        await uploadFileInChunks({
          file,
          reducers,
          timeoutMs,
          chunkConcurrency: chunkLimit,
          scheduleChunk,
          signal: uploadAbortController.signal,
          onTimeout: () => uploadAbortController.abort(),
          onProgress: (uploadedBytes) => {
            uploadedBytesByFile[fileIndex] = uploadedBytes;
            emitProgress(fileIndex);
          },
        });
        uploadedBytesByFile[fileIndex] = file.size;
        uploadedFileIndexes.push(fileIndex);
      } catch (error) {
        failuresByIndex.set(fileIndex, error);
        if (error instanceof UploadTimeoutError) connectionTimedOut = true;
      } finally {
        activeFileIndexes.delete(fileIndex);
        emitProgress(fileIndex);
      }
    }
  };

  const workerCount = Math.min(fileLimit, files.length);
  await Promise.all(Array.from({ length: workerCount }, uploadNextFiles));

  if (connectionTimedOut) {
    files.forEach((_file, index) => {
      if (!uploadedFileIndexes.includes(index) && !failuresByIndex.has(index)) {
        failuresByIndex.set(index, new UploadTimeoutError('上传连接'));
      }
    });
  }

  uploadedFileIndexes.sort((a, b) => a - b);
  return {
    uploadedFiles: uploadedFileIndexes.map((index) => files[index]),
    failedFiles: [...failuresByIndex]
      .sort(([a], [b]) => a - b)
      .map(([index, error]) => ({ file: files[index], error })),
  };
}
