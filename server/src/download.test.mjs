import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assembleByteRange,
  contentDisposition,
  parseByteRange,
  parseDownloadFileId,
} from './download.ts';

test('parses a file id from absolute and relative request URIs', () => {
  assert.equal(parseDownloadFileId('/download?id=29'), 29n);
  assert.equal(
    parseDownloadFileId('https://maincloud.spacetimedb.com/v1/database/db/route/download?x=1&id=29'),
    29n
  );
  assert.equal(parseDownloadFileId('/download?id=29#fragment'), 29n);
  assert.equal(parseDownloadFileId('/download'), null);
  assert.equal(parseDownloadFileId('/download?id=-1'), null);
  assert.equal(parseDownloadFileId('/download?id=1&id=2'), null);
  assert.equal(parseDownloadFileId('/download?id=18446744073709551616'), null);
});

test('parses closed, open-ended, and suffix byte ranges', () => {
  assert.deepEqual(parseByteRange(null, 1000n), { kind: 'full' });
  assert.deepEqual(parseByteRange('bytes=100-199', 1000n), {
    kind: 'partial',
    range: { start: 100n, end: 199n },
  });
  assert.deepEqual(parseByteRange('bytes=900-', 1000n), {
    kind: 'partial',
    range: { start: 900n, end: 999n },
  });
  assert.deepEqual(parseByteRange('bytes=-100', 1000n), {
    kind: 'partial',
    range: { start: 900n, end: 999n },
  });
  assert.deepEqual(parseByteRange('bytes=-2000', 1000n), {
    kind: 'partial',
    range: { start: 0n, end: 999n },
  });
  assert.deepEqual(parseByteRange('bytes=900-2000', 1000n), {
    kind: 'partial',
    range: { start: 900n, end: 999n },
  });
});

test('rejects malformed, multiple, and out-of-bounds ranges', () => {
  for (const value of [
    'items=0-1',
    'bytes=-',
    'bytes=-0',
    'bytes=1000-',
    'bytes=20-10',
    'bytes=0-1,4-5',
  ]) {
    assert.deepEqual(parseByteRange(value, 1000n), { kind: 'unsatisfiable' });
  }
  assert.deepEqual(parseByteRange('bytes=0-0', 0n), { kind: 'unsatisfiable' });
});

test('assembles only the requested bytes across chunk boundaries', () => {
  const chunks = [
    Uint8Array.from([0, 1, 2, 3]),
    Uint8Array.from([4, 5, 6, 7]),
    Uint8Array.from([8, 9]),
  ];
  const requested = [];
  const body = assembleByteRange({ start: 2n, end: 8n }, 4, (index) => {
    requested.push(index);
    return chunks[index];
  });

  assert.deepEqual(requested, [0, 1, 2]);
  assert.deepEqual([...body], [2, 3, 4, 5, 6, 7, 8]);
});

test('fails when stored chunks cannot cover the requested range', () => {
  assert.throws(
    () => assembleByteRange({ start: 4n, end: 7n }, 4, () => undefined),
    /chunk 1 is missing/
  );
  assert.throws(
    () => assembleByteRange({ start: 2n, end: 5n }, 4, () => Uint8Array.from([0, 1])),
    /does not cover/
  );
});

test('creates an ASCII fallback and UTF-8 download filename', () => {
  assert.equal(
    contentDisposition('测试 "file".txt'),
    'attachment; filename="__ _file_.txt"; filename*=UTF-8\'\'%E6%B5%8B%E8%AF%95%20%22file%22.txt'
  );
});
