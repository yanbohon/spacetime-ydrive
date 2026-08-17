const MAX_ZIP_U16 = 0xffff;
const MAX_ZIP_U32 = 0xffff_ffff;

export type ZipEntry = {
  name: string;
  content: Uint8Array;
};

type EncodedEntry = ZipEntry & {
  nameBytes: Uint8Array;
  crc32: number;
  localOffset: number;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[value] = crc >>> 0;
  }
  return table;
})();

export function crc32(content: Uint8Array) {
  let crc = 0xffff_ffff;
  for (const byte of content) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

function writeU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

export function createZipArchive(entries: ZipEntry[]) {
  if (!entries.length) throw new RangeError('A ZIP archive requires at least one entry.');
  if (entries.length > MAX_ZIP_U16) throw new RangeError('ZIP archive has too many entries.');

  const encoder = new TextEncoder();
  let localSize = 0;
  const encoded: EncodedEntry[] = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    if (!nameBytes.length || nameBytes.byteLength > MAX_ZIP_U16) {
      throw new RangeError('Invalid ZIP entry name.');
    }
    if (entry.content.byteLength > MAX_ZIP_U32) throw new RangeError('ZIP entry is too large.');
    const result = { ...entry, nameBytes, crc32: crc32(entry.content), localOffset: localSize };
    localSize += 30 + nameBytes.byteLength + entry.content.byteLength;
    if (localSize > MAX_ZIP_U32) throw new RangeError('ZIP archive is too large.');
    return result;
  });

  const centralSize = encoded.reduce((sum, entry) => sum + 46 + entry.nameBytes.byteLength, 0);
  const totalSize = localSize + centralSize + 22;
  if (!Number.isSafeInteger(totalSize) || totalSize > MAX_ZIP_U32) {
    throw new RangeError('ZIP archive is too large.');
  }

  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  let offset = 0;
  for (const entry of encoded) {
    writeU32(view, offset, 0x04034b50);
    writeU16(view, offset + 4, 20);
    writeU16(view, offset + 6, 0x0800);
    writeU16(view, offset + 8, 0);
    writeU16(view, offset + 10, 0);
    writeU16(view, offset + 12, 0);
    writeU32(view, offset + 14, entry.crc32);
    writeU32(view, offset + 18, entry.content.byteLength);
    writeU32(view, offset + 22, entry.content.byteLength);
    writeU16(view, offset + 26, entry.nameBytes.byteLength);
    writeU16(view, offset + 28, 0);
    output.set(entry.nameBytes, offset + 30);
    output.set(entry.content, offset + 30 + entry.nameBytes.byteLength);
    offset += 30 + entry.nameBytes.byteLength + entry.content.byteLength;
  }

  const centralOffset = offset;
  for (const entry of encoded) {
    writeU32(view, offset, 0x02014b50);
    writeU16(view, offset + 4, 20);
    writeU16(view, offset + 6, 20);
    writeU16(view, offset + 8, 0x0800);
    writeU16(view, offset + 10, 0);
    writeU16(view, offset + 12, 0);
    writeU16(view, offset + 14, 0);
    writeU32(view, offset + 16, entry.crc32);
    writeU32(view, offset + 20, entry.content.byteLength);
    writeU32(view, offset + 24, entry.content.byteLength);
    writeU16(view, offset + 28, entry.nameBytes.byteLength);
    writeU16(view, offset + 30, 0);
    writeU16(view, offset + 32, 0);
    writeU16(view, offset + 34, 0);
    writeU16(view, offset + 36, 0);
    writeU32(view, offset + 38, 0);
    writeU32(view, offset + 42, entry.localOffset);
    output.set(entry.nameBytes, offset + 46);
    offset += 46 + entry.nameBytes.byteLength;
  }

  writeU32(view, offset, 0x06054b50);
  writeU16(view, offset + 4, 0);
  writeU16(view, offset + 6, 0);
  writeU16(view, offset + 8, encoded.length);
  writeU16(view, offset + 10, encoded.length);
  writeU32(view, offset + 12, centralSize);
  writeU32(view, offset + 16, centralOffset);
  writeU16(view, offset + 20, 0);
  return output;
}
