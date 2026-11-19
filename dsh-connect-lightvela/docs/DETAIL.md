# DSH 插件实现

- `index.js`：provider adapter、模型发现、设置状态路由、工具与对话消息映射。
- `client.js`：DSH 设置页面板，调用同源 `/api/dsh-connect-lightvela/status`。
- `lv-api.js`：LightVela 控制面、实例命令执行、模型网关和 Hermes 调用。
- `cordis.patch.yml`：bundle 注册，不修改默认模型。
- `locale/`、`icon.svg`：宿主展示资料。

网关通道转发原生 messages / tools 并解析 tool-call 增量。Agent 通道将上下文压平交给 Hermes，返回文本；两者能力不同。控制面使用用户会话 Token，网关通道还会从用户有权限的实例读取它自己的网关凭证。模型目录由上游动态决定。

状态文件和 DSH profile 属于本地私人数据。HTTP 状态与设置路由依赖宿主的访问控制；请勿把宿主设置接口直接暴露到公网。更多用法和限制以本目录 README 为准。
