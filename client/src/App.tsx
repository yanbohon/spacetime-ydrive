import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Cloud,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileText,
  FileVideo,
  FolderOpen,
  Grid2X2,
  List,
  MoreHorizontal,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { DbConnection, tables, type SubscriptionHandle } from './module_bindings';
import type { StoredFile } from './module_bindings/types';
import {
  uploadFilesConcurrently,
  type BatchUploadProgress,
} from './upload';

type ViewMode = 'list' | 'grid';
type Notice = { type: 'error' | 'success'; message: string } | null;

function formatBytes(size: number | bigint) {
  const value = typeof size === 'bigint' ? Number(size) : size;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatDate(timestamp: { microsSinceUnixEpoch: bigint }) {
  const date = new Date(Number(timestamp.microsSinceUnixEpoch / 1000n));
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return FileImage;
  if (mimeType.startsWith('video/')) return FileVideo;
  if (mimeType.startsWith('audio/')) return FileAudio;
  if (mimeType.includes('zip') || mimeType.includes('compressed') || mimeType.includes('archive')) {
    return FileArchive;
  }
  if (mimeType.includes('text') || mimeType.includes('pdf') || mimeType.includes('document')) {
    return FileText;
  }
  if (mimeType.includes('json') || mimeType.includes('javascript') || mimeType.includes('code')) {
    return FileCode2;
  }
  return File;
}

function formatActiveUploadNames(progress: BatchUploadProgress) {
  if (!progress.activeFileNames.length) return progress.latestProgressFileName;
  if (progress.activeFileNames.length <= 2) return progress.activeFileNames.join('、');
  return `${progress.activeFileNames.slice(0, 2).join('、')} 等 ${progress.activeFileNames.length} 个文件`;
}

function App() {
  const { isActive, getConnection } = useSpacetimeDB();
  const connection = getConnection() as DbConnection | null;
  const [files, filesReady] = useTable(tables.storedFile);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<BatchUploadProgress | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const uploadInFlightRef = useRef(false);

  const readyFiles = useMemo(() => files.filter((file) => file.ready), [files]);

  const sortedFiles = useMemo(
    () =>
      [...readyFiles]
        .filter((file) => file.name.toLowerCase().includes(search.toLowerCase().trim()))
        .sort((a, b) => {
          const aTime = a.createdAt.microsSinceUnixEpoch;
          const bTime = b.createdAt.microsSinceUnixEpoch;
          return aTime === bTime ? 0 : aTime > bTime ? -1 : 1;
        }),
    [readyFiles, search]
  );

  const totalSize = useMemo(
    () => readyFiles.reduce((sum, file) => sum + Number(file.sizeBytes), 0),
    [readyFiles]
  );

  const showNotice = useCallback((nextNotice: Notice) => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNotice(nextNotice);
    if (nextNotice) {
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, 4200);
    }
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    },
    []
  );

  const uploadFiles = useCallback(
    async (selectedFiles: FileList | File[]) => {
      if (!connection || !isActive) {
        showNotice({ type: 'error', message: '数据库尚未连接，请稍后重试。' });
        return;
      }
      if (uploadInFlightRef.current) {
        showNotice({ type: 'error', message: '已有文件正在上传，请稍后再试。' });
        return;
      }

      const filesToUpload = Array.from(selectedFiles);
      if (!filesToUpload.length) return;

      uploadInFlightRef.current = true;
      setIsUploading(true);
      showNotice(null);
      try {
        const result = await uploadFilesConcurrently({
          files: filesToUpload,
          reducers: connection.reducers,
          onProgress: setUploadProgress,
        });
        const uploadedCount = result.uploadedFiles.length;
        const failedFiles = result.failedFiles.map(({ file, error }) => ({
          name: file.name,
          reason: error instanceof Error ? error.message : '未知错误',
        }));

        if (failedFiles.length) {
          const uploadedText = uploadedCount ? `已上传 ${uploadedCount} 个；` : '';
          const detail = failedFiles.length === 1 ? `（${failedFiles[0].reason}）` : '';
          showNotice({
            type: 'error',
            message: `${uploadedText}${failedFiles.length} 个文件上传失败${detail}。`,
          });
        } else {
          showNotice({
            type: 'success',
            message: filesToUpload.length === 1 ? '文件已上传。' : `已上传 ${filesToUpload.length} 个文件。`,
          });
        }
      } catch (error) {
        showNotice({
          type: 'error',
          message: error instanceof Error ? error.message : '上传失败，请重试。',
        });
      } finally {
        uploadInFlightRef.current = false;
        setIsUploading(false);
        setUploadProgress(null);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [connection, isActive, showNotice]
  );

  const handleDelete = useCallback(
    async (id: bigint) => {
      if (!connection || !isActive) return;
      try {
        await connection.reducers.deleteFile({ id });
        showNotice({ type: 'success', message: '文件已删除。' });
      } catch (error) {
        showNotice({ type: 'error', message: error instanceof Error ? error.message : '删除失败，请重试。' });
      }
    },
    [connection, isActive, showNotice]
  );

  const downloadFile = useCallback(
    async (file: StoredFile) => {
      if (!connection || !isActive) {
        showNotice({ type: 'error', message: '数据库尚未连接，请稍后重试。' });
        return;
      }

      let canUnsubscribe = false;
      let subscription!: SubscriptionHandle;
      try {
        const parts = await new Promise<Uint8Array[]>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error('读取文件内容超时，请重试。')), 30_000);
          const fail = (message: string) => {
            window.clearTimeout(timer);
            reject(new Error(message));
          };

          if (file.chunkCount > 0) {
            subscription = connection.subscriptionBuilder()
              .onApplied((ctx) => {
                canUnsubscribe = true;
                window.clearTimeout(timer);
                const chunks = [...ctx.db.fileChunk.iter()]
                  .filter((chunk) => chunk.fileId === file.id)
                  .sort((a, b) => a.chunkIndex - b.chunkIndex);
                if (
                  chunks.length !== file.chunkCount ||
                  chunks.some((chunk, index) => chunk.chunkIndex !== index)
                ) {
                  reject(new Error('文件分块不完整。'));
                  return;
                }
                const downloadedBytes = chunks.reduce((sum, chunk) => sum + chunk.content.byteLength, 0);
                if (BigInt(downloadedBytes) !== file.sizeBytes) {
                  reject(new Error('文件内容大小不匹配。'));
                  return;
                }
                resolve(chunks.map((chunk) => new Uint8Array(chunk.content)));
              })
              .onError(() => fail('读取文件内容失败。'))
              .subscribe([tables.fileChunk.where((row) => row.fileId.eq(file.id))]);
            return;
          }

          if (file.sizeBytes === 0n) {
            window.clearTimeout(timer);
            resolve([new Uint8Array()]);
            return;
          }

          subscription = connection.subscriptionBuilder()
            .onApplied((ctx) => {
              canUnsubscribe = true;
              window.clearTimeout(timer);
              const row = ctx.db.fileBlob.id.find(file.id);
              if (!row) {
                reject(new Error('文件内容不存在。'));
                return;
              }
              resolve([new Uint8Array(row.content)]);
            })
            .onError(() => fail('读取文件内容失败。'))
            .subscribe([tables.fileBlob.where((row) => row.id.eq(file.id))]);
        });

        const blob = new Blob(parts, { type: file.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch (error) {
        showNotice({ type: 'error', message: error instanceof Error ? error.message : '下载失败，请重试。' });
      } finally {
        if (canUnsubscribe) subscription.unsubscribe();
      }
    },
    [connection, isActive, showNotice]
  );

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    void uploadFiles(event.dataTransfer.files);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Cloud size={20} strokeWidth={2.5} /></div>
          <span>YDrive</span>
        </div>
        <nav className="side-nav" aria-label="主导航">
          <button className="nav-item active" type="button"><FolderOpen size={18} /> 我的文件</button>
        </nav>
        <div className="storage-card">
          <div className="storage-heading"><span>已用空间</span><span>{formatBytes(totalSize)}</span></div>
          <span className="storage-caption">共 {readyFiles.length} 个文件</span>
        </div>
        <div className="sidebar-footer"><span className={`status-dot ${isActive ? 'online' : ''}`} />{isActive ? '已连接' : '连接中...'}</div>
      </aside>

      <main
        className="main-content"
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={onDrop}
      >
        <header className="topbar">
          <div className="breadcrumb"><span>工作空间</span><span className="breadcrumb-slash">/</span><strong>我的文件</strong></div>
          <div className="topbar-actions">
            <button className="icon-button" type="button" title="列表视图" aria-label="列表视图" onClick={() => setViewMode('list')} data-active={viewMode === 'list'}><List size={18} /></button>
            <button className="icon-button" type="button" title="网格视图" aria-label="网格视图" onClick={() => setViewMode('grid')} data-active={viewMode === 'grid'}><Grid2X2 size={17} /></button>
            <div className="avatar" aria-label="访客">访</div>
          </div>
        </header>

        <div className="content-wrap">
          <section className="page-heading">
            <div>
              <p className="eyebrow">共享空间</p>
              <h1>我的文件</h1>
              <p className="page-subtitle">所有文件实时同步，打开即可使用。</p>
            </div>
            <div className="heading-actions">
              <label className={`upload-button ${isUploading ? 'loading' : ''}`}>
                <Upload size={17} />
                <span>{isUploading ? `上传中${uploadProgress ? ` ${uploadProgress.percent}%` : '...'}` : '上传文件'}</span>
                <input ref={inputRef} type="file" multiple disabled={isUploading} onChange={(event) => void uploadFiles(event.target.files ?? [])} />
              </label>
            </div>
          </section>

          {uploadProgress && (
            <section className="upload-progress-card" aria-live="polite">
              <div className="upload-progress-heading">
                <div>
                  <span className="upload-progress-kicker">
                    并发上传 {uploadProgress.activeFiles} 个 · 已完成 {uploadProgress.completedFiles}/{uploadProgress.fileCount}
                  </span>
                  <strong title={uploadProgress.activeFileNames.join('、')}>
                    {formatActiveUploadNames(uploadProgress)}
                  </strong>
                </div>
                <span className="upload-progress-percent">{uploadProgress.percent}%</span>
              </div>
              <div
                className="upload-progress-track"
                role="progressbar"
                aria-label="批量上传总进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={uploadProgress.percent}
              >
                <span style={{ width: `${uploadProgress.percent}%` }} />
              </div>
              <div className="upload-progress-meta">
                <span>
                  最近进度 {uploadProgress.latestProgressFileName} · {formatBytes(uploadProgress.latestProgressUploadedBytes)} / {formatBytes(uploadProgress.latestProgressFileSizeBytes)}
                </span>
                <span>总计 {formatBytes(uploadProgress.totalUploadedBytes)} / {formatBytes(uploadProgress.totalSizeBytes)}</span>
              </div>
            </section>
          )}

          {notice && (
            <div className={`notice ${notice.type}`} role="status">
              {notice.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}
              <span>{notice.message}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={15} /></button>
            </div>
          )}

          <div className={`drop-zone ${dragActive ? 'dragging' : ''}`}>
            <Upload size={16} /> 将文件拖到这里上传
          </div>

          <section className="file-panel">
            <div className="toolbar">
              <div className="toolbar-title"><span>全部文件</span><span className="count-pill">{readyFiles.length}</span></div>
              <label className="search-box">
                <Search size={16} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件" aria-label="搜索文件" />
              </label>
            </div>

            {!filesReady ? (
              <div className="empty-state"><div className="spinner" /><p>正在加载文件...</p></div>
            ) : sortedFiles.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><FolderOpen size={24} /></div>
                <h2>{search ? '没有匹配的文件' : '还没有文件'}</h2>
                <p>{search ? '换个关键词试试。' : '上传一个文件，开始使用你的云盘。'}</p>
              </div>
            ) : viewMode === 'list' ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>名称</th><th>大小</th><th>修改时间</th><th aria-label="操作" /></tr></thead>
                  <tbody>{sortedFiles.map((file) => <FileRow key={String(file.id)} file={file} onDownload={downloadFile} onDelete={handleDelete} />)}</tbody>
                </table>
              </div>
            ) : (
              <div className="grid-view">{sortedFiles.map((file) => <FileCard key={String(file.id)} file={file} onDownload={downloadFile} onDelete={handleDelete} />)}</div>
            )}
          </section>
          <p className="footer-note">文件存储在 SpacetimeDB 二进制数据库中 · 无需账号即可使用</p>
        </div>
      </main>
    </div>
  );
}

type FileActionProps = { file: StoredFile; onDownload: (file: StoredFile) => void | Promise<void>; onDelete: (id: bigint) => void };

function FileRow({ file, onDownload, onDelete }: FileActionProps) {
  const Icon = getFileIcon(file.mimeType);
  return (
    <tr>
      <td><button className="file-name" type="button" onClick={() => void onDownload(file)}><span className="file-icon"><Icon size={18} /></span><span className="file-label" title={file.name}>{file.name}</span></button></td>
      <td className="muted-cell">{formatBytes(file.sizeBytes)}</td>
      <td className="muted-cell">{formatDate(file.createdAt)}</td>
      <td><FileMenu file={file} onDownload={onDownload} onDelete={onDelete} /></td>
    </tr>
  );
}

function FileCard({ file, onDownload, onDelete }: FileActionProps) {
  const Icon = getFileIcon(file.mimeType);
  return (
    <article className="file-card">
      <div className="card-top"><span className="file-icon large"><Icon size={22} /></span><FileMenu file={file} onDownload={onDownload} onDelete={onDelete} /></div>
      <button className="card-name" type="button" onClick={() => void onDownload(file)} title={file.name}>{file.name}</button>
      <div className="card-meta">{formatBytes(file.sizeBytes)} <span>·</span> {formatDate(file.createdAt)}</div>
    </article>
  );
}

function FileMenu({ file, onDownload, onDelete }: FileActionProps) {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return (
    <div className="file-menu">
      <button className="icon-button subtle" type="button" title="更多操作" aria-label="更多操作" onClick={() => { setOpen((value) => !value); setConfirmingDelete(false); }}><MoreHorizontal size={18} /></button>
      {open && <div className="menu-popover">
        <button type="button" onClick={() => { void onDownload(file); setOpen(false); setConfirmingDelete(false); }}>下载</button>
        <button
          className="danger"
          type="button"
          onClick={() => {
            if (!confirmingDelete) {
              setConfirmingDelete(true);
              return;
            }
            void onDelete(file.id);
            setOpen(false);
            setConfirmingDelete(false);
          }}
        ><Trash2 size={14} /> {confirmingDelete ? '确认删除' : '删除'}</button>
      </div>}
    </div>
  );
}

export default App;
