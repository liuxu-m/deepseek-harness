# Agent Note: Provider 路由的按 profile `User-Agent` 覆盖

Status: implemented

[English](2026-08-18-per-profile-user-agent-override.md) | 中文

## 问题

强制归因决策（2026-06-21）让每个 provider 请求携带默认应用身份 `deepseek-harness/<版本> (+https://github.com/deepseek-ai/deepseek-harness)`，且 `llm-pi-ai` 的 `requestHeaders()` 会剥离部署放在 profile `headers` 里的任何 `user-agent`。这对公共 provider 是正确的。但某些内部网关会在**查看请求体之前**于 HTTP 层强制校验特定客户端指纹：不是官方客户端的一律拒绝。

2026-08-18 对内部 Codex 兼容网关（`icode.51talk.biz`）实测验证：携带 harness `user-agent` 的请求被 401/403 拒绝（"API key is invalid"/"检测到异常客户端"）。仅把 wire 上的 `user-agent` 改为 `codex_cli_rs/<版本> (…; arch)` 并加上 `originator: codex_cli_rs`、`OpenAI-Beta: responses=experimental` 后，完全相同的 pi-ai 请求即可通过。请求体差异（pi-ai 的 `prompt_cache_key`、`store`、工具调用结构、reasoning 字段）不会触发拒绝。因此该拦截纯属 HTTP 客户端身份检查，而目前 harness 发出的任一标头都不可按路由配置。

该义务是特定部署的、按需启用的。产品身份强制要求应继续适用于所有其他路由。

## 决策

给 `llm-pi-ai` provider 路由新增一个字段：`userAgentOverride?: string`。

- 设置后，该路由出站的 `user-agent` 即为该确切值，而非默认归因头。其余标头仍经现有 `headers` 字段配置，因此部署可在 `headers` 里提供客户端指纹的其余部分（`originator`、`openai-beta`）。
- 未设置时行为与之前逐字节一致：强制的 `deepseek-harness/<版本> (+url)` 归因覆盖任何 profile `headers.user-agent`。
- 为空或含换行的值在 `resolveProfiles` 被拒绝（header 注入守卫）。
- 模型发现（`GET /models`）保持默认归因：它不是模型请求，无需客户端指纹。

这是归因 Agent Note 已预留的白标钩子（`attributionHeaders(identity)`），现按 provider 铺开。它不会在全局抑制归因，也不会削弱其他 provider。

## 验证

- `config.spec.ts` 断言单行覆盖可解析、空/含换行的值抛错。
- `adapter.spec.ts` 断言 wire 上的 `user-agent` 等于覆盖值，且兄弟标头（`originator`、`openai-beta`）到达 wire；既有 "Harness attribution wins" 测试不变仍通过（无覆盖 → 默认 UA）。
- icode 场景 wire 摘要（stage 1 = 覆盖 + originator + OpenAI-Beta）：整轮对话 `POST /v1/responses -> 200`，而相同请求此前为 403。

## 备选方案

**直接让 `headers.user-agent` 生效。** 拒绝：标头名冲突规则反转会让所有恰好携带 `user-agent` 的路由静默改变，且归因强制要求将该名字声明为保留名。专用字段让覆盖成为显式路由决策。

**全局 `APP_IDENTITY` 覆盖（环境变量或设置）。** 拒绝：会改变所有 provider 的身份，而不仅是需要的网关。

**把外部改写 proxy 做成 Harness 插件。** 本次拒绝：harness 没有出站请求拦截 seam；proxy 是进程外方案，而配置字段在客户端可见可改、无需额外进程。

## 后果

提供方会看到选择启用替代客户端身份的部署的流量——这正是目的；默认仍是诚实的产品归因。合并保持确定性：设置覆盖后，profile 不再与覆盖拥有的唯一 `user-agent` 冲突（保留名过滤仍会丢弃重复项）。迁移到新检出只需改配置 + 使用已发布包。