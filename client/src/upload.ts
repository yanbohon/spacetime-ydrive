export const FILE_CHUNK_SIZE = 1024 * 1024;
export const DEFAULT_REDUCER_TIMEOUT_MS = 30_000;

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

type UploadFileOptions = {
  file: UploadFileLike;
  reducers: UploadReducers;
  uploadToken?: string;
  timeoutMs?: number;
  onProgress?: (uploadedBytes: number) => void;
};

function timedCall<T>(
  call: () => Promise<T>,
  timeoutMs: number,
  operation: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new UploadTimeoutError(operation)),
      timeoutMs
    );
  });
  let result: Promise<T>;
  try {
    result = call();
  } catch (error) {
    result = Promise.reject(error);
  }
  return Promise.race([result, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function uploadFileInChunks({
  file,
  reducers,
  uploadToken = crypto.randomUUID(),
  timeoutMs = DEFAULT_REDUCER_TIMEOUT_MS,
  onProgress,
}: UploadFileOptions): Promise<void> {
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
      '创建上传任务'
    );

    let uploadedBytes = 0;
    let chunkIndex = 0;
    while (uploadedBytes < file.size) {
      const end = Math.min(uploadedBytes + FILE_CHUNK_SIZE, file.size);
      const content = new Uint8Array(await file.slice(uploadedBytes, end).arrayBuffer());
      await timedCall(
        () => reducers.uploadChunk({ uploadToken, chunkIndex, content }),
        timeoutMs,
        '上传分块'
      );
      uploadedBytes = end;
      chunkIndex += 1;
      onProgress?.(uploadedBytes);
    }

    await timedCall(
      () => reducers.finishUpload({ uploadToken }),
      timeoutMs,
      '完成上传'
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
