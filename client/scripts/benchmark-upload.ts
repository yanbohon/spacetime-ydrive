import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { DbConnection, tables, type SubscriptionHandle } from '../src/module_bindings';
import { uploadFileInChunks } from '../src/upload';

const MIB = 1024 * 1024;
const DATABASE_URI = 'wss://maincloud.spacetimedb.com';
const DATABASE_NAME = 'ydrive-axerq';
const DEFAULT_SIZE_BYTES = 64 * MIB;
const CONNECT_TIMEOUT_MS = 15_000;

type Profile = {
  label: string;
  chunkSizeBytes: number;
  chunkConcurrency: number;
};

const profiles: Record<string, Profile> = {
  '1x3': { label: '1MiB × 3', chunkSizeBytes: MIB, chunkConcurrency: 3 },
  '2x2': { label: '2MiB × 2', chunkSizeBytes: 2 * MIB, chunkConcurrency: 2 },
  '4x1': { label: '4MiB × 1', chunkSizeBytes: 4 * MIB, chunkConcurrency: 1 },
  '4x2': { label: '4MiB × 2', chunkSizeBytes: 4 * MIB, chunkConcurrency: 2 },
  '4x3': { label: '4MiB × 3', chunkSizeBytes: 4 * MIB, chunkConcurrency: 3 },
};

function connect(): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out connecting to Maincloud.')),
      CONNECT_TIMEOUT_MS
    );
    DbConnection.builder()
      .withUri(DATABASE_URI)
      .withDatabaseName(DATABASE_NAME)
      .onConnect((connection) => {
        clearTimeout(timer);
        resolve(connection);
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timer);
        reject(error);
      })
      .build();
  });
}

function waitForMetadata(connection: DbConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out subscribing to file metadata.')),
      CONNECT_TIMEOUT_MS
    );
    connection
      .subscriptionBuilder()
      .onApplied(() => {
        clearTimeout(timer);
        resolve();
      })
      .onError(() => {
        clearTimeout(timer);
        reject(new Error('Failed to subscribe to file metadata.'));
      })
      .subscribe([tables.storedFile]);
  });
}

function createFixture(sizeBytes: number) {
  const bytes = new Uint8Array(sizeBytes);
  let state = 0x9e3779b9;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  return {
    bytes,
    file: {
      name: '',
      type: blob.type,
      size: blob.size,
      slice: blob.slice.bind(blob),
    },
  };
}

async function verifyDownloadedHash(
  connection: DbConnection,
  fileId: bigint,
  chunkCount: number,
  expectedHash: string
): Promise<void> {
  let subscription: SubscriptionHandle | undefined;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out downloading benchmark chunks.')),
      60_000
    );
    subscription = connection
      .subscriptionBuilder()
      .onApplied((ctx) => {
        clearTimeout(timer);
        const actualHash = createHash('sha256');
        if (chunkCount > 0) {
          const chunks = [...ctx.db.fileChunk.iter()]
            .filter((chunk) => chunk.fileId === fileId)
            .sort((left, right) => left.chunkIndex - right.chunkIndex);
          if (
            chunks.length !== chunkCount ||
            chunks.some((chunk, index) => chunk.chunkIndex !== index)
          ) {
            reject(new Error('Downloaded benchmark chunks are incomplete.'));
            return;
          }
          for (const chunk of chunks) actualHash.update(chunk.content);
        } else {
          const blob = ctx.db.fileBlob.id.find(fileId);
          if (!blob) {
            reject(new Error('Downloaded benchmark blob is missing.'));
            return;
          }
          actualHash.update(blob.content);
        }
        if (actualHash.digest('hex') !== expectedHash) {
          reject(new Error('Downloaded benchmark data hash does not match.'));
          return;
        }
        resolve();
      })
      .onError(() => {
        clearTimeout(timer);
        reject(new Error('Failed to download benchmark chunks.'));
      })
      .subscribe([
        chunkCount > 0
          ? tables.fileChunk.where((row) => row.fileId.eq(fileId))
          : tables.fileBlob.where((row) => row.id.eq(fileId)),
      ]);
  }).finally(() => subscription?.unsubscribe());
}

async function cleanupUpload(uploadToken: string) {
  const connection = await connect();
  try {
    await connection.reducers.cancelUpload({ uploadToken });
  } finally {
    connection.disconnect();
  }
}

async function runProfile(
  profile: Profile,
  fixture: ReturnType<typeof createFixture>,
  verifyHash: boolean
) {
  const connection = await connect();
  const uploadToken = `benchmark-${profile.chunkSizeBytes}-${profile.chunkConcurrency}-${Date.now()}`;
  const fileName = `${uploadToken}.bin`;
  const file = { ...fixture.file, name: fileName };
  let uploadedFileId: bigint | undefined;

  try {
    await waitForMetadata(connection);
    const startedAt = performance.now();
    await uploadFileInChunks({
      file,
      reducers: connection.reducers,
      uploadToken,
      transferPolicy: {
        chunkSizeBytes: profile.chunkSizeBytes,
        chunkConcurrency: profile.chunkConcurrency,
        maxInFlightBytes: profile.chunkSizeBytes * profile.chunkConcurrency,
      },
      timeoutMs: 20_000,
    });
    const durationSeconds = (performance.now() - startedAt) / 1000;
    const uploadedFile = [...connection.db.storedFile.iter()].find(
      (row) => row.name === fileName
    );
    if (!uploadedFile?.ready) {
      throw new Error('Uploaded file metadata was not committed.');
    }
    uploadedFileId = uploadedFile.id;

    if (verifyHash) {
      const expectedHash = createHash('sha256').update(fixture.bytes).digest('hex');
      await verifyDownloadedHash(
        connection,
        uploadedFile.id,
        uploadedFile.chunkCount,
        expectedHash
      );
    }

    const mibPerSecond = file.size / MIB / durationSeconds;
    return {
      profile: profile.label,
      durationSeconds: Number(durationSeconds.toFixed(3)),
      mibPerSecond: Number(mibPerSecond.toFixed(2)),
      chunkCount: uploadedFile.chunkCount,
      verified: verifyHash,
      error: '',
    };
  } catch (error) {
    return {
      profile: profile.label,
      durationSeconds: 0,
      mibPerSecond: 0,
      chunkCount: 0,
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (uploadedFileId !== undefined) {
      await connection.reducers.deleteFile({ id: uploadedFileId }).catch(() => undefined);
    }
    connection.disconnect();
    await cleanupUpload(uploadToken).catch(() => undefined);
  }
}

async function main() {
  const requestedProfiles = process.argv.slice(2).filter((arg) => arg !== '--verify');
  const selectedProfileKeys = requestedProfiles.length
    ? requestedProfiles
    : ['1x3', '2x2', '4x1', '4x2'];
  const selectedProfiles = selectedProfileKeys.map((key) => {
    const profile = profiles[key];
    if (!profile) throw new Error(`Unknown profile: ${key}`);
    return profile;
  });
  const verifyHash = process.argv.includes('--verify');
  const configuredSize = Number(
    process.env.YDRIVE_BENCHMARK_SIZE_BYTES ?? DEFAULT_SIZE_BYTES
  );
  if (!Number.isSafeInteger(configuredSize) || configuredSize < 1) {
    throw new Error('YDRIVE_BENCHMARK_SIZE_BYTES must be a positive safe integer.');
  }

  const fixture = createFixture(configuredSize);
  const results = [];
  for (const profile of selectedProfiles) {
    results.push(await runProfile(profile, fixture, verifyHash));
  }

  console.table(results);
  if (results.every((result) => result.error)) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
