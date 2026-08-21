# Agent Note: Provider 路由的 `reasoning.summary` / `context` 对齐

Status: implemented

[English](2026-08-21-reasoning-summary-override.md) | 中文

## 问题

`llm-pi-ai` 的 OpenAI Responses 通道把 `reasoning.summary` 置为 `"auto"`（pi-ai `buildParams`）**且省略 `reasoning.context`**，harness 无配置通道改两者。某 Codex 兼容网关/上游（2026-08-21 实测 icode.51talk.biz 上游）**同时要求 `summary:"detailed"` 和 `context:"all_turns"`**，否则返回 `400 {"message":"Upstream request failed","type":"upstream_error"}`。

**实测差异**（rewrite 代理抓完整 body——决定性证据）：

| 来源 | `reasoning` 对象 | 结果 |
|---|---|---|
| 官方 Codex Desktop | `{ context: "all_turns", effort: "high", summary: "detailed" }` | 200 命中 |
| Harness（改前，`summary:"auto"`） | `{ effort: "high", summary: "auto" }`（无 `context`） | 400 upstream_error |
| Harness（只改 `summary:"detailed"`） | `{ effort: "high", summary: "detailed" }`（仍无 `context`） | **400**——证实 `context` 才是硬性要求 |

所以 `summary` 单独是干扰项；上游强制的其实是缺失的 `reasoning.context: "all_turns"`。这不是旧 `userAgentOverride` 场景（HTTP 指纹层），而是**请求体参数**被上游拒绝，指纹伪装（UA/originator/OpenAI-Beta）无法覆盖。

## 关键机制

不能直接在 adapter 传 `reasoningSummary` 给 `streamSimple`：pi-ai 的 `buildBaseOptions`（`dist/api/simple-options.js`）只转发固定字段列表并**丢弃 `reasoningSummary`**（该字段在 `OpenAIResponsesOptions` 类型上，但 `SimpleStreamOptions` 没有，运行时到不了 `buildParams`）。正确注入点是 **`onPayload` 回调**：它在 `openai-responses.js stream()` 于 `buildParams`（置 `summary:"auto"` 且无 `context`）之后被调用，返回值作为最终 `params`。

## 决策

给 `llm-pi-ai` provider 新增可选字段 `reasoningSummary?: 'auto' | 'detailed' | 'concise' | null`。**显式配置才生效**：仅当 provider 设置了该字段，才安装 `onPayload` 把 `reasoning.summary` 改写为配置值**并补上 `reasoning.context: "all_turns"`**；未配置时行为与现状逐字节一致（不注入 `onPayload`，pi-ai 默认）。icode 的 provider 在 settings.yaml 里加 `reasoningSummary: detailed`，从而把 `summary` 与 `context` 同时对齐到 Codex。

## 验证

- `config.spec.ts` 断言合法值（auto/detailed/concise/null）可解析、非法值抛错（schemastery `z.const` 枚举）。
- `sdk-options.spec.ts` mock `openai-responses.lazy`，断言设置时第三参携带 `onPayload`，且它能改写 `summary:'auto'` → `'detailed'` **并置 `context:'all_turns'`**；未设置时无 `onPayload`。
- 全包测试通过，包级 typecheck 通过。
- icode 现场：部署后直连 gpt 会话须收敛为 200（不再 `upstream_error`）+ `cacheReadTokens` 命中。

## 备选方案

**全局默认把 `reasoning.summary` 改成 `detailed`（并补 context）。** 拒绝：会改变所有 openai-responses 路由的请求体形态（不一定都接受），默认保持 harness 现状最安全，只对需要的网关显式启用。

**直接放开 `headers` / `compat` 让用户自己注入 `reasoning`。** 拒绝：`onPayload` 是本场景最小、类型安全的 seam，无需暴露 pi-ai 内部 params 结构。

## 后果

选择启用该路由的部署会向上游呈现 `reasoning { context:"all_turns", summary:"detailed" }`——这正是目的；默认仍是 pi-ai 的 `{"effort"}`/`"auto"` 形态。字段在客户端 provider 配置即可编辑，无需改源码之外的进程。

## 附注（2026-08-21）：真正被拒的字段是 `max_output_tokens`

在把 `reasoning {context, summary}` 对齐且网关**仍**返回 `400 upstream_error` 后，一次离线逐字段实验（同模型 `gpt-5.6-terra`、同 key、经捕获代理）定位了真正拦截点：

| 变体 | 结果 |
|---|---|
| Codex 形态，**无 `max_output_tokens`** | 200 |
| + `max_output_tokens` = 64 / 2048 / 32768 | **400**（三者皆拒） |
| 去掉 `text`/`stream_options`/`tool_choice`/`parallel_tool_calls` | 200 |
| 去掉 `reasoning.context` | 200 |
| harness 形态（带 `max_output_tokens`） | 400 |

即 icode 上游对**任何**携带 `max_output_tokens` 的请求都拒（与值无关）；Codex 从不发送它。`reasoning.summary`/`context`/`text`/`stream_options` 都被证明无关（V4/V5 仍 200）。

**最终修复：** 新增显式开关 profile 布尔字段 `omitMaxTokens?: boolean`；为 true 时同一 `onPayload` 钩子删除 `params.max_output_tokens`。icode 路由设置 `omitMaxTokens: true`（并保留 `reasoningSummary: detailed` 对齐）。`reasoning.context` 注入予以保留（无害、与 Codex 对齐），但不再认为是拦截点。
