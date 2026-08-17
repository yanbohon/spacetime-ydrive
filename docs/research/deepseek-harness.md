# DeepSeek Harness 安装与客户端形态调研

检索日期：2026-08-17

## 结论

DeepSeek Harness 是 DeepSeek 官方开源的 agent harness，目前处于 **developer preview**，版本仍可能发生破坏性变更。

它**不是只有 Web 端，也不是没有 CLI**：

- 官方 npm 包 `@deepseek-ai/dsh` 会安装 `dsh` CLI。
- `dsh web` 启动本地 Web UI；浏览器只是交互界面，Harness 服务实际运行在本机 Node.js 进程中。
- `dsh --profile headless "任务"` 是无浏览器的一次性 CLI 模式，会执行任务、把最终回复打印到 stdout，然后退出。
- 官方另有 Python SDK，通过 JSON-RPC stdio 驱动内置运行时，不需要 Web UI。
- 当前官方产品**没有内置的交互式终端 TUI**。官方在 2026-08-04 删除了原 TUI 包；当前 Web 是唯一已交付的人机交互界面。ACP、JSON-RPC、headless CLI 是 Web 之外的程序化/一次性入口。

因此要区分：

1. **CLI 启动器/一次性任务模式：有，命令是 `dsh`。**
2. **类似 Claude Code、Codex CLI 的持续交互式终端聊天界面：当前官方内置版本没有。**

## 推荐安装方式

### 方式一：不全局安装，直接运行官方推荐命令

仓库要求 Node.js `^22.19.0` 或 `>=24.0.0`。安装相应版本的 Node.js 后，在希望作为 workspace 的项目目录执行：

```sh
npx @deepseek-ai/dsh@latest web
```

默认访问地址：

```text
http://127.0.0.1:3080
```

进入 Web UI 后：

1. 打开 **设置 → 模型**；
2. 填入 DeepSeek API Key；
3. 添加并选择当前项目目录作为 workspace；
4. 新建会话并运行任务。

注意：它不是 DeepSeek 网页聊天站点。`dsh web` 在本机启动 Harness 与 Web 服务，默认只监听 loopback 地址。

### 方式二：全局安装 CLI

npm 包声明了 `dsh` 可执行文件，因此也可全局安装：

```sh
npm install -g @deepseek-ai/dsh@latest
dsh --version
dsh web
```

官方根 README 当前主要展示 `npx` 方式；全局安装只是 npm CLI 包的标准使用方式。处于 developer preview 阶段时，使用 `@latest` 可能带来不兼容升级，生产环境应固定具体版本，例如：

```sh
npm install -g @deepseek-ai/dsh@0.1.0-rc.6
```

## 不使用 Web 的方式

### 一次性 headless CLI

设置模型凭据后直接提交一个任务：

```sh
export DEEPSEEK_API_KEY='sk-...'
npx @deepseek-ai/dsh@latest --profile headless \
  "Inspect this repository and explain its architecture."
```

也可以在全局安装后运行：

```sh
dsh --profile headless "run the tests and fix the failure"
```

该模式会创建一个新的持久化会话，等待 agent 停稳，把最后的 assistant 文本输出到 stdout，并退出。它不启动 Host、HTTP 服务或浏览器客户端。

这是真正的 CLI，但交互模型是“一条任务 → 最终输出 → 退出”，不是持续聊天式 TUI。

### Python SDK

官方 PyPI 包：

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness-sdk
```

最小调用：

```python
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness() as harness:
    result = harness.run("Inspect the repository and fix the failing tests.")

print(result.final_response)
```

SDK 要求 Python 3.10+。PyPI 包会安装同版本的内置 runtime wheel，正常入口不要求系统安装 Node.js。官方当前列出的平台是 Linux x64、Linux arm64 和 macOS 14+ arm64；该 SDK 快速上手未列 Windows。

### ACP / JSON-RPC

源码还包含：

- 面向父 agent、subagent provider 和其他程序化客户端的 ACP stdio server；
- Python SDK 使用的 JSON-RPC stdio runtime。

这些是集成协议/开发入口，不是现成的终端聊天 UI。若目标是把 Harness 接进 IDE、上层 agent 或自动化服务，应优先评估 Python SDK、ACP 或 JSON-RPC，而不是绕过 Web API 抓内部 HTTP 接口。

## 当前没有什么

### 没有官方内置 TUI

官方 2026-08-04 的实现记录明确说明：

- 删除 `@deepseek-ai/dsh-tui`；
- 不提供兼容包或别名；
- Web 仍是已交付的交互界面；
- ACP、JSON-RPC 和一次性 CLI 保留。

CLI 帮助中的 `--profile tui` 示例指向“自定义 profile / 外部插件”的扩展机制，不代表 npm 包当前自带官方 TUI。不能把它理解为运行 `dsh tui` 就能得到官方终端客户端。

### 没有稳定版承诺

当前 npm 版本为 release candidate，官方 README 标记为 developer preview，并明确提示会有 breaking changes。不建议现阶段将未固定版本的 `@latest` 直接用于不可回滚的生产环境。

## 选择建议

| 需求 | 推荐入口 |
|---|---|
| 本地人工使用、需要审批和会话管理 | `dsh web` |
| Shell/CI 中执行一条任务并拿最终文本 | `dsh --profile headless "..."` |
| Python 程序内多次调用和复用 runtime | `deepseek-harness-sdk` |
| 接入 IDE、父 agent 或其他协议客户端 | ACP / JSON-RPC |
| 类 Claude Code 的持续终端交互 | 当前官方内置版本不提供；需要第三方/自定义 profile，且应单独评估可信度 |

## 一手来源

1. DeepSeek 官方仓库与安装说明：<https://github.com/deepseek-ai/deepseek-harness>
2. 官方中文 README：<https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md>
3. 官方 CLI 中文说明（`web`、`headless`、profile、plugin）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.zh.md>
4. 官方 CLI 包清单（npm 包名与 `dsh` bin）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/package.json>
5. npm 官方 registry 页面：<https://www.npmjs.com/package/@deepseek-ai/dsh>
6. 官方 Web UI 指南：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.zh.md>
7. 官方 Python SDK 快速上手：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.zh.md>
8. PyPI 官方项目页：<https://pypi.org/project/deepseek-harness-sdk/>
9. 官方 TUI 移除记录：<https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-08-04-remove-tui-package.zh.md>
10. 官方 ACP 示例说明：<https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/acp-agent/README.zh.md>
