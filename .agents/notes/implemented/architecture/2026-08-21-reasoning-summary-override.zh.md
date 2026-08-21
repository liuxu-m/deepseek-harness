# Agent Note: Provider 路由的 `reasoning.summary` 覆盖

Status: implemented

[English](2026-08-21-reasoning-summary-override.md) | 中文

## 问题

`llm-pi-ai` 的 OpenAI Responses 通道默认把 `reasoning.summary` 置为 `"auto"`（pi-ai `buildParams`），且 harness 无配置通道改它。某些 Codex 兼容网关（2026-08-21 实测 icode.51talk.biz 上游）**只接受 `"detailed"`**，收到 `"auto"` 时返回 `400 {"message":"Upstream request failed","type":"upstream_error"}`。

**实测差异**（经本地 rewrite 代理对比 codex 与 harness wire，其余 header/body 均一致）：

| 来源 | `reasoning.summary` | 结果 |
|---|---|---|
| 官方 Codex Desktop | `"detailed"` | 200 命中 |
| DeepSeek Harness | `"auto"` | 400 upstream_error |

注意：这不是旧 `userAgentOverride` 场景（HTTP 指纹层），而是**请求体参数**被上游拒绝，HTTP 指纹伪装（UA/originator/OpenAI-Beta）无法覆盖它。

## 关键机制

不能直接在 adapter 传 `reasoningSummary` 给 `streamSimple`：pi-ai 的 `buildBaseOptions`（`dist/api/simple-options.js`）只转发固定字段列表并**丢弃 `reasoningSummary`**（该字段虽在 `OpenAIResponsesOptions` 类型上，但 `SimpleStreamOptions` 没有，且运行时到不了 `buildParams`）。正确注入点是 **`onPayload` 回调**：它在 `openai-responses.js stream()` 于 `buildParams`（置 `summary:"auto"`）之后被调用，可改写最终 `params.reasoning.summary`。

## 决策

给 `llm-pi-ai` provider 新增可选字段 `reasoningSummary?: 'auto' | 'detailed' | 'concise' | null`。**显式配置才生效**：仅当 provider 设置了该字段，才安装 `onPayload` 改写发出的 `reasoning.summary`；未配置时行为与现状逐字节一致（不注入 `onPayload`，保持默认 `"auto"`）。icode 的 provider 在 settings.yaml 里加 `reasoningSummary: detailed` 即可与 Codex 对齐。

## 验证

- `config.spec.ts` 断言合法值（auto/detailed/concise/null）可解析、非法值抛错（schemastery `z.const` 枚举）。
- `sdk-options.spec.ts` mock `openai-responses.lazy`，断言设置时第三参携带 `onPayload` 且能把 `summary:'auto'` 改写为 `'detailed'`；未设置时无 `onPayload`。
- 全包 220 测试通过，包级 typecheck 通过。
- icode 现场：直连跑 gpt 会话收敛为 200 + `cacheReadTokens` 命中。

## 备选方案

**全局默认把 `reasoning.summary` 改成 `detailed`。** 拒绝：会改变所有 openai-responses 路由的请求体重载（不一定都接受 detailed），默认保持 harness 现状最安全，只对需要的网关显式启用。

**直接放开 `headers` / `compat` 让用户自己注入 `reasoning`。** 拒绝：`onPayload` 是本场景最小、类型安全的 seam，无需暴露 pi-ai 内部 params 结构。

## 后果

选择启用该路由的部署会向上游呈现 `summary:"detailed"`——这正是目的；默认仍是 pi-ai 的 `"auto"`。字段在客户端 provider 配置即可编辑，无需改源码之外的进程。
