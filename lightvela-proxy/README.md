# 桌面登录与 OpenAI 兼容代理

独立运行，不依赖 DSH 插件。完整入口与演示见 [仓库说明](../README.md)。

## 下载

从 [Releases](https://github.com/CallMeChou/lightvela-bridge/releases/latest) 下载 Windows x64 ZIP，完整解压后运行 `LightVela-Bridge.exe`。请保留所有同目录文件。需要安装 Node.js 24+（加入 PATH）和 Edge WebView2 Runtime；详情见 [Windows 使用说明](./WINDOWS-README.md)。单独 EXE 附件只能替换已有完整目录中的程序。

## 构建

Windows、Node.js 24+、Windows PowerShell 5.1、Edge WebView2 Runtime：

```powershell
.\Restore-WebView2.ps1
.\Build-Desktop.ps1
.\LightVela-CCSwitch.cmd
```

源码仓库不携带编译产物及 SDK 二进制。恢复脚本从官方 NuGet 下载 WebView2 1.0.4314.35，校验 SHA256 后提取所需文件；同目录保留微软 LICENSE 和 NOTICE。

构建完成后运行 `powershell.exe -NoProfile -File .\Package-Windows.ps1` 可生成 Release ZIP、EXE 和 SHA256 校验文件。打包脚本只复制明确列出的运行文件，不包含本机登录或浏览器数据。

## 使用

登录 → 自动保存 Token → 检查账号实例 → 启动反代。账号选错时点「退出并重新登录」，重新选择账号；端口不变，取消后保持退出。

默认 URL 为 `http://127.0.0.1:8790/v1`，模型 `auto`，客户端 API Key 填 `local-lightvela`。该值只是占位值，不验证来访者身份。保持工具运行；关闭它会停止本窗口启动的代理。

CC Switch 导入：先完全退出 CC Switch（含托盘）。程序会先检查登录、启动代理，再备份数据库、写入供应商并切换当前 Codex 供应商；数据库被占用或操作失败时不切换供应商。备份含私人数据，不要上传。

## 命令行

先由自己的秘密管理方式设置 `LV_SESSION_TOKEN`，再运行 `node server.mjs` 或 `start.ps1`。不要把真实值写进脚本、Shell 历史或 Git。桌面自动登录通常更方便。

| 变量 | 默认 | 用途 |
|---|---|---|
| `LV_SESSION_TOKEN` | 必填 | 自己账号的会话 Token |
| `PORT` | `8790` | 本地端口 |
| `LV_INSTANCE_ID` | 自动 | 运行中实例；留空自动选择 |
| `LV_MODEL_ID` | `auto` | 对外模型名 |
| `LV_RUN_AS` | `agentuser` | 实例执行用户 |
| `LV_TIMEOUT_MS` | `180000` | 请求超时 |
| `LV_HERMES_BIN` | `hermes` | 实例内 CLI |
| `LV_HERMES_ARGS` | 空 | 实例 CLI 附加参数 |
| `LV_DEBUG` | 关闭 | 可选调试日志，可能含私人信息 |

`codex-lightvela.ps1` 只为本次 CLI 进程传入自定义 provider 配置，不要求已有个人 `lightvela` profile。先启动反代，再运行此脚本；它不启动或停止现有代理。

## 接口与限制

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/bridge/status` | 本地进程身份与模型 |
| GET | `/healthz` | 账号检查；可能返回私人账号信息 |
| GET | `/v1/models` | 模型目录 |
| POST | `/v1/chat/completions` | 文本普通 / SSE 回复 |
| POST | `/v1/responses` | 文本普通 / SSE 回复 |
| GET | `/admin/instances` | 私人实例列表 |
| POST | `/admin/exec` | 实例命令执行，仅限本机信任环境 |

当前代理只适配文本请求。SSE 在完整上游回复后分段输出；工具调用、图片、多模态及 Responses 会话状态尚未完整支持，Token 用量为估算。

遇到“账号下没有可用实例”时，先确认登录的是正确账号，再确认该账号确有运行中实例；模型目录响应成功不能证明实例可调用。

## 检查

```powershell
node --test tests/*.test.mjs
powershell.exe -NoProfile -STA -File tests\desktop-logout.ps1
```

自动测试使用本地模拟上游和虚构凭证。`verify.mjs` / `test-live.mjs` / `smoke.mjs` 为手动真实检查，必须显式设置 `LV_ALLOW_LIVE_TESTS=1` 才执行；可能访问真实账号或消耗积分。

详见 [隐私说明](../PRIVACY.md)。
