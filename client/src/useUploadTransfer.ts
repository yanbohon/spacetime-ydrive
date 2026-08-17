import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { DbConnection } from './module_bindings';
import type { CreatedTransferResult } from './module_bindings/types';
import { uploadFilesConcurrently, type UploadResumeState } from './upload';
import {
  uploadDraftOf as draftOf,
  uploadTransferReducer,
  type UploadDraft,
  type UploadTransferEvent,
  type UploadTransferState,
} from './uploadTransferState';


const UPLOAD_DRAFT_KEY = 'ydrive:pending-upload';

function readUploadDraft(): UploadDraft | null {
  try {
    const value = window.localStorage.getItem(UPLOAD_DRAFT_KEY);
    return value ? JSON.parse(value) as UploadDraft : null;
  } catch {
    return null;
  }
}

function storeUploadDraft(draft: UploadDraft | null) {
  try {
    if (draft) window.localStorage.setItem(UPLOAD_DRAFT_KEY, JSON.stringify(draft));
    else window.localStorage.removeItem(UPLOAD_DRAFT_KEY);
  } catch {
    // The current page can still finish when persistent storage is unavailable.
  }
}


function initialState(): UploadTransferState {
  const draft = readUploadDraft();
  return draft
    ? {
        phase: 'paused',
        draft,
        notice: { type: 'success', message: '发现未完成上传，请重新选择原文件继续。' },
      }
    : { phase: 'idle', notice: null };
}

function uploadErrorMessage(error: unknown, fallback: string) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const message = raw.replace(/^.*SenderError:\s*/i, '').trim();
  if (/not found/i.test(message)) return '未找到该快传，可能已过期或被删除。';
  if (/expired/i.test(message)) return '该上传已过期。';
  return message || fallback;
}

export function matchDraftFiles(files: File[], draft: UploadDraft) {
  const remaining = [...files];
  const matched: File[] = [];
  for (const expected of draft.files) {
    const index = remaining.findIndex((file) =>
      file.name === expected.name &&
      file.type === expected.type &&
      file.size === expected.size &&
      file.lastModified === expected.lastModified
    );
    if (index === -1) return null;
    matched.push(remaining.splice(index, 1)[0]);
  }
  return remaining.length ? null : matched;
}

export function useUploadTransfer(connection: DbConnection | null, isActive: boolean) {
  const [state, reactDispatch] = useReducer(uploadTransferReducer, undefined, initialState);
  const stateRef = useRef(state);
  const abortRef = useRef<AbortController | null>(null);
  const getPhase = useCallback((): UploadTransferState['phase'] => stateRef.current.phase, []);

  const dispatch = useCallback((event: UploadTransferEvent) => {
    stateRef.current = uploadTransferReducer(stateRef.current, event);
    reactDispatch(event);
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const deleteDraft = useCallback(async (draft: UploadDraft) => {
    if (!connection || !isActive) {
      dispatch({ type: 'DELETE_FAILED', message: '服务未连接，快传尚未删除；请连接后重试。' });
      return false;
    }
    try {
      await connection.reducers.deleteTransfer({ transferId: BigInt(draft.transferId) });
      storeUploadDraft(null);
      dispatch({ type: 'RESET', notice: { type: 'success', message: '未完成上传已删除。' } });
      return true;
    } catch (error) {
      dispatch({
        type: 'DELETE_FAILED',
        message: `删除失败，恢复信息已保留：${uploadErrorMessage(error, '请重试。')}`,
      });
      return false;
    }
  }, [connection, dispatch, isActive]);

  const start = useCallback(async (files: File[], expiryHours: number) => {
    if (!connection || !isActive || !files.length) return;
    const current = stateRef.current;
    if (!['idle', 'paused', 'failed'].includes(current.phase)) return;

    let draft = draftOf(current);
    try {
      if (!draft) {
        const created = await connection.procedures.createTransfer({ expiresInHours: expiryHours });
        draft = {
          transferId: String(created.transferId),
          pickupCode: created.pickupCode,
          expiresAtMicros: String(created.expiresAtMicros),
          expiryHours,
          files: files.map((file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
            lastModified: file.lastModified,
            uploadToken: crypto.randomUUID(),
          })),
        };
        storeUploadDraft(draft);
      }
      dispatch({ type: 'START', draft });
      const abortController = new AbortController();
      abortRef.current = abortController;

      const transferId = BigInt(draft.transferId);
      const resumeStates = await Promise.all(draft.files.map(async (file): Promise<UploadResumeState | undefined> => {
        let status;
        try {
          status = await connection.procedures.getUploadStatus({ uploadToken: file.uploadToken });
        } catch (error) {
          if (/Upload session not found/i.test(String(error))) return undefined;
          throw error;
        }
        if (
          status.transferId !== transferId ||
          status.name !== file.name ||
          status.mimeType !== (file.type || 'application/octet-stream') ||
          status.sizeBytes !== BigInt(file.size)
        ) {
          throw new Error(`文件 ${file.name} 的恢复状态不匹配。`);
        }
        return {
          uploadToken: file.uploadToken,
          ready: status.ready,
          receivedBytes: Number(status.receivedBytes),
          uploadedChunkIndexes: status.uploadedChunkIndexes,
        };
      }));

      const result = await uploadFilesConcurrently({
        transferId,
        files,
        reducers: connection.reducers,
        uploadTokens: draft.files.map((file) => file.uploadToken),
        resumeStates,
        signal: abortController.signal,
        onProgress: (progress) => dispatch({ type: 'PROGRESS', progress }),
      });
      if (getPhase() === 'cancelling') {
        await deleteDraft(draft);
        return;
      }
      if (getPhase() === 'pausing') {
        dispatch({ type: 'PAUSED' });
        return;
      }

      if (result.cancelled) {
        dispatch({ type: 'FAILED', message: '上传已中断，可以继续上传。' });
        return;
      }
      if (result.failedFiles.length) {
        dispatch({
          type: 'FAILED',
          failedFileNames: result.failedFiles.map(({ file }) => file.name),
          message: `${result.failedFiles.length} 个文件上传失败或中断；已完成的分块已保留。`,
        });
        return;
      }

      await connection.reducers.sealTransfer({ transferId });
      if (getPhase() === 'cancelling') {
        await deleteDraft(draft);
        return;
      }
      const receipt: CreatedTransferResult = {
        transferId,
        pickupCode: draft.pickupCode,
        expiresAtMicros: BigInt(draft.expiresAtMicros),
      };
      storeUploadDraft(null);
      dispatch({ type: 'SEALED', receipt, uploadedFiles: result.uploadedFiles as File[] });
    } catch (error) {
      const currentPhase = getPhase();
      if (currentPhase === 'cancelling' && draft) await deleteDraft(draft);
      else if (currentPhase === 'pausing') dispatch({ type: 'PAUSED' });
      else dispatch({ type: 'FAILED', message: uploadErrorMessage(error, '发送失败，请重试。') });
    } finally {
      abortRef.current = null;
    }
  }, [connection, deleteDraft, dispatch, getPhase, isActive]);

  const pause = useCallback(() => {
    if (stateRef.current.phase !== 'uploading') return;
    dispatch({ type: 'PAUSE_REQUESTED' });
    abortRef.current?.abort();
  }, [dispatch]);

  const cancel = useCallback(() => {
    if (stateRef.current.phase !== 'uploading' && stateRef.current.phase !== 'pausing') return;
    dispatch({ type: 'CANCEL_REQUESTED' });
    abortRef.current?.abort();
  }, [dispatch]);

  const abandon = useCallback(async () => {
    const draft = draftOf(stateRef.current);
    return draft ? deleteDraft(draft) : false;
  }, [deleteDraft]);

  const reset = useCallback(() => {
    if (stateRef.current.phase === 'sealed') dispatch({ type: 'RESET' });
  }, [dispatch]);

  const dismissNotice = useCallback(() => dispatch({ type: 'DISMISS_NOTICE' }), [dispatch]);

  useEffect(() => {
    const active = ['uploading', 'pausing', 'cancelling'].includes(state.phase);
    if (!active) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [state.phase]);

  return { state, start, pause, cancel, abandon, reset, dismissNotice };
}
