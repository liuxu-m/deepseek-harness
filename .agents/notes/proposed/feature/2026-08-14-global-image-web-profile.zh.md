# Agent Note: Web profile 的全局图片输入

Status: proposed

[English](2026-08-14-global-image-web-profile.md) | 中文

## Problem

DeepSeek Harness 把图片能力声明为模型级属性（`inputModalities`），并在四个位置强制校验：`dsh-host-apiproxy` 的上传准入与切换模型检查、`dsh-llm-pi-ai` 请求时的 `UNSUPPORTED_CONTENT` 检查、`dsh-tool-fs` 的 `read_image` 能力门禁。因此像 `deepseek-v4-flash` 这样的纯文本路由模型在任何会话中都无法接收图片，即使外部视觉模型本可以描述它们。

一个用户验证过的部署通过修补编译后的 npm 产物（`[dsh-patch:global-image]`）并添加调用 MiniMax-M3 的 `vision` 用户级 agent preset，在一台机器上解决了该问题。Windows 桌面客户端捆绑当前检出的源码，其发行规则禁止编译产物修补，因此桌面端要具备该能力，就必须把能力实现在仓库源码中。普通命令行与浏览器界面必须继续对着同一个 Host、同一个默认 Harness home 工作。

## Proposal

新增一个单一的 `globalImage` 标志服务作为唯一事实来源。`dsh-web-app`（浏览器界面 bundle 的胶水插件）提供 `ctx.provide('globalImage', config.globalImage)`；其 `cordis.patch.yml` 中的 `web-runtime` 行设置 `globalImage: true`，因此 `dsh --profile web`——桌面端与浏览器界面——默认启用该能力，用户补丁层可关闭它。不挂载 `dsh-web-app` 的 profile 永远看不到该服务，保持原有模型门控语义。

三处 Host 侧检查都读取该标志而不是各自复制一份：

- `dsh-host-apiproxy` 上传准入：标志开启时，图片 prompt 只要求持久附件服务存在；关闭时保留现有路由模型声明检查。会话已含图片时的切换模型限制在标志开启时跳过。
- `dsh-llm-pi-ai`：适配器配置新增 `resolveGlobalImage` resolver，镜像现有 `resolveAttachments` 模式，在插件 apply 处接线为 `ctx.get('globalImage') === true`。路由模型未声明图片输入且标志开启时，图片块被剥离为携带附件信息 JSON 的文本占位符，tool-result 内部图片变为 vision 工具提示，请求继续；标志关闭时保留现有 `UNSUPPORTED_CONTENT` 错误。
- `dsh-tool-fs` 的 `read_image`：路由模型未声明图片输入且标志开启时，门禁只要求持久附件服务存在，不再要求图片能力模型。

`vision` 工具本身仍是 `~/.dsh/.agent-presets/vision/` 下的用户级 agent preset，用托管凭据文档中的 `MINIMAX_API_KEY` 调用 MiniMax-M3。桌面端与普通 CLI 启动共享默认 Harness home，因此 preset、凭据与设置直接继承，不需要第二层数据或同步。

本提案在标志开启时部分超集两个已实现决策。严格的 `read_image` 路由门禁（见 [最小 read_image 工具笔记](../../implemented/feature/2026-08-10-minimal-read-image-tool.md)）改为附件服务门禁；「Web 多模态图片输入与持久附件」笔记（见 [Web 多模态图片输入与持久附件](../../implemented/feature/2026-07-22-web-multimodal-image-input-and-durable-attachments.md)）中的「不得展平或跳过图片」不变式获得一个标志开启时的例外，把图片块转换为文本占位符。两份笔记在标志关闭时行为不变，因此继续有效且权威；标志关闭路径保留严格拒绝，保证文本路由的持久历史永远不会获得图片块。

用户验证机器上针对无扩展名附件对象路径的魔数嗅探能力本次推迟，并记录为已知限制；本移植保留基于扩展名的媒体类型解析。

## Alternatives considered

**无条件移植。** 与补丁机器完全一致，不需要配置面。已拒绝：它改变所有 profile（headless、ACP、JSON-RPC）的模型请求语义，且无法按 profile 回退；仓库规则要求 opt-in 不进 shipped 默认。

**把 vision 工具产品化为仓库包。** 带可配置 provider、模型与凭据键的 shipped `vision` 工具可让桌面免配置工作。v1 已拒绝：它引入 provider 面、凭据键接线、文档与快照，而用户验证过的部署已经通过用户级 preset 工作；仅标志服务即可解锁桌面端。

## Acceptance criteria

- `dsh --profile web` 在路由模型未声明图片输入时准入图片 prompt，且标志开启时永远不会出现 `MODEL_DOES_NOT_SUPPORT_IMAGES`。
- 经 `dsh-llm-pi-ai` 的纯文本模型请求携带附件信息占位符而不是图片字节，后续 `vision` 工具调用可消费占位符中的附件信息。
- 标志开启且附件服务存在时，非图片模型调用 `read_image` 成功；附件服务缺失时报持久服务错误。
- 标志缺失时，所有既有 `UNSUPPORTED_CONTENT` 与模型声明断言原样通过，headless 等 profile 不变。
- 用户补丁层设置 `globalImage: false` 后，Web profile 恢复原有模型门控行为。
- 桌面打包冒烟测试证明捆绑运行时准入图片 prompt。

## Risks

剥离路径改变纯文本模型实际接收的内容：图片字节变成占位符文本，因此从不调用 vision 工具的会话会静默丢失图片内容。占位符文本指示模型调用 `vision`，这依赖用户级 preset 与凭据；没有它们，模型只看到占位符而得不到图片描述。

`dsh-llm-pi-ai` 的适配器没有 `Context`，标志必须通过插件 apply 处接线的 `resolveGlobalImage` resolver 传入；三个包中任何一个出现第二套分叉开关，都会破坏标志服务所保证的单一来源不变式。
