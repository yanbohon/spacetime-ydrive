import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  Check,
  Clock3,
  CloudLightning,
  Copy,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  Eye,
  History,
  Link2,
  Plus,
  Send,
  RefreshCw,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, tables } from './module_bindings';
import type {
  OwnedTransferResult,
  TransferFileResult,
  TransferResult,
} from './module_bindings/types';
import { getBatchDownloadUrl, getDownloadUrl, getPreviewUrl } from './config';
import { type BatchUploadProgress } from './upload';
import { matchDraftFiles, useUploadTransfer } from './useUploadTransfer';

type Mode = 'send' | 'receive' | 'manage';
type Notice = { type: 'error' | 'success'; message: string } | null;
const compactNumberFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function formatCount(value: bigint) {
  return compactNumberFormatter.format(value);
}

function formatBytes(size: number | bigint) {
  const value = typeof size === 'bigint' ? Number(size) : size;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatExpiry(expiresAtMicros: bigint) {
  if (expiresAtMicros === 0n) return '永久有效';
  const date = new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(Number(expiresAtMicros / 1000n)));
  return `${date} 前有效`;
}

function formatPickupCode(value: string) {
  return value.replace(/[\s-]/g, '').toUpperCase().match(/.{1,4}/g)?.join('-') ?? value;
}

function readCodeFromHash() {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return params.get('code') ?? '';
}

function getShareUrl(pickupCode: string) {
  const url = new URL(window.location.href);
  url.hash = `code=${encodeURIComponent(pickupCode)}`;
  return url.toString();
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return FileImage;
  if (mimeType.startsWith('video/')) return FileVideo;
  if (mimeType.startsWith('audio/')) return FileAudio;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive')) {
    return FileArchive;
  }
  if (mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('code')) {
    return FileCode2;
  }
  if (mimeType.includes('text') || mimeType.includes('pdf') || mimeType.includes('document')) {
    return FileText;
  }
  return File;
}

function errorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/^.*SenderError:\s*/i, '').trim();
  if (/not found/i.test(message)) return '未找到该快传，请检查取件码。';
  if (/expired/i.test(message)) return '该快传已过期。';
  return message || fallback;
}

function App() {
  const { isActive, getConnection } = useSpacetimeDB();
  const connection = getConnection() as DbConnection | null;
  const initialCode = useMemo(readCodeFromHash, []);
  const [statsRows, statsReady] = useTable(tables.platformStats);
  const stats = statsRows[0];
  const [mode, setMode] = useState<Mode>(initialCode ? 'receive' : 'send');
  const tabRefs = useRef<Record<Mode, HTMLButtonElement | null>>({ send: null, receive: null, manage: null });

  const selectMode = (nextMode: Mode) => {
    setMode(nextMode);
    tabRefs.current[nextMode]?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentMode: Mode) => {
    const modes: Mode[] = ['send', 'receive', 'manage'];
    const index = modes.indexOf(currentMode);
    let nextMode: Mode | null = null;
    if (event.key === 'ArrowRight') nextMode = modes[(index + 1) % modes.length];
    if (event.key === 'ArrowLeft') nextMode = modes[(index - 1 + modes.length) % modes.length];
    if (event.key === 'Home') nextMode = modes[0];
    if (event.key === 'End') nextMode = modes[modes.length - 1];
    if (!nextMode) return;
    event.preventDefault();
    selectMode(nextMode);
  };
  return (
    <div className="quick-shell">
      <header className="quick-header">
        <a className="quick-brand" href="/" aria-label="YDrive 快传首页">
          <span className="quick-brand-mark"><CloudLightning size={22} strokeWidth={2.4} /></span>
          <span>YDrive <strong>快传</strong></span>
        </a>
        <div className="connection-state">
          <span className={`status-dot ${isActive ? 'online' : ''}`} />
          {isActive ? '服务已连接' : '正在连接'}
        </div>
      </header>

      <main className="quick-main">
        <section className="hero-copy">
          <p className="eyebrow"><Zap size={13} fill="currentColor" /> 无需登录，即传即取</p>
          <h1>这份文件，<br /><span>只有他看得见。</span></h1>
          <p>上传后生成一次快传取件码。只有拿到取件码的人，才能在有效期内查看和下载文件。</p>
        </section>

        <section className="transfer-card" aria-label="文件快传">
          <div className="mode-tabs" role="tablist" aria-label="快传模式">
            <button id="send-tab" ref={(node) => { tabRefs.current.send = node; }} type="button" role="tab" aria-controls="send-panel" aria-selected={mode === 'send'} tabIndex={mode === 'send' ? 0 : -1} className={mode === 'send' ? 'active' : ''} onClick={() => setMode('send')} onKeyDown={(event) => handleTabKeyDown(event, 'send')}>
              <Send size={17} aria-hidden="true" /> 我要发送
            </button>
            <button id="receive-tab" ref={(node) => { tabRefs.current.receive = node; }} type="button" role="tab" aria-controls="receive-panel" aria-selected={mode === 'receive'} tabIndex={mode === 'receive' ? 0 : -1} className={mode === 'receive' ? 'active' : ''} onClick={() => setMode('receive')} onKeyDown={(event) => handleTabKeyDown(event, 'receive')}>
              <ArrowDownToLine size={17} aria-hidden="true" /> 我要接收
            </button>
            <button id="manage-tab" ref={(node) => { tabRefs.current.manage = node; }} type="button" role="tab" aria-controls="manage-panel" aria-selected={mode === 'manage'} tabIndex={mode === 'manage' ? 0 : -1} className={mode === 'manage' ? 'active' : ''} onClick={() => setMode('manage')} onKeyDown={(event) => handleTabKeyDown(event, 'manage')}>
              <History size={17} aria-hidden="true" /> 发送历史
            </button>
          </div>
          <div id="send-panel" className="mode-pane" role="tabpanel" aria-labelledby="send-tab" hidden={mode !== 'send'}>
            <SendPane connection={connection} isActive={isActive} />
          </div>
          <div id="receive-panel" className="mode-pane" role="tabpanel" aria-labelledby="receive-tab" hidden={mode !== 'receive'}>
            <ReceivePane connection={connection} isActive={isActive} initialCode={initialCode} />
          </div>
          {mode === 'manage' && <div id="manage-panel" className="mode-pane" role="tabpanel" aria-labelledby="manage-tab">
            <ManagePane connection={connection} isActive={isActive} />
          </div>}
        </section>

        <dl className="platform-stats" aria-label="平台实时数据" aria-busy={!statsReady}>
          <div><dt>累计文件</dt><dd>{stats ? formatCount(stats.totalFiles) : '—'}</dd></div>
          <div><dt><span className="live-dot" aria-hidden="true" />实时连接</dt><dd>{stats ? formatCount(stats.onlineConnections) : '—'}</dd></div>
          <div><dt>累计传输</dt><dd>{stats ? formatBytes(stats.totalFileBytes) : '—'}</dd></div>
          <div><dt>文件流量</dt><dd>{stats ? formatBytes(stats.totalTrafficBytes) : '—'}</dd></div>
        </dl>
      </main>
    </div>
  );
}

type PaneProps = {
  connection: DbConnection | null;
  isActive: boolean;
};

function SendPane({ connection, isActive }: PaneProps) {
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [expiryHours, setExpiryHours] = useState(24);
  const [viewNotice, setViewNotice] = useState<Notice>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadTransfer(connection, isActive);
  const { state } = upload;
  const uploadDraft = 'draft' in state ? state.draft : null;
  const isBusy = state.phase === 'uploading' || state.phase === 'pausing' || state.phase === 'cancelling';
  const progress = isBusy ? state.progress : null;
  const receipt = state.phase === 'sealed' ? state.receipt : null;
  const uploadedFiles = state.phase === 'sealed' ? state.uploadedFiles : [];
  const failedFileNames = new Set(state.phase === 'failed' ? state.failedFileNames : []);
  const notice = viewNotice ?? state.notice;
  const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);

  const dismissNotice = () => {
    if (viewNotice) setViewNotice(null);
    else upload.dismissNotice();
  };

  const addFiles = useCallback((files: FileList | File[]) => {
    const additions = Array.from(files);
    if (!additions.length) return;
    if (uploadDraft) {
      const matched = matchDraftFiles(additions, uploadDraft);
      if (!matched) {
        setViewNotice({ type: 'error', message: '所选文件与待恢复上传不一致，请选择原来的完整文件集。' });
        return;
      }
      setSelectedFiles(matched);
      setViewNotice({ type: 'success', message: '文件已匹配，可以继续未完成的上传。' });
    } else {
      setSelectedFiles((current) => [...current, ...additions]);
      setViewNotice(null);
    }
    if (inputRef.current) inputRef.current.value = '';
  }, [uploadDraft]);

  useEffect(() => {
    if (state.phase === 'sealed') setSelectedFiles([]);
  }, [state.phase]);

  if (receipt) {
    const shareUrl = getShareUrl(receipt.pickupCode);
    const copy = async (text: string, message: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setViewNotice({ type: 'success', message });
      } catch {
        setViewNotice({ type: 'error', message: '复制失败，请手动选择复制。' });
      }
    };
    return (
      <div className="pane-content receipt-pane">
        <div className="success-orbit"><Check size={28} strokeWidth={2.5} /></div>
        <p className="pane-kicker">文件已准备好</p>
        <h2>把取件码发给对方</h2>
        <button className="pickup-code" type="button" title="复制取件码" onClick={() => void copy(formatPickupCode(receipt.pickupCode), '取件码已复制。')}>
          {formatPickupCode(receipt.pickupCode)} <Copy size={17} />
        </button>
        <div className="receipt-meta">
          <span>{uploadedFiles.length} 个文件 · {formatBytes(uploadedFiles.reduce((sum, file) => sum + file.size, 0))}</span>
          <span><Clock3 size={13} /> {formatExpiry(receipt.expiresAtMicros)}</span>
        </div>
        <button className="primary-action" type="button" onClick={() => void copy(shareUrl, '快传链接已复制。')}>
          <Link2 size={17} /> 复制快传链接
        </button>
        <button className="text-action" type="button" onClick={() => { upload.reset(); setViewNotice(null); }}>
          <Plus size={15} /> 再发一批文件
        </button>
        <NoticeView notice={notice} onClose={dismissNotice} />
      </div>
    );
  }

  return (
    <div
      className={`pane-content send-pane ${dragActive ? 'is-dragging' : ''}`}
      onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        addFiles(event.dataTransfer.files);
      }}
    >
      {selectedFiles.length === 0 ? (
        <div className="upload-drop">
          <span className="upload-illustration" aria-hidden="true"><Upload size={26} /></span>
          <strong>{uploadDraft ? '选择原文件继续上传' : '拖入文件开始快传'}</strong>
          <span>{uploadDraft ? `${uploadDraft.files.length} 个文件等待恢复` : '支持多文件和大文件分块上传'}</span>
          <button className="upload-select-button" type="button" disabled={isBusy} onClick={() => inputRef.current?.click()}>{uploadDraft ? '选择原文件' : '选择文件'}</button>
          <input ref={inputRef} className="file-input" type="file" multiple tabIndex={-1} onChange={(event) => addFiles(event.target.files ?? [])} />
        </div>
      ) : (
        <>
          <div className="selection-heading">
            <div><strong>{uploadDraft ? '待恢复文件' : '待发送文件'}</strong><span>{selectedFiles.length} 个 · {formatBytes(totalSize)}</span></div>
            {!uploadDraft && <><button className="add-file-button" type="button" disabled={isBusy} onClick={() => inputRef.current?.click()}><Plus size={15} aria-hidden="true" /> 添加文件</button><input ref={inputRef} className="file-input" type="file" multiple tabIndex={-1} disabled={isBusy} onChange={(event) => addFiles(event.target.files ?? [])} /></>}
          </div>
          <div className="selected-files">
            {selectedFiles.map((file, index) => {
              const Icon = getFileIcon(file.type);
              return (
                <div className="selected-file" key={`${file.name}-${file.lastModified}-${index}`}>
                  <span className="file-icon"><Icon size={18} /></span>
                  <span className="selected-file-name"><strong title={file.name}>{file.name}</strong><small>{formatBytes(file.size)}{failedFileNames.has(file.name) ? ' · 上传失败' : ''}</small></span>
                  <button type="button" disabled={isBusy || Boolean(uploadDraft)} aria-label={`移除 ${file.name}`} onClick={() => setSelectedFiles((files) => files.filter((_, fileIndex) => fileIndex !== index))}><Trash2 size={16} /></button>
                </div>
              );
            })}
          </div>
          {progress && <UploadProgress progress={progress} />}
          <div className="send-options">
            <label><Clock3 size={15} /> 有效期</label>
            <select value={uploadDraft?.expiryHours ?? expiryHours} disabled={isBusy || Boolean(uploadDraft)} onChange={(event) => setExpiryHours(Number(event.target.value))}>
              <option value={24}>24 小时</option>
              <option value={72}>3 天</option>
              <option value={168}>7 天</option>
              <option value={0}>永久有效</option>
            </select>
          </div>
          <button
            className="primary-action"
            type="button"
            disabled={(!isActive && state.phase !== 'uploading') || state.phase === 'pausing' || state.phase === 'cancelling' || state.phase === 'delete_failed'}
            onClick={() => state.phase === 'uploading' ? upload.pause() : void upload.start(selectedFiles, uploadDraft?.expiryHours ?? expiryHours)}
          >
            {state.phase === 'uploading'
              ? <><X size={17} /> 暂停上传 {progress?.percent ?? 0}%</>
              : state.phase === 'pausing'
                ? <>正在暂停</>
                : state.phase === 'cancelling'
                  ? <>正在取消</>
                  : state.phase === 'delete_failed'
                    ? <>删除失败，请重试删除</>
                    : <><Send size={17} /> {uploadDraft ? '继续上传' : '生成取件码'}</>}
          </button>
          {(state.phase === 'uploading' || state.phase === 'pausing') && <button className="text-action" type="button" onClick={upload.cancel}><Trash2 size={15} /> 取消并删除本次上传</button>}
          {uploadDraft && !isBusy && <button className="text-action" type="button" onClick={async () => { if (await upload.abandon()) setSelectedFiles([]); }}><Trash2 size={15} /> {state.phase === 'delete_failed' ? '重试删除未完成上传' : '放弃未完成上传'}</button>}
        </>
      )}
      <NoticeView notice={notice} onClose={dismissNotice} />
    </div>
  );
}

function ManagePane({ connection, isActive }: PaneProps) {
  const [transfers, setTransfers] = useState<OwnedTransferResult[]>([]);
  const [notice, setNotice] = useState<Notice>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadTransfers = useCallback(async () => {
    if (!connection || !isActive) return;
    setIsLoading(true);
    setNotice(null);
    try {
      setTransfers(await connection.procedures.listOwnedTransfers({}));
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error, '读取快传记录失败。') });
    } finally {
      setIsLoading(false);
    }
  }, [connection, isActive]);

  useEffect(() => {
    void loadTransfers();
  }, [loadTransfers]);

  const copyLink = async (pickupCode: string) => {
    try {
      await navigator.clipboard.writeText(getShareUrl(pickupCode));
      setNotice({ type: 'success', message: '快传链接已复制。' });
    } catch {
      setNotice({ type: 'error', message: '复制失败。' });
    }
  };

  const deleteOwnedTransfer = async (transferId: bigint, pickupCode: string) => {
    if (!connection) return;
    const confirmed = window.confirm(`确定删除快传 ${formatPickupCode(pickupCode)}？删除后文件将无法恢复。`);
    if (!confirmed) return;
    try {
      await connection.reducers.deleteTransfer({ transferId });
      setTransfers((current) => current.filter((item) => item.transferId !== transferId));
      setNotice({ type: 'success', message: '快传已删除。' });
    } catch (error) {
      setNotice({ type: 'error', message: errorMessage(error, '删除失败，请重试。') });
    }
  };

  return (
    <div className="pane-content manage-pane">
      <div className="manage-heading">
        <div><p className="pane-kicker">当前浏览器身份</p><h2>发送历史</h2></div>
        <button type="button" aria-label="刷新快传记录" onClick={() => void loadTransfers()} disabled={!isActive || isLoading}><RefreshCw size={17} /></button>
      </div>
      {transfers.length ? (
        <div className="manage-list">
          {transfers.map((item) => (
            <div className="manage-item" key={String(item.transferId)}>
              <div className="manage-item-copy">
                <strong>{formatPickupCode(item.pickupCode)}</strong>
                <span>{item.sealed ? `${item.fileCount} 个文件 · ${formatBytes(item.totalSizeBytes)}` : '上传未完成'} · {formatExpiry(item.expiresAtMicros)}</span>
              </div>
              <div className="manage-actions">
                {item.sealed && <button type="button" title="复制链接" aria-label={`复制快传 ${formatPickupCode(item.pickupCode)} 的链接`} onClick={() => void copyLink(item.pickupCode)}><Copy size={16} /></button>}
                <button className="destructive-action" type="button" title="删除" aria-label={`删除快传 ${formatPickupCode(item.pickupCode)}`} onClick={() => void deleteOwnedTransfer(item.transferId, item.pickupCode)}><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      ) : !isLoading ? (
        <div className="manage-empty"><History size={28} /><strong>还没有快传记录</strong><span>发送成功或暂停中的快传会显示在这里。</span></div>
      ) : null}
      {isLoading && <div className="manage-loading" role="status" aria-label="正在读取发送历史"><span className="button-spinner" /></div>}
      <NoticeView notice={notice} onClose={() => setNotice(null)} />
    </div>
  );
}

type ReceivePaneProps = PaneProps & { initialCode: string };

function ReceivePane({ connection, isActive, initialCode }: ReceivePaneProps) {
  const [pickupCode, setPickupCode] = useState(formatPickupCode(initialCode));
  const [transfer, setTransfer] = useState<TransferResult | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isAutoReceiving, setIsAutoReceiving] = useState(Boolean(initialCode));
  const [previewFile, setPreviewFile] = useState<TransferFileResult | null>(null);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<bigint>>(new Set());
  const autoReceivedRef = useRef(false);

  const receive = useCallback(async () => {
    if (!connection || !isActive) {
      setNotice({ type: 'error', message: '服务尚未连接，请稍后重试。' });
      return;
    }
    if (!pickupCode.trim() || isLoading) return;
    setIsLoading(true);
    setNotice(null);
    try {
      const result = await connection.procedures.receiveTransfer({ pickupCode });
      setTransfer(result);
      setSelectedFileIds(new Set(result.files.map((file) => file.id)));
      setPickupCode(formatPickupCode(result.pickupCode));
      window.history.replaceState(null, '', getShareUrl(result.pickupCode));
    } catch (error) {
      setTransfer(null);
      setNotice({ type: 'error', message: errorMessage(error, '领取失败，请重试。') });
    } finally {
      setIsLoading(false);
      setIsAutoReceiving(false);
    }
  }, [connection, isActive, isLoading, pickupCode]);

  useEffect(() => {
    if (!initialCode || !isActive || !connection || autoReceivedRef.current) return;
    autoReceivedRef.current = true;
    void receive();
  }, [connection, initialCode, isActive, receive]);

  const downloadSelected = () => {
    if (!transfer) return;
    const selectedFiles = transfer.files.filter((file) => selectedFileIds.has(file.id));
    if (!selectedFiles.length) return;
    const anchor = document.createElement('a');
    anchor.href = getBatchDownloadUrl(selectedFiles.map((file) => file.id), transfer.pickupCode);
    anchor.download = `YDrive-${transfer.pickupCode}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setNotice({ type: 'success', message: `正在打包下载 ${selectedFiles.length} 个文件。` });
  };
  if (transfer) {
    return (
      <div className="pane-content received-pane">
        <div className="received-heading">
          <div>
            <p className="pane-kicker">取件码 {formatPickupCode(transfer.pickupCode)}</p>
            <h2>收到 {transfer.files.length} 个文件</h2>
          </div>
          <span><Clock3 size={13} /> {formatExpiry(transfer.expiresAtMicros)}</span>
        </div>
        <div className="batch-actions">
          <label><input type="checkbox" checked={selectedFileIds.size === transfer.files.length} onChange={(event) => setSelectedFileIds(event.target.checked ? new Set(transfer.files.map((file) => file.id)) : new Set())} /> 全选</label>
          <button type="button" disabled={!selectedFileIds.size} onClick={downloadSelected}><Download size={15} /> 下载已选（{selectedFileIds.size}）</button>
        </div>
        <div className="received-files">
          {transfer.files.map((file) => (
            <ReceivedFile
              key={String(file.id)}
              file={file}
              pickupCode={transfer.pickupCode}
              selected={selectedFileIds.has(file.id)}
              onToggle={(selected) => setSelectedFileIds((current) => {
                const next = new Set(current);
                if (selected) next.add(file.id);
                else next.delete(file.id);
                return next;
              })}
              onCopy={async (downloadUrl) => {
                try {
                  await navigator.clipboard.writeText(downloadUrl);
                  setNotice({ type: 'success', message: '下载直链已复制。' });
                } catch {
                  setNotice({ type: 'error', message: '复制失败，请手动复制下载地址。' });
                }
              }}
              onPreview={setPreviewFile}
            />
          ))}
        </div>
        {previewFile && (
          <MediaPreview
            file={previewFile}
            pickupCode={transfer.pickupCode}
            onClose={() => setPreviewFile(null)}
          />
        )}
        <NoticeView notice={notice} onClose={() => setNotice(null)} />
        <button className="text-action receive-again-button" type="button" onClick={() => { setTransfer(null); setPreviewFile(null); setSelectedFileIds(new Set()); setPickupCode(''); setNotice(null); window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); }}>
          领取另一批文件
        </button>
      </div>
    );
  }

  return (
    <div className="pane-content receive-pane" aria-busy={isLoading || isAutoReceiving}>
      <label className="code-input">
        <span>取件码</span>
        <input
          autoFocus
          value={pickupCode}
          maxLength={19}
          placeholder="0000-0000-0000-0000"
          autoComplete="off"
          spellCheck={false}
          readOnly={isAutoReceiving}
          onChange={(event) => setPickupCode(formatPickupCode(event.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 16)))}
          onKeyDown={(event) => { if (event.key === 'Enter') void receive(); }}
        />
      </label>
      <button className="primary-action" type="button" disabled={!isActive || isLoading || isAutoReceiving || pickupCode.replace(/-/g, '').length !== 16} onClick={() => void receive()}>
        {isAutoReceiving
          ? <><span className="button-spinner" /> {isActive ? '正在领取文件' : '正在连接并领取文件'}</>
          : isLoading
            ? <><span className="button-spinner" /> 正在查找</>
            : <>领取文件 <ArrowRight size={17} /></>}
      </button>
      <NoticeView notice={notice} onClose={() => setNotice(null)} />
    </div>
  );
}

type ReceivedFileProps = {
  file: TransferFileResult;
  pickupCode: string;
  selected: boolean;
  onToggle: (selected: boolean) => void;
  onCopy: (downloadUrl: string) => void | Promise<void>;
  onPreview: (file: TransferFileResult) => void;
};

function ReceivedFile({ file, pickupCode, selected, onToggle, onCopy, onPreview }: ReceivedFileProps) {
  const Icon = getFileIcon(file.mimeType);
  const downloadUrl = getDownloadUrl(file.id, pickupCode);
  const canPreview = /^(image|audio|video)\//i.test(file.mimeType);
  return (
    <div className="received-file">
      <input className="received-select" type="checkbox" checked={selected} aria-label={`选择 ${file.name}`} onChange={(event) => onToggle(event.target.checked)} />
      <span className="file-icon"><Icon size={19} /></span>
      <span><strong title={file.name}>{file.name}</strong><small>{formatBytes(file.sizeBytes)}</small></span>
      <div className="received-actions">
        {canPreview && <button type="button" title="预览" aria-label={`预览 ${file.name}`} onClick={() => onPreview(file)}><Eye size={17} /></button>}
        <button type="button" title="复制下载直链" aria-label={`复制 ${file.name} 的下载直链`} onClick={() => void onCopy(downloadUrl)}><Copy size={17} /></button>
        <a href={downloadUrl} download={file.name} title="下载" aria-label={`下载 ${file.name}`}><Download size={18} /></a>
      </div>
    </div>
  );
}

function MediaPreview({ file, pickupCode, onClose }: { file: TransferFileResult; pickupCode: string; onClose: () => void }) {
  const previewUrl = getPreviewUrl(file.id, pickupCode);
  const downloadUrl = getDownloadUrl(file.id, pickupCode);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appShell = document.querySelector<HTMLElement>('.quick-shell');
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], audio[controls], video[controls]'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.style.overflow = 'hidden';
    if (appShell) appShell.inert = true;
    window.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (appShell) appShell.inert = false;
      window.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="preview-dialog" role="dialog" aria-modal="true" aria-label={`预览 ${file.name}`}>
        <header><strong title={file.name}>{file.name}</strong><button ref={closeButtonRef} type="button" aria-label="关闭预览" onClick={onClose}><X size={19} /></button></header>
        <div className="preview-body">
          {file.mimeType.startsWith('image/') && <img src={previewUrl} alt={file.name} />}
          {file.mimeType.startsWith('video/') && <video src={previewUrl} controls preload="metadata" />}
          {file.mimeType.startsWith('audio/') && <audio src={previewUrl} controls preload="metadata" />}
        </div>
        <a className="preview-download" href={downloadUrl} download={file.name}><Download size={16} /> 下载原文件</a>
      </section>
    </div>,
    document.body
  );
}

function UploadProgress({ progress }: { progress: BatchUploadProgress }) {
  return (
    <div className="compact-progress" aria-live="polite">
      <div><span>正在上传 {progress.completedFiles}/{progress.fileCount}</span><strong>{progress.percent}%</strong></div>
      <div className="progress-track" role="progressbar" aria-label="上传总进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
        <span style={{ width: `${progress.percent}%` }} />
      </div>
      <small>{formatBytes(progress.totalUploadedBytes)} / {formatBytes(progress.totalSizeBytes)}</small>
    </div>
  );
}

function NoticeView({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  if (!notice) return null;
  return (
    <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
      {notice.type === 'success' ? <Check size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
      <span>{notice.message}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示"><X size={15} aria-hidden="true" /></button>
    </div>
  );
}

export default App;
