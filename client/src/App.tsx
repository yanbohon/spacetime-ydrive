import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Link2,
  Plus,
  Send,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { useSpacetimeDB } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';
import type {
  CreatedTransferResult,
  TransferFileResult,
  TransferResult,
} from './module_bindings/types';
import { getDownloadUrl, getPreviewUrl } from './config';
import {
  uploadFilesConcurrently,
  type BatchUploadProgress,
} from './upload';

type Mode = 'send' | 'receive';
type Notice = { type: 'error' | 'success'; message: string } | null;

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
  const [mode, setMode] = useState<Mode>(initialCode ? 'receive' : 'send');

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

        <section className="transfer-card">
          <div className="mode-tabs" role="tablist" aria-label="快传模式">
            <button type="button" role="tab" aria-selected={mode === 'send'} className={mode === 'send' ? 'active' : ''} onClick={() => setMode('send')}>
              <Send size={17} /> 我要发送
            </button>
            <button type="button" role="tab" aria-selected={mode === 'receive'} className={mode === 'receive' ? 'active' : ''} onClick={() => setMode('receive')}>
              <ArrowDownToLine size={17} /> 我要接收
            </button>
          </div>
          <div className="mode-pane" hidden={mode !== 'send'}>
            <SendPane connection={connection} isActive={isActive} />
          </div>
          <div className="mode-pane" hidden={mode !== 'receive'}>
            <ReceivePane connection={connection} isActive={isActive} initialCode={initialCode} />
          </div>
        </section>

        <div className="trust-row" aria-label="快传特性">
          <span><Check size={14} /> 匿名使用</span>
          <span><Check size={14} /> 取件码隔离</span>
          <span><Check size={14} /> 可永久保存</span>
          <span><Check size={14} /> 支持断点下载</span>
        </div>
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
  const [progress, setProgress] = useState<BatchUploadProgress | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [receipt, setReceipt] = useState<CreatedTransferResult | null>(null);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);

  const addFiles = useCallback((files: FileList | File[]) => {
    const additions = Array.from(files);
    if (!additions.length) return;
    setSelectedFiles((current) => [...current, ...additions]);
    setNotice(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const startTransfer = async () => {
    if (!connection || !isActive) {
      setNotice({ type: 'error', message: '服务尚未连接，请稍后重试。' });
      return;
    }
    if (!selectedFiles.length || isUploading) return;

    setIsUploading(true);
    setNotice(null);
    let created: CreatedTransferResult | null = null;
    try {
      created = await connection.procedures.createTransfer({ expiresInHours: expiryHours });
      const result = await uploadFilesConcurrently({
        transferId: created.transferId,
        files: selectedFiles,
        reducers: connection.reducers,
        onProgress: setProgress,
      });
      if (!result.uploadedFiles.length) {
        await connection.reducers.deleteTransfer({ transferId: created.transferId });
        const firstFailure = result.failedFiles[0]?.error;
        throw firstFailure ?? new Error('没有文件上传成功。');
      }

      await connection.reducers.sealTransfer({ transferId: created.transferId });
      setReceipt(created);
      setUploadedFiles(result.uploadedFiles as File[]);
      setSelectedFiles([]);
      if (result.failedFiles.length) {
        setNotice({
          type: 'error',
          message: `${result.uploadedFiles.length} 个文件已发送，${result.failedFiles.length} 个上传失败。`,
        });
      }
    } catch (error) {
      if (created) {
        await connection.reducers.deleteTransfer({ transferId: created.transferId }).catch(() => undefined);
      }
      setNotice({ type: 'error', message: errorMessage(error, '发送失败，请重试。') });
    } finally {
      setIsUploading(false);
      setProgress(null);
    }
  };

  if (receipt) {
    const shareUrl = getShareUrl(receipt.pickupCode);
    const copy = async (text: string, message: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setNotice({ type: 'success', message });
      } catch {
        setNotice({ type: 'error', message: '复制失败，请手动选择复制。' });
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
        <button className="text-action" type="button" onClick={() => { setReceipt(null); setUploadedFiles([]); setNotice(null); }}>
          <Plus size={15} /> 再发一批文件
        </button>
        <NoticeView notice={notice} onClose={() => setNotice(null)} />
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
        <label className="upload-drop">
          <span className="upload-illustration"><Upload size={26} /></span>
          <strong>拖入文件，或点击选择</strong>
          <span>支持多文件和大文件分块上传</span>
          <input ref={inputRef} type="file" multiple onChange={(event) => addFiles(event.target.files ?? [])} />
        </label>
      ) : (
        <>
          <div className="selection-heading">
            <div><strong>待发送文件</strong><span>{selectedFiles.length} 个 · {formatBytes(totalSize)}</span></div>
            <label className="add-file-button"><Plus size={15} /> 添加<input ref={inputRef} type="file" multiple disabled={isUploading} onChange={(event) => addFiles(event.target.files ?? [])} /></label>
          </div>
          <div className="selected-files">
            {selectedFiles.map((file, index) => {
              const Icon = getFileIcon(file.type);
              return (
                <div className="selected-file" key={`${file.name}-${file.lastModified}-${index}`}>
                  <span className="file-icon"><Icon size={18} /></span>
                  <span className="selected-file-name"><strong title={file.name}>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
                  <button type="button" disabled={isUploading} aria-label={`移除 ${file.name}`} onClick={() => setSelectedFiles((files) => files.filter((_, fileIndex) => fileIndex !== index))}><Trash2 size={16} /></button>
                </div>
              );
            })}
          </div>
          {progress && <UploadProgress progress={progress} />}
          <div className="send-options">
            <label><Clock3 size={15} /> 有效期</label>
            <select value={expiryHours} disabled={isUploading} onChange={(event) => setExpiryHours(Number(event.target.value))}>
              <option value={24}>24 小时</option>
              <option value={72}>3 天</option>
              <option value={168}>7 天</option>
              <option value={0}>永久有效</option>
            </select>
          </div>
          <button className="primary-action" type="button" disabled={isUploading || !isActive} onClick={() => void startTransfer()}>
            {isUploading ? <><span className="button-spinner" /> 正在上传 {progress?.percent ?? 0}%</> : <><Send size={17} /> 生成取件码</>}
          </button>
        </>
      )}
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
  const [previewFile, setPreviewFile] = useState<TransferFileResult | null>(null);
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
      setPickupCode(formatPickupCode(result.pickupCode));
      window.history.replaceState(null, '', getShareUrl(result.pickupCode));
    } catch (error) {
      setTransfer(null);
      setNotice({ type: 'error', message: errorMessage(error, '领取失败，请重试。') });
    } finally {
      setIsLoading(false);
    }
  }, [connection, isActive, isLoading, pickupCode]);

  useEffect(() => {
    if (!initialCode || !isActive || autoReceivedRef.current) return;
    autoReceivedRef.current = true;
    void receive();
  }, [initialCode, isActive, receive]);

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
        <div className="received-files">
          {transfer.files.map((file) => (
            <ReceivedFile
              key={String(file.id)}
              file={file}
              pickupCode={transfer.pickupCode}
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
        <button className="text-action receive-again-button" type="button" onClick={() => { setTransfer(null); setPreviewFile(null); setPickupCode(''); setNotice(null); window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); }}>
          领取另一批文件
        </button>
      </div>
    );
  }

  return (
    <div className="pane-content receive-pane">
      <span className="receive-illustration"><ArrowDownToLine size={27} /></span>
      <p className="pane-kicker">接收文件</p>
      <h2>输入 16 位取件码</h2>
      <p className="pane-description">取件码仅用于本次快传，不需要账号或密码。</p>
      <label className="code-input">
        <span>取件码</span>
        <input
          autoFocus
          value={pickupCode}
          maxLength={19}
          placeholder="0000-0000-0000-0000"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setPickupCode(formatPickupCode(event.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 16)))}
          onKeyDown={(event) => { if (event.key === 'Enter') void receive(); }}
        />
      </label>
      <button className="primary-action" type="button" disabled={!isActive || isLoading || pickupCode.replace(/-/g, '').length !== 16} onClick={() => void receive()}>
        {isLoading ? <><span className="button-spinner" /> 正在查找</> : <>领取文件 <ArrowRight size={17} /></>}
      </button>
      <NoticeView notice={notice} onClose={() => setNotice(null)} />
    </div>
  );
}

type ReceivedFileProps = {
  file: TransferFileResult;
  pickupCode: string;
  onCopy: (downloadUrl: string) => void | Promise<void>;
  onPreview: (file: TransferFileResult) => void;
};

function ReceivedFile({ file, pickupCode, onCopy, onPreview }: ReceivedFileProps) {
  const Icon = getFileIcon(file.mimeType);
  const downloadUrl = getDownloadUrl(file.id, pickupCode);
  const canPreview = /^(image|audio|video)\//i.test(file.mimeType);
  return (
    <div className="received-file">
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

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return createPortal(
    <div className="preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="preview-dialog" role="dialog" aria-modal="true" aria-label={`预览 ${file.name}`}>
        <header><strong title={file.name}>{file.name}</strong><button type="button" aria-label="关闭预览" onClick={onClose}><X size={19} /></button></header>
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
    <div className={`notice ${notice.type}`} role="status">
      {notice.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
      <span>{notice.message}</span>
      <button type="button" onClick={onClose} aria-label="关闭提示"><X size={15} /></button>
    </div>
  );
}

export default App;
