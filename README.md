# YDrive 快传

一个无需注册或登录的匿名文件快传。发送方上传文件后得到一次快传取件码，接收方只需输入取件码即可查看和下载；文件不会出现在公共文件列表中。

## 现在的快传模型

- **发送**：选择一个或多个文件，上传完成后生成 16 位高熵取件码和快传链接。
- **接收**：输入取件码，或直接打开带 `#code=...` 的快传链接查看文件清单；每个文件可复制受控下载直链。
- **有效期**：默认 24 小时，可选 3 天、7 天或永久有效；有限期快传过期后，取件码、文件元数据和二进制内容一起失效。
- **下载与预览**：下载地址同时携带文件 ID 和取件码；图片、音频、视频支持内联预览，下载仍支持 HTTP Range、分段下载和断点续传。
- **匿名**：SpacetimeDB 自动为浏览器建立匿名身份；身份只用于发送方在当前浏览器内继续、取消或删除自己的快传，不是登录账号。
- **数据隔离**：所有数据表均为私有表；客户端没有全库文件订阅。文件只通过受控领取过程和带取件码的 HTTP 下载端点暴露。
- **级联清理**：取消、删除或访问已过期快传时，服务端级联删除文件、分块、二进制内容和上传会话，避免孤儿数据。

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

这次 schema 改造将原来的公共文件空间切换为私有快传聚合。旧的 `stored_file` 公共订阅和仅凭递增文件 ID 下载的客户端都不再兼容。发布到已有数据库前，必须先确认数据库迁移策略；推荐先发布到新的数据库名并更新 `VITE_SPACETIMEDB_MODULE`，不要在未备份的线上库上直接强制破坏性发布。

当前 `npm run publish:db:maincloud` 已显式配置 `--delete-data=always`，会删除 `ydrive-axerq` 中全部现有数据后发布新 schema。

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
│       ├── App.tsx          # 发送/接收两个内聚快传页面
│       ├── upload.ts        # 共享的分块上传与超时编排
│       └── module_bindings/ # 自动生成的 reducer/procedure 绑定
├── server/
│   └── src/
│       ├── index.ts         # transfer 聚合、上传、封存、级联删除和下载路由
│       └── download.ts      # 取件码、Range 和 Content-Disposition 纯函数
├── spacetime.json
└── package.json
```

## 服务端边界

`transfer` 是快传聚合根，保存所有者、取件码、封存状态和过期时间。文件必须归属于 transfer；上传 reducer 会校验发送者、快传状态和有效期，`sealTransfer` 只允许至少一个文件完成后开放领取。`receiveTransfer` 根据取件码返回已封存文件清单，下载 HTTP handler 还会再次校验文件归属和过期状态。

当前版本仍直接在 SpacetimeDB 二进制列中保存内容。超大文件和高并发下载会产生数据库内存压力；生产规模扩展前应迁移到对象存储/CDN，并补充限流、恶意文件扫描和后台过期清理任务。当前实现会在创建快传、领取和下载路径惰性清理已过期数据。
