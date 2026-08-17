export const DEFAULT_FILE_CHUNK_SIZE = 4 * 1024 * 1024;
export const FILE_CHUNK_SIZE = DEFAULT_FILE_CHUNK_SIZE;
export const DEFAULT_MAX_IN_FLIGHT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_REDUCER_TIMEOUT_MS = 30_000;
export const DEFAULT_CHUNK_CONCURRENCY = 2;
export const DEFAULT_FILE_CONCURRENCY = 2;
export const DEFAULT_RETRY_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 250;

export type UploadTransferPolicy = {
  chunkSizeBytes: number;
  chunkConcurrency: number;
  maxInFlightBytes: number;
};

export const DEFAULT_UPLOAD_TRANSFER_POLICY: UploadTransferPolicy = {
  chunkSizeBytes: DEFAULT_FILE_CHUNK_SIZE,
  chunkConcurrency: DEFAULT_CHUNK_CONCURRENCY,
  maxInFlightBytes: DEFAULT_MAX_IN_FLIGHT_BYTES,
};

export class UploadTimeoutError extends Error {
  constructor(operation: string) {
    super(`${operation}超时，请检查网络后重试。`);
    this.name = 'UploadTimeoutError';
  }
}
export class UploadCancelledError extends Error {
  constructor() {
    super('上传已取消。');
    this.name = 'UploadCancelledError';
  }
}

type UploadFileLike = Pick<File, 'name' | 'type' | 'size' | 'slice'>;

type UploadReducers = {
  uploadFile: (args: {
    transferId: bigint;
    uploadToken: string;
    name: string;
    mimeType: string;
    sizeBytes: bigint;
    content: Uint8Array;
  }) => Promise<unknown>;
  startUploadV2: (args: {
    transferId: bigint;
    uploadToken: string;
    name: string;
    mimeType: string;
    sizeBytes: bigint;
    chunkSizeBytes: number;
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
export type UploadResumeState = {
  uploadToken: string;
  ready: boolean;
  receivedBytes: number;
  uploadedChunkIndexes: number[];
};

type UploadFileOptions = {
  file: UploadFileLike;
  transferId: bigint;
  reducers: UploadReducers;
  uploadToken?: string;
  resumeState?: UploadResumeState;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  transferPolicy?: UploadTransferPolicy;
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
  cancelled: boolean;
};

type UploadBatchOptions = {
  transferId: bigint;
  files: UploadFileLike[];
  reducers: UploadReducers;
  uploadTokens?: string[];
  resumeStates?: Array<UploadResumeState | undefined>;
  timeoutMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  transferPolicy?: UploadTransferPolicy;
  fileConcurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: BatchUploadProgress) => void;
};

function normalizeConcurrency(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
  return value;
}

function normalizeByteCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function resolveChunkConcurrency(
  requestedConcurrency: number,
  chunkSizeBytes: number,
  maxInFlightBytes: number
): number {
  const requested = normalizeConcurrency(requestedConcurrency, 'Chunk concurrency');
  const chunkSize = normalizeByteCount(chunkSizeBytes, 'Chunk size');
  const maxInFlight = normalizeByteCount(maxInFlightBytes, 'Maximum in-flight bytes');
  return Math.min(requested, Math.max(1, Math.floor(maxInFlight / chunkSize)));
}

function createConcurrencyLimiter(
  concurrency: number,
  signal?: AbortSignal
): TaskScheduler {
  const limit = normalizeConcurrency(concurrency, 'Concurrency');
  const queue: Array<{ run: () => void; reject: (error: unknown) => void }> = [];
  let activeTasks = 0;

  const abortError = () => new UploadCancelledError();
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
    rejectOnAbort = () => reject(new UploadCancelledError());
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
function waitForRetry(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new UploadCancelledError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function isRetryableUploadError(error: unknown) {
  if (error instanceof UploadTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  return /network|connection|disconnect|websocket|socket|transport|fetch|temporar|closed|offline/i.test(error.message) &&
    !/SenderError/i.test(error.message);
}

async function retryingCall<T>(
  call: () => Promise<T>,
  timeoutMs: number,
  operation: string,
  attempts: number,
  retryDelayMs: number,
  signal?: AbortSignal,
  onTimeout?: () => void
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await timedCall(call, timeoutMs, operation, signal);
    } catch (error) {
      if (error instanceof UploadCancelledError) throw error;
      lastError = error;
      if (!isRetryableUploadError(error) || attempt >= attempts) break;
      await waitForRetry(retryDelayMs * 2 ** (attempt - 1), signal);
    }
  }
  if (lastError instanceof UploadTimeoutError) onTimeout?.();
  throw lastError;
}

export async function uploadFileInChunks({
  file,
  transferId,
  reducers,
  uploadToken: requestedUploadToken,
  resumeState,
  timeoutMs = DEFAULT_REDUCER_TIMEOUT_MS,
  retryAttempts = DEFAULT_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  transferPolicy = DEFAULT_UPLOAD_TRANSFER_POLICY,
  scheduleChunk,
  signal,
  onTimeout,
  onProgress,
}: UploadFileOptions): Promise<void> {
  const uploadToken = requestedUploadToken ?? resumeState?.uploadToken ?? crypto.randomUUID();
  const { chunkSizeBytes, chunkConcurrency, maxInFlightBytes } = transferPolicy;
  const normalizedChunkSize = normalizeByteCount(chunkSizeBytes, 'Chunk size');
  const concurrency = resolveChunkConcurrency(
    chunkConcurrency,
    normalizedChunkSize,
    maxInFlightBytes
  );
  const schedule = scheduleChunk ?? createConcurrencyLimiter(concurrency, signal);
  const finalizeUpload = () =>
    retryingCall(
      () => reducers.finishUpload({ uploadToken }),
      timeoutMs,
      '完成上传',
      retryAttempts,
      retryDelayMs,
      signal,
      onTimeout
    );
  let uploadMayExist = Boolean(resumeState);
  const initialUploadedBytes = resumeState?.ready ? file.size : resumeState?.receivedBytes ?? 0;
  onProgress?.(initialUploadedBytes);
  if (resumeState?.ready) return;

  try {
    if (file.size <= normalizedChunkSize) {
      uploadMayExist = true;
      const uploadedBytes = await schedule(async () => {
        const content = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
        await retryingCall(
          () =>
            reducers.uploadFile({
              transferId,
              uploadToken,
              name: file.name,
              mimeType: file.type || 'application/octet-stream',
              sizeBytes: BigInt(file.size),
              content,
            }),
          timeoutMs,
          '上传文件',
          retryAttempts,
          retryDelayMs,
          signal,
          onTimeout
        );
        return content.byteLength;
      });
      await finalizeUpload();
      onProgress?.(uploadedBytes);
      return;
    }

    uploadMayExist = true;
    await retryingCall(
      () =>
        reducers.startUploadV2({
          transferId,
          uploadToken,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: BigInt(file.size),
          chunkSizeBytes: normalizedChunkSize,
        }),
      timeoutMs,
      '创建上传任务',
      retryAttempts,
      retryDelayMs,
      signal,
      onTimeout
    );

    const chunkCount = Math.ceil(file.size / normalizedChunkSize);
    const uploadedChunks = new Set(resumeState?.uploadedChunkIndexes ?? []);
    let nextChunkIndex = 0;
    let uploadedBytes = initialUploadedBytes;
    let firstError: unknown;
    let hasError = false;

    const uploadNextChunks = async () => {
      while (!hasError) {
        const chunkIndex = nextChunkIndex;
        nextChunkIndex += 1;
        if (chunkIndex >= chunkCount) return;
        if (uploadedChunks.has(chunkIndex)) continue;

        const start = chunkIndex * normalizedChunkSize;
        const end = Math.min(start + normalizedChunkSize, file.size);
        try {
          const committedBytes = await schedule(async () => {
            const content = new Uint8Array(await file.slice(start, end).arrayBuffer());
            await retryingCall(
              () => reducers.uploadChunk({ uploadToken, chunkIndex, content }),
              timeoutMs,
              '上传分块',
              retryAttempts,
              retryDelayMs,
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

    await finalizeUpload();
  } catch (error) {
    if (
      uploadMayExist &&
      !(error instanceof UploadTimeoutError) &&
      !(error instanceof UploadCancelledError)
    ) {
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
  transferId,
  reducers,
  uploadTokens,
  resumeStates,
  timeoutMs = DEFAULT_REDUCER_TIMEOUT_MS,
  retryAttempts = DEFAULT_RETRY_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  transferPolicy = DEFAULT_UPLOAD_TRANSFER_POLICY,
  fileConcurrency = DEFAULT_FILE_CONCURRENCY,
  signal,
  onProgress,
}: UploadBatchOptions): Promise<BatchUploadResult> {
  if (!files.length) return { uploadedFiles: [], failedFiles: [], cancelled: false };

  const { chunkSizeBytes, chunkConcurrency, maxInFlightBytes } = transferPolicy;
  const normalizedChunkSize = normalizeByteCount(chunkSizeBytes, 'Chunk size');
  const chunkLimit = resolveChunkConcurrency(
    chunkConcurrency,
    normalizedChunkSize,
    maxInFlightBytes
  );
  const fileLimit = normalizeConcurrency(fileConcurrency, 'File concurrency');
  const uploadAbortController = new AbortController();
  const cancelUpload = () => uploadAbortController.abort();
  if (signal?.aborted) cancelUpload();
  else signal?.addEventListener('abort', cancelUpload, { once: true });
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
          transferId,
          reducers,
          uploadToken: uploadTokens?.[fileIndex],
          resumeState: resumeStates?.[fileIndex],
          timeoutMs,
          retryAttempts,
          retryDelayMs,
          transferPolicy: {
            chunkSizeBytes: normalizedChunkSize,
            chunkConcurrency: chunkLimit,
            maxInFlightBytes,
          },
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
        if (error instanceof UploadTimeoutError || error instanceof UploadCancelledError) {
          connectionTimedOut = true;
        }
      } finally {
        activeFileIndexes.delete(fileIndex);
        emitProgress(fileIndex);
      }
    }
  };

  const workerCount = Math.min(fileLimit, files.length);
  await Promise.all(Array.from({ length: workerCount }, uploadNextFiles));
  signal?.removeEventListener('abort', cancelUpload);

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
    cancelled: signal?.aborted ?? false,
  };
}
