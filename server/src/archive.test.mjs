import assert from 'node:assert/strict';
import test from 'node:test';

import { createZipArchive, crc32 } from './archive.ts';

test('computes the standard CRC-32 checksum', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('creates a UTF-8 store-only ZIP with local and central records', () => {
  const encoder = new TextEncoder();
  const archive = createZipArchive([
    { name: '一.txt', content: encoder.encode('first') },
    { name: 'two.bin', content: new Uint8Array([1, 2, 3]) },
  ]);
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);

  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true), 0x0800);
  const endOffset = archive.byteLength - 22;
  assert.equal(view.getUint32(endOffset, true), 0x06054b50);
  assert.equal(view.getUint16(endOffset + 10, true), 2);
  const centralOffset = view.getUint32(endOffset + 16, true);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
});

test('rejects empty archives', () => {
  assert.throws(() => createZipArchive([]), /at least one entry/);
});
