# DSH LightVela 连接插件

在 DSH 的模型列表中注册 `lightvela` provider，并增加 LightVela 设置页。独立运行，**无需启动桌面反代**。本仓库不包含 DSH 主程序或任何个人 profile。

## 功能

- 设置页输入会话 Token，校验成功后保存；可退出登录、查看账号 / 实例状态、切换通道。
- `gateway`（默认）：通过自己实例取得网关凭证，请求模型网关；支持 DSH 工具定义转发和工具调用结果映射，具体取决于上游模型。
- `agent`：通过实例内的 Hermes CLI 执行提示词，返回文本。实例自身的工具执行不等同于 DSH 的原生工具调用协议。
- 网关模型列表动态发现，不保证某个具体型号一直可用，也不承诺固定延迟。

## 安装

需要已有可用的 DSH，以及宿主提供的 peer dependencies：`@deepseek-ai/dsh-llm >=0.1.7`、`@deepseek-ai/schemastery >=3.18.1`。

优先使用你的 DSH 版本提供的本地 bundle 安装入口，选择本目录。包的 bundle 补丁入口是 `cordis.patch.yml`，界面入口是 `client.js`。此包设置为 `private: true`，不会自动发布到 npm。

如果宿主仅支持 profile 开发安装，可在自己的 profile 中添加本目录的本地 link 依赖，并在 `dsh.profile.bundles` 中添加包名，然后按该 DSH 版本的流程安装依赖并重启 profile。例如（用自己的克隆路径替换示例路径）：

```json
{
  "dependencies": {
    "dsh-connect-lightvela": "link:C:/projects/lightvela-bridge/dsh-connect-lightvela"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-connect-lightvela"]
    }
  }
}
```

这是需要合并的示例片段，不要覆盖整个 profile 或删除原有依赖。不要提交含真实 Token 的 profile。具体安装入口因 DSH 版本而异，本次公开整理未在另一台机器重新验证安装流程。

## 登录与配置

在 DSH 设置中打开 LightVela 面板，使用自己账号的会话 Token 登录。桌面工具的自动获取功能目前只服务桌面反代，不会同步到 DSH。

如需从官方网页取得会话 Token，请只在自己已登录的官方页面本机处理。凭证可位于 localStorage 的 `vela.lightvela.session-token.v1` 或 `lightclaw-auth-token-v1`；不要把它粘贴进聊天消息、Issue 或 GitHub。

```yaml
- id: dsh-connect-lightvela
  name: dsh-connect-lightvela
  config:
    sessionToken: ""
    region: cn
    instanceId: ""
    mode: gateway
    timeoutMs: 180000
```

| 字段 | 默认 | 用途 |
|---|---|---|
| `sessionToken` | 空 | 推荐在设置面板填入，不写入公开文件 |
| `region` | `cn` | `cn` / `intl` |
| `instanceId` | 空 | 自动选择运行中的实例 |
| `mode` | `gateway` | `gateway` / `agent` |
| `modelIds` | `[]` | 留空动态发现；填入后覆盖列表 |
| `gatewayBaseUrl` | 空 | 从自己的实例读取；可选覆盖 |
| `timeoutMs` | `180000` | 请求超时 |
| `runAsUser` | `agentuser` | 实例命令执行用户 |

账号必须有可用实例。“登录有效”不代表“实例可以运行”。网关模式需要实例提供相应网关配置；实例重建后可能需要重新发现。

## 凭证保存与手动检查

插件在用户目录 `.dsh/dsh-connect-lightvela/state.json` 保存状态，**Token 目前是本机明文存储**。请保护文件权限，不要上传。请勿通过聊天工具参数传递 Token，以免进入对话历史。

`runtime-shape-test.mjs` 和 `verify-*.mjs` 是手动检查脚本，必须设置 `LV_ALLOW_LIVE_TESTS=1`、`LV_SESSION_TOKEN`；可用 `LV_INSTANCE_ID` 指定自己的实例。部分脚本会真实请求模型并消耗积分，不属于默认自动测试。本次发布没有运行这些真实请求。

实现细节见 [DETAIL](./docs/DETAIL.md)，公共发布的隐私边界见 [PRIVACY](../PRIVACY.md)。
