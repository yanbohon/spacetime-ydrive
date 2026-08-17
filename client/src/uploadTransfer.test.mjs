import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadTransferReducer } from './uploadTransferState.ts';

const draft = {
  transferId: '7',
  pickupCode: 'A1B2C3D4E5F67890',
  expiresAtMicros: '0',
  expiryHours: 24,
  files: [{
    name: 'resume.bin',
    type: 'application/octet-stream',
    size: 12,
    lastModified: 1,
    uploadToken: 'resume-token',
  }],
};
const idle = { phase: 'idle', notice: null };

test('transitions uploading through pause and back to resume', () => {
  const uploading = uploadTransferReducer(idle, { type: 'START', draft });
  const pausing = uploadTransferReducer(uploading, { type: 'PAUSE_REQUESTED' });
  const paused = uploadTransferReducer(pausing, { type: 'PAUSED' });
  const resumed = uploadTransferReducer(paused, { type: 'START', draft });

  assert.equal(uploading.phase, 'uploading');
  assert.equal(pausing.phase, 'pausing');
  assert.equal(paused.phase, 'paused');
  assert.equal(resumed.phase, 'uploading');
  assert.equal(resumed.draft, draft);
});

test('retains the draft when cancel deletion fails', () => {
  const uploading = uploadTransferReducer(idle, { type: 'START', draft });
  const cancelling = uploadTransferReducer(uploading, { type: 'CANCEL_REQUESTED' });
  const failed = uploadTransferReducer(cancelling, {
    type: 'DELETE_FAILED',
    message: '删除失败，恢复信息已保留。',
  });

  assert.equal(cancelling.phase, 'cancelling');
  assert.equal(failed.phase, 'delete_failed');
  assert.equal(failed.draft, draft);
  assert.match(failed.notice.message, /恢复信息已保留/);
});

test('moves a resume status mismatch into failed without losing the draft', () => {
  const uploading = uploadTransferReducer(idle, { type: 'START', draft });
  const failed = uploadTransferReducer(uploading, {
    type: 'FAILED',
    message: '文件 resume.bin 的恢复状态不匹配。',
  });

  assert.equal(failed.phase, 'failed');
  assert.equal(failed.draft, draft);
  assert.match(failed.notice.message, /不匹配/);
});

test('seals successfully and removes draft state', () => {
  const uploading = uploadTransferReducer(idle, { type: 'START', draft });
  const sealed = uploadTransferReducer(uploading, {
    type: 'SEALED',
    receipt: { transferId: 7n, pickupCode: draft.pickupCode, expiresAtMicros: 0n },
    uploadedFiles: [],
  });

  assert.equal(sealed.phase, 'sealed');
  assert.equal('draft' in sealed, false);
  assert.equal(sealed.receipt.transferId, 7n);
});
