/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: the three
 * request/result pairs and the four server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  SubagentCloseResult,
  SubagentControlResult,
  SubagentStatusSnapshot,
  SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** Progress projection notification for one child. */
export interface SubagentProgressNotification {
  sessionId: string
  eventSeq: number
  occurredAt: number
  agentId: string
  parentSessionId: string
  state: string
  pendingMessageCount: number
  phase?: string
  lastActivityAt?: number
}

/** Parent-visible report notification. */
export interface SubagentReportNotification {
  sessionId: string
  eventSeq: number
  occurredAt: number
  agentId: string
  parentSessionId: string
  report: string
}

/** Accepted control edge notification. */
export interface SubagentControlNotification {
  sessionId: string
  eventSeq: number
  occurredAt: number
  agentId: string
  parentSessionId: string
  requestId: string
  action: 'queue' | 'followup' | 'steer' | 'interrupt' | 'close'
  accepted: boolean
  messageId?: string
  closedAgentIds?: string[]
}

/** Parameters for a parent-authorized control operation. */
export interface SubagentControlParams {
  parentSessionId: string
  agentId: string
  action: 'queue' | 'followup' | 'steer' | 'interrupt' | 'close'
  message?: string
  cascade?: boolean
}

/** Result of a control operation. */
export type SubagentControlResultWire = SubagentControlResult | SubagentCloseResult

/** Parameters for querying one child status. */
export interface SubagentStatusParams {
  parentSessionId: string
  agentId: string
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
  'subagent.progress': SubagentProgressNotification
  'subagent.report': SubagentReportNotification
  'subagent.control': SubagentControlNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'subagent/control': { params: SubagentControlParams; result: SubagentControlResultWire }
  'subagent/status': { params: SubagentStatusParams; result: SubagentStatusSnapshot }
  'shutdown': { params: undefined; result: Record<string, never> }
}
