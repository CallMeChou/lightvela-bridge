# Windows 桌面版使用说明

下载 `LightVela-Bridge-v1.0.0-windows-x64.zip`，**完整解压**后双击 `LightVela-Bridge.exe`。不要在压缩包中直接运行，也不要只复制 EXE：程序需要同目录的脚本和 `vendor/webview2` 文件。

运行环境：Windows x64、Node.js 24 或更新版本（安装时加入 PATH）、Microsoft Edge WebView2 Runtime。此包不包含 Node.js 或 WebView2 Runtime 安装程序。

官方下载：[Node.js](https://nodejs.org/en/download)、[WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)。

1. 点「登录并获取 Token」，在官方网页登录自己的 LightVela 账号。
2. 登录错账号时，点「退出并重新登录」。账号需要有运行中的实例。
3. 点「启动 / 更新反代」，保持窗口运行。
4. 客户端 Base URL 填 `http://127.0.0.1:8790/v1`，API Key 填占位值 `local-lightvela`，模型填 `auto`。修改端口后同步修改客户端地址。
5. 如使用「一键导入 CC Switch」，先完全退出 CC Switch（含托盘）。导入会先备份本机数据库，然后切换当前 Codex 供应商。

桌面工具独立运行，不需要安装 DSH 插件。DSH 插件源码单独放在仓库的 `dsh-connect-lightvela` 目录。

Token 在本机由 Windows 当前用户加密保存；此包不包含任何账号或预置登录状态。不要上传使用后产生的设置、浏览器数据或数据库备份。详见随包 `PRIVACY.md`。

当前支持文本回复；完整 Codex 工具调用、图片输入和 Responses 会话状态尚未实现。SSE 在收到完整上游回复后分段发送，usage 为估算。实际请求可能消耗账号积分。代理仅供本机可信环境使用，管理接口没有额外身份验证。

项目与第三方服务官方无关联，尚未指定项目许可证；随包 WebView2 文件适用 `vendor/webview2/LICENSE.txt` 和 `NOTICE.txt`。

源码、完整说明与问题反馈：https://github.com/CallMeChou/lightvela-bridge
