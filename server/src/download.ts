export type ByteRange = {
  start: bigint;
  end: bigint;
};

export type ParsedByteRange =
  | { kind: 'full' }
  | { kind: 'partial'; range: ByteRange }
  | { kind: 'unsatisfiable' };

const MAX_ARRAY_LENGTH = 0xffff_ffffn;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export function parseDownloadFileId(uri: string): bigint | null {
  const queryStart = uri.indexOf('?');
  if (queryStart === -1) return null;
  const fragmentStart = uri.indexOf('#', queryStart + 1);
  const query = uri.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart);
  let fileId: bigint | null = null;

  for (const parameter of query.split('&')) {
    const separator = parameter.indexOf('=');
    const key = separator === -1 ? parameter : parameter.slice(0, separator);
    if (key !== 'id') continue;
    if (fileId !== null) return null;

    const value = separator === -1 ? '' : parameter.slice(separator + 1);
    if (!/^\d+$/.test(value)) return null;
    const parsed = BigInt(value);
    if (parsed > MAX_U64) return null;
    fileId = parsed;
  }

  return fileId;
}

export function parseByteRange(
  rangeHeader: string | null,
  sizeBytes: bigint
): ParsedByteRange {
  if (rangeHeader === null) return { kind: 'full' };
  if (sizeBytes === 0n || rangeHeader.includes(',')) {
    return { kind: 'unsatisfiable' };
  }

  const match = /^bytes\s*=\s*(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) {
    return { kind: 'unsatisfiable' };
  }

  if (!match[1]) {
    const suffixLength = BigInt(match[2]);
    if (suffixLength === 0n) return { kind: 'unsatisfiable' };
    return {
      kind: 'partial',
      range: {
        start: suffixLength >= sizeBytes ? 0n : sizeBytes - suffixLength,
        end: sizeBytes - 1n,
      },
    };
  }

  const start = BigInt(match[1]);
  if (start >= sizeBytes) return { kind: 'unsatisfiable' };

  const requestedEnd = match[2] ? BigInt(match[2]) : sizeBytes - 1n;
  if (requestedEnd < start) return { kind: 'unsatisfiable' };

  return {
    kind: 'partial',
    range: {
      start,
      end: requestedEnd >= sizeBytes ? sizeBytes - 1n : requestedEnd,
    },
  };
}

export function assembleByteRange(
  range: ByteRange,
  chunkSizeBytes: number,
  getChunk: (chunkIndex: number) => Uint8Array | undefined
): Uint8Array {
  if (!Number.isSafeInteger(chunkSizeBytes) || chunkSizeBytes <= 0) {
    throw new RangeError('Invalid file chunk size.');
  }
  if (range.start < 0n || range.end < range.start) {
    throw new RangeError('Invalid byte range.');
  }

  const outputLength = range.end - range.start + 1n;
  if (outputLength > MAX_ARRAY_LENGTH) {
    throw new RangeError('Requested byte range is too large.');
  }

  const chunkSize = BigInt(chunkSizeBytes);
  const firstChunkIndex = Number(range.start / chunkSize);
  const lastChunkIndex = Number(range.end / chunkSize);
  const output = new Uint8Array(Number(outputLength));
  let outputOffset = 0;

  for (let chunkIndex = firstChunkIndex; chunkIndex <= lastChunkIndex; chunkIndex += 1) {
    const chunk = getChunk(chunkIndex);
    if (!chunk) throw new Error(`File chunk ${chunkIndex} is missing.`);

    const chunkStart = BigInt(chunkIndex) * chunkSize;
    const copyStart = range.start > chunkStart ? Number(range.start - chunkStart) : 0;
    const rangeEndInChunk = range.end - chunkStart + 1n;
    const copyEnd = Math.min(chunk.byteLength, Number(rangeEndInChunk));
    if (copyStart < 0 || copyStart >= copyEnd) {
      throw new Error(`File chunk ${chunkIndex} does not cover the requested range.`);
    }

    const bytes = chunk.subarray(copyStart, copyEnd);
    output.set(bytes, outputOffset);
    outputOffset += bytes.byteLength;
  }

  if (outputOffset !== output.byteLength) {
    throw new Error('File chunks do not cover the requested range.');
  }
  return output;
}

export function contentDisposition(fileName: string): string {
  const fallback =
    fileName
      .replace(/[^\x20-\x7e]/g, '_')
      .replace(/["\\]/g, '_')
      .trim() || 'download';
  let encoded = 'download';
  try {
    encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
  } catch {
    // A malformed surrogate in a stored filename should not break the download.
  }
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
