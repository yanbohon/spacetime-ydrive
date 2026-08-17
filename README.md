# YDrive

一个无需注册或登录、打开即可使用的共享云盘 MVP。前端使用 Vite + React + TypeScript，后端直接运行在 SpacetimeDB 中，文件内容以数据库 `byteArray` 二进制列存储。

## 已实现

- 多文件选择和拖拽上传；不超过 4MiB 的文件一次写入二进制并轻量确认，大文件按 4MiB 分块、全局 2 块并发（最多 8MiB 在途）
- 显示当前文件、批次、百分比与已确认字节数；连接异常时自动超时退出
- 实时文件列表、搜索、列表/网格视图
- 分块内容按序组装为浏览器原生下载，并兼容旧版整块文件
- 文件删除
- 元数据实时同步，文件二进制内容仅在下载时按需读取
- 响应式桌面和移动端界面
- 无账号认证；所有访问者共享同一个公开空间

## 运行前端

需要 Node.js 22+ 和 npm。应用默认连接 Maincloud 上的 `ydrive-axerq`，无需启动本地数据库。

```bash
npm install
npm run dev
```

浏览器打开 <http://localhost:5173> 即可。

## 修改后端

后端开发需要 [SpacetimeDB CLI](https://spacetimedb.com/install) 2.8，并登录有权管理 `ydrive-axerq` 的账号：

```bash
spacetime login
npm run publish:db:maincloud  # 构建并发布一次
npm run dev:db:maincloud      # 生成绑定、发布并监听服务端变更
```

这两个命令会直接更新 Maincloud 上的模块；普通前端开发使用 `npm run dev`，不会触发线上发布。

## 常用命令

```bash
npm run generate   # 从服务端 schema 重新生成 TypeScript 客户端绑定
npm test           # 运行上传分块与超时回归测试
npm run typecheck  # 检查前后端 TypeScript
npm run build      # 构建 SpacetimeDB 模块和生产前端
npm run publish:db:maincloud # 发布到 Maincloud 的 ydrive-axerq
npm run benchmark:upload -- 1x3 2x2 4x1 4x2 # 对 Maincloud 运行 64MiB 上传基准并自动清理
```

基准脚本也支持在最后追加 `--verify`，上传后会重新下载并校验 SHA-256。可以通过
`YDRIVE_BENCHMARK_SIZE_BYTES` 调整测试文件大小。

默认连接地址在 `client/src/config.ts`。部署到其他环境时可复制 `client/.env.example` 为 `client/.env`，修改：

```dotenv
VITE_SPACETIMEDB_URI=wss://maincloud.spacetimedb.com
VITE_SPACETIMEDB_MODULE=ydrive-axerq
```

## 项目结构

```text
.
├── client/                  # Vite React 客户端
│   └── src/module_bindings/ # SpacetimeDB 自动生成绑定
├── server/                  # SpacetimeDB TypeScript 模块
│   └── src/index.ts         # 文件表和上传/删除 reducers
├── spacetime.json           # SpacetimeDB 项目配置
└── package.json             # workspace 与开发命令
```

## MVP 边界

这个版本没有鉴权和文件所有权隔离，任何连接者都能查看、下载和删除全部文件。元数据会实时同步，二进制内容在下载时按文件 ID 读取；如果后续面向生产，应增加认证/权限、配额归属、断点续传、恶意文件扫描，以及对象存储策略。
