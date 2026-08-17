import type { CreatedTransferResult } from './module_bindings/types';
import type { BatchUploadProgress } from './upload';

export type UploadNotice = { type: 'error' | 'success'; message: string } | null;
export type UploadDraftFile = {
  name: string;
  type: string;
  size: number;
  lastModified: number;
  uploadToken: string;
};
export type UploadDraft = {
  transferId: string;
  pickupCode: string;
  expiresAtMicros: string;
  expiryHours: number;
  files: UploadDraftFile[];
};

type DraftState = { draft: UploadDraft; notice: UploadNotice };
export type UploadTransferState =
  | { phase: 'idle'; notice: UploadNotice }
  | ({ phase: 'uploading'; progress: BatchUploadProgress | null } & DraftState)
  | ({ phase: 'pausing'; progress: BatchUploadProgress | null } & DraftState)
  | ({ phase: 'paused' } & DraftState)
  | ({ phase: 'cancelling'; progress: BatchUploadProgress | null } & DraftState)
  | ({ phase: 'failed'; failedFileNames: string[] } & DraftState)
  | ({ phase: 'delete_failed' } & DraftState)
  | { phase: 'sealed'; receipt: CreatedTransferResult; uploadedFiles: File[]; notice: UploadNotice };

export type UploadTransferEvent =
  | { type: 'START'; draft: UploadDraft }
  | { type: 'PROGRESS'; progress: BatchUploadProgress }
  | { type: 'PAUSE_REQUESTED' }
  | { type: 'PAUSED' }
  | { type: 'CANCEL_REQUESTED' }
  | { type: 'FAILED'; message: string; failedFileNames?: string[] }
  | { type: 'DELETE_FAILED'; message: string }
  | { type: 'SEALED'; receipt: CreatedTransferResult; uploadedFiles: File[] }
  | { type: 'RESET'; notice?: UploadNotice }
  | { type: 'DISMISS_NOTICE' };

export function uploadDraftOf(state: UploadTransferState) {
  return 'draft' in state ? state.draft : null;
}

export function uploadTransferReducer(
  state: UploadTransferState,
  event: UploadTransferEvent
): UploadTransferState {
  switch (event.type) {
    case 'START':
      if (!['idle', 'paused', 'failed'].includes(state.phase)) return state;
      return { phase: 'uploading', draft: event.draft, progress: null, notice: null };
    case 'PROGRESS':
      if (state.phase !== 'uploading') return state;
      return { ...state, progress: event.progress };
    case 'PAUSE_REQUESTED':
      if (state.phase !== 'uploading') return state;
      return { ...state, phase: 'pausing' };
    case 'PAUSED':
      if (state.phase !== 'pausing') return state;
      return {
        phase: 'paused',
        draft: state.draft,
        notice: { type: 'success', message: '上传已暂停，已完成的分块已保留。' },
      };
    case 'CANCEL_REQUESTED':
      if (state.phase !== 'uploading' && state.phase !== 'pausing') return state;
      return { ...state, phase: 'cancelling' };
    case 'FAILED': {
      const draft = uploadDraftOf(state);
      if (!draft) return { phase: 'idle', notice: { type: 'error', message: event.message } };
      return {
        phase: 'failed',
        draft,
        failedFileNames: event.failedFileNames ?? [],
        notice: { type: 'error', message: event.message },
      };
    }
    case 'DELETE_FAILED': {
      const draft = uploadDraftOf(state);
      if (!draft) return state;
      return {
        phase: 'delete_failed',
        draft,
        notice: { type: 'error', message: event.message },
      };
    }
    case 'SEALED':
      return {
        phase: 'sealed',
        receipt: event.receipt,
        uploadedFiles: event.uploadedFiles,
        notice: null,
      };
    case 'RESET':
      return { phase: 'idle', notice: event.notice ?? null };
    case 'DISMISS_NOTICE':
      return { ...state, notice: null };
  }
}
