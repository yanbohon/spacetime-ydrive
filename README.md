# YDrive 快传

一个无需注册或登录的匿名文件快传。发送方上传文件后得到一次快传取件码，接收方只需输入取件码即可查看和下载；文件不会出现在公共文件列表中。

## 现在的快传模型

- **发送**：选择一个或多个文件，上传完成后生成 16 位高熵取件码和快传链接；上传支持自动重试、暂停、刷新后重选原文件继续。
- **接收**：输入取件码，或直接打开带 `#code=...` 的快传链接查看文件清单；可逐个下载，也可多选后生成单个 ZIP。
- **管理**：匿名身份保存在当前浏览器；“发送历史”可重新复制链接、修改有效期或删除自己创建的快传。
- **有效期**：默认 24 小时，可选 3 天、7 天或永久有效；有限期快传过期后，取件码、文件元数据和二进制内容一起失效。
- **下载与预览**：下载地址同时携带文件 ID 和取件码；图片、音频、视频支持内联预览，下载仍支持 HTTP Range、分段下载和断点续传。
- **匿名**：SpacetimeDB 自动为浏览器建立匿名身份；身份只用于发送方继续、取消、管理自己的快传，不是登录账号。
- **数据隔离**：所有数据表均为私有表；客户端没有全库文件订阅。文件只通过受控领取过程和带取件码的 HTTP 下载端点暴露。
- **级联清理**：取消、删除或访问已过期快传时，服务端级联删除文件、分块、二进制内容和上传会话；未封存上传使用独立的 24 小时租约。

## 运行前端

需要 Node.js 22+ 和 npm。默认配置连接 Maincloud 上的 `ydrive-axerq`；发布新版服务端前，请先把前端环境变量切到包含快传 schema 的数据库。

```bash
npm install
npm run dev
```

浏览器打开 <http://localhost:5173>。

可复制 `client/.env.example` 为 `client/.env`，配置其他数据库：

```dotenv
VITE_SPACETIMEDB_URI=wss://maincloud.spacetimedb.com
VITE_SPACETIMEDB_HTTP_URI=https://maincloud.spacetimedb.com
VITE_SPACETIMEDB_MODULE=ydrive-axerq
```

## 部署到 Vercel

导入 GitHub 仓库后，将项目的 **Root Directory** 设置为 `client`。仓库中的 `client/vercel.json` 会使用 `npm run build` 构建，并从 `client/dist` 发布静态文件。不要在 Vercel 中使用根工作区命令 `npm --workspace client run build`。

在 Vercel 的 Production、Preview 和 Development 环境中配置上述三个 `VITE_*` 变量，然后重新部署。

## 修改和发布后端

后端开发需要 [SpacetimeDB CLI](https://spacetimedb.com/install) 2.8：

```bash
spacetime login
npm run generate
npm run build
npm run publish:db:maincloud
```

当前 schema 通过新增私有 `upload_lease` 表和 owner 索引扩展已有快传，不给 `transfer` 增加必填列。发布脚本固定使用 `--delete-data=never`，迁移不得删除现有数据。发布前仍应备份并检查 CLI 输出的 migration plan；预期只包含新增 `upload_lease` 表和 `transfer.owner_identity` 索引。

本地端到端验证：

```bash
spacetime start --in-memory --listen-addr 127.0.0.1:3100
spacetime publish ydrive-quick-local --server http://127.0.0.1:3100 --module-path server --anonymous --yes
```

## 常用命令

```bash
npm run generate                 # 从服务端 schema 重新生成客户端绑定
npm test                         # 上传分块、取件码解析与下载回归测试
npm run typecheck                # 检查服务端和客户端 TypeScript
npm run build                    # 构建服务端模块和生产前端
npm run publish:db:maincloud     # 发布到 Maincloud 的数据库
npm run benchmark:upload -- 1x3 2x2 4x1 4x2
```

基准脚本先创建快传、上传并封存，再使用取件码验证下载，结束后删除整个快传。追加 `--verify` 会重新下载并校验 SHA-256；可用 `YDRIVE_BENCHMARK_SIZE_BYTES` 调整文件大小。

## 项目结构

```text
.
├── client/                  # Vite React 客户端
│   └── src/
│       ├── App.tsx                # 发送、接收、批量下载和发送历史界面
│       ├── upload.ts              # 分块传输、瞬时错误重试和并发控制
│       ├── useUploadTransfer.ts   # 上传事务、副作用和恢复持久化控制器
│       ├── uploadTransferState.ts # 可测试的判别联合上传状态机
│       └── module_bindings/       # 自动生成的 reducer/procedure 绑定
├── server/
│   └── src/
│       ├── index.ts         # transfer 聚合、上传租约、管理过程和下载路由
│       ├── archive.ts       # 无压缩 ZIP32 归档生成
│       └── download.ts      # 取件码、Range 和 Content-Disposition 纯函数
├── spacetime.json
└── package.json
```

## 服务端边界

`transfer` 是快传聚合根，保存所有者、取件码、封存状态和过期时间。文件必须归属于 transfer；上传 reducer 会校验发送者、快传状态和上传租约，`sealTransfer` 只允许至少一个文件完成后开放领取。`receiveTransfer` 根据取件码返回已封存文件清单，下载 HTTP handler 还会再次校验文件归属和过期状态。

二进制内容只保存在 SpacetimeDB 私有表中。单文件下载支持 HTTP Range；批量下载使用内存内无压缩 ZIP32，因此归档总大小上限低于 4 GiB，超限会返回 413，客户端仍可逐个下载。过期快传在创建、领取、管理和下载路径惰性清理；未封存快传只有存在 `upload_lease` 时才按租约清理，以兼容升级前的历史数据。
