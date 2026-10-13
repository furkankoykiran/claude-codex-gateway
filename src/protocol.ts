/**
 * Experimental Claude Code -> local Anthropic-compatible -> Codex app-server
 * gateway boundary.
 *
 * This module intentionally implements a narrow, fail-closed protocol subset.
 * It is not a live proof that Claude Code avoided Anthropic unless a separate
 * process-scoped network test blocks and observes Anthropic destinations.
 */

import fs from "node:fs";
import path from "node:path";

export type AnthropicRole = "user" | "assistant" | "system";

export type AnthropicTextBlock = {
  type: "text";
  text: string;
};

export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export type AnthropicMessage = {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: unknown;
};

export type AnthropicMessagesRequest = {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  stream?: boolean;
  tools?: AnthropicTool[];
  metadata?: Record<string, unknown>;
};

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: Record<string, unknown>;
};

export type CodexTurnToolOutput = {
  toolUseId: string;
  name: string;
  namespace: string | null;
  output: string | AnthropicTextBlock[];
};

export type JsonRpcNotification = {
  jsonrpc?: "2.0";
  method: string;
  params?: Record<string, unknown>;
};

export type CodexGatewayOptions = {
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  threadId?: string;
  requestId?: string | number;
};

export type GatewayRequestBatch = {
  threadId: string | null;
  requests: JsonRpcRequest[];
  unsupported: string[];
};

export type AnthropicSseEvent = {
  event: string;
  data: Record<string, unknown>;
};

export type AnthropicMessagesResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicTextBlock[];
  stop_reason: "end_turn";
  usage: { input_tokens: number; output_tokens: number };
};

export type GatewayState = {
  seenRequestKeys: Set<string>;
  activeTurns: Map<string, { threadId: string }>;
  emittedErrors: Set<string>;
  emittedToolUseIds: Set<string>;
  toolNameAliases: Map<string, string>;
  toolRequiredArguments: Map<string, string[]>;
  turnText: string;
  appServerThreadId: string | null;
  appServerTurnId: string | null;
  terminalTurnState: string | null;
  toolResultContinuation: boolean;
  emittedText: string;
  model: string | null;
};

export type PendingToolRoute = {
  threadId: string;
  turnId: string;
  sessionId: string | null;
  rpcId: string | number;
  delivered: boolean;
  notification: JsonRpcNotification;
};

export type ClaudeGatewayRequestTrace = {
  event: "codex-gateway.claudeRequest";
  sessionId: string | null;
  promptId: string | null;
  requestClass: string | null;
  prevToolDurations: string | null;
  latestUserContentBlockTypes: string[];
  actionableUserText: string;
  hasToolResult: boolean;
  appServerThreadId: string | null;
  appServerTurnId: string | null;
  terminalTurnState: string | null;
};

export type ClaudeGatewayHeaderHints = Pick<
  ClaudeGatewayRequestTrace,
  "sessionId" | "promptId" | "requestClass" | "prevToolDurations"
>;


export type CodexModelCatalogEntry = Record<string, unknown> & {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
};

export type CodexModelListResult = {
  data?: CodexModelCatalogEntry[];
  nextCursor?: string | null;
};

export function toAnthropicModelsList(result: CodexModelListResult): Record<string, unknown> {
  const data = Array.isArray(result.data) ? result.data : [];
  return {
    object: "list",
    data: data
      .filter((model) => model.hidden !== true)
      .map((model) => {
        const id = typeof model.id === "string"
          ? model.id
          : typeof model.model === "string"
            ? model.model
            : "unknown-codex-model";
        return {
          id,
          object: "model",
          display_name: typeof model.displayName === "string" ? model.displayName : id,
          metadata: {
            codex_model: typeof model.model === "string" ? model.model : id,
            description: typeof model.description === "string" ? model.description : null,
            default_reasoning_effort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null,
            supported_reasoning_efforts: Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts
              : [],
            input_modalities: Array.isArray(model.inputModalities) ? model.inputModalities : [],
            service_tiers: Array.isArray(model.serviceTiers) ? model.serviceTiers : [],
            default_service_tier: typeof model.defaultServiceTier === "string" ? model.defaultServiceTier : null,
            upgrade: typeof model.upgrade === "string" ? model.upgrade : null,
            upgrade_info: model.upgradeInfo ?? null,
            is_default: model.isDefault === true,
          },
        };
      }),
  };
}


export function createGatewayState(): GatewayState {
  return {
    seenRequestKeys: new Set(),
    activeTurns: new Map(),
    emittedErrors: new Set(),
    emittedToolUseIds: new Set(),
    toolNameAliases: new Map(),
    toolRequiredArguments: new Map(),
    turnText: "",
    appServerThreadId: null,
    appServerTurnId: null,
    terminalTurnState: null,
    toolResultContinuation: false,
    emittedText: "",
    model: null,
  };
}

export function codexAppServerCommand(): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: "codex",
    args: ["app-server", "--stdio"],
    env: {},
  };
}

export function toCodexRequests(
  request: AnthropicMessagesRequest,
  options: CodexGatewayOptions,
  toolAliasesByOriginal: Map<string, string> = new Map(),
): GatewayRequestBatch {
  validateAnthropicRequest(request);

  const promptlessError = promptlessInitialTurnError(request, toolAliasesByOriginal);
  if (promptlessError) {
    throw new Error(promptlessError);
  }

  const existingThreadId = options.threadId ?? null;
  const toolOutput = toolOutputFromMessages(request.messages, toolAliasesByOriginal);
  const input = toolOutput ? [] : flattenMessages(request);
  let system = flattenSystem(request.system);
  for (const message of request.messages) {
    if (message.role === "system") {
      const text = typeof message.content === "string" ? message.content : flattenContent(message.content);
      if (text) {
        system = system ? `${system}\n${text}` : text;
      }
    }
  }
  const hasFileTools = request.tools?.some((t) => t.name === "Write" || t.name === "Edit");
  if (hasFileTools) {
    const clientToolNotice = "Client tools (including Write and Edit) are executed by Claude Code on the host filesystem with user approval. Invoke Write and Edit to create and modify files when requested.";
    system = system ? `${system}\n\n${clientToolNotice}` : clientToolNotice;
  }
  const additionalContext = system
    ? {
        "anthropic-system": {
          kind: "application",
          value: system,
        },
      }
    : null;

  const effectiveCwd = extractSessionWorkingDirectory(request.messages, request.system) || options.cwd;

  const params: Record<string, unknown> = {
    input,
    cwd: effectiveCwd,
    model: resolveCodexModel(request.model, options.model),
    additionalContext,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  };
  if (toolOutput) {
    params["toolOutput"] = toolOutput;
  }
  if (options.reasoningEffort) {
    params["effort"] = options.reasoningEffort;
  }

  const requestId = options.requestId ?? crypto.randomUUID();
  const threadId = existingThreadId;
  const method = "turn/start";
  const codexParams = { ...params, ...(threadId ? { threadId } : {}) };

  return {
    threadId: existingThreadId,
    requests: [
      {
        jsonrpc: "2.0",
        id: requestId,
        method,
        params: codexParams,
      },
    ],
    unsupported: [],
  };
}

export function shouldStreamAnthropicResponse(request: Pick<AnthropicMessagesRequest, "stream">): boolean {
  return request.stream === true;
}

export function codexThreadStartParams(
  cwd: string,
  model: string | undefined,
  requestModel: string,
  tools: AnthropicTool[] = [],
  messages: AnthropicMessage[] = [],
  aliases: Map<string, string> = new Map(),
  reverseAliases: Map<string, string> = new Map(),
  requiredArguments: Map<string, string[]> = new Map(),
  turnText = "",
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    cwd,
    model: resolveCodexModel(requestModel, model),
    ephemeral: true,
    threadSource: "claude-codex-gateway",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "read-only",
  };
  if (tools.length > 0) {
    const dynamicTools = codexDynamicToolSpecs(tools, messages, aliases, reverseAliases, requiredArguments, turnText);
    traceDynamicTools(dynamicTools, messages, null);
    params["dynamicTools"] = dynamicTools;
  }
  return params;
}

export function codexDynamicToolSpecs(
  tools: AnthropicTool[],
  messages: AnthropicMessage[],
  aliases: Map<string, string> = new Map(),
  reverseAliases: Map<string, string> = new Map(),
  requiredArguments: Map<string, string[]> = new Map(),
  turnText = "",
): Record<string, unknown>[] {
  return codexDynamicToolsForTurn(tools, messages, turnText).map((tool, index) => {
    const name = codexDynamicToolName(tool.name, index);
    if (name !== tool.name) {
      aliases.set(name, tool.name);
    }
    reverseAliases.set(tool.name, name);
    const inputSchema = codexDynamicToolInputSchema(tool.name, tool.input_schema);
    requiredArguments.set(name, requiredArgumentsFromSchema(inputSchema));
    requiredArguments.set(tool.name, requiredArgumentsFromSchema(inputSchema));
    return {
      type: "function",
      name,
      description: codexDynamicToolDescription(tool, inputSchema),
      inputSchema,
    };
  });
}

export function codexDynamicToolsForTurn(tools: AnthropicTool[], messages: AnthropicMessage[], explicitTurnText = ""): AnthropicTool[] {
  const turnText = (explicitTurnText || latestUserMessageText(messages)).toLowerCase();
  const explicitJsonTools = tools.filter((tool) => explicitJsonInputForTool(turnText, tool.name));
  if (explicitJsonTools.length > 0) {
    return explicitJsonTools;
  }
  const mentioned = tools.filter((tool) => turnText.includes(tool.name.toLowerCase()));
  if (mentioned.length > 0) {
    if (mentioned.some((tool) => tool.name === "Edit") && !mentioned.some((tool) => tool.name === "Read")) {
      const readTool = tools.find((tool) => tool.name === "Read");
      if (readTool) {
        mentioned.push(readTool);
      }
    }
    return mentioned;
  }
  return tools;
}

export function codexDynamicToolName(name: string, index: number): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !name.startsWith("mcp__")) {
    return name;
  }
  const readable = name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64);
  return `claude_tool_${index}_${readable || "tool"}`;
}

export function latestUserMessageText(messages: AnthropicMessage[]): string {
  const message = latestUserMessage(messages);
  return message ? forwardableUserContentText(message.content) : "";
}

export function latestUserMessage(messages: AnthropicMessage[]): AnthropicMessage | null {
  // System context may follow a user request, but a completed assistant reply
  // must never make an earlier user/tool-result message current again.
  const message = messages.findLast((message) => message.role !== "system");
  return message?.role === "user" ? message : null;
}

export function latestUserContentBlockTypes(messages: AnthropicMessage[]): string[] {
  const message = latestUserMessage(messages);
  if (!message) {
    return [];
  }
  if (typeof message.content === "string") {
    return ["text"];
  }
  return message.content.map((block) => block.type);
}

export function latestUserMessageHasActionableText(messages: AnthropicMessage[]): boolean {
  return latestUserMessageText(messages).trim().length > 0;
}

export function turnTextForRequest(request: AnthropicMessagesRequest): string {
  return latestUserMessageText(request.messages);
}

export function promptlessInitialTurnError(
  request: AnthropicMessagesRequest,
  toolAliasesByOriginal: Map<string, string> = new Map(),
): string | null {
  if (toolOutputFromMessages(request.messages, toolAliasesByOriginal)) {
    return null;
  }
  return latestUserMessageHasActionableText(request.messages)
    ? null
    : "Claude Code did not forward an actionable user prompt to the Codex gateway; refusing to run Codex on system reminders only.";
}

export function isActionableUserText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.length > 0
    && !trimmed.startsWith("<system-reminder>")
    && !trimmed.startsWith('{"type":"tool_result"');
}

const ENV_REMINDER_BLOCK_REGEX = /<system-reminder>[\s\S]*?# Environment[\s\S]*?-\s*Primary working directory:\s*([^\r\n]+)[\s\S]*?<\/system-reminder>/;
const SYSTEM_ENV_REGEX = /(?:<system-reminder>[\s\S]*?)?# Environment[\s\S]*?-\s*Primary working directory:\s*([^\r\n]+)/;

export function isExistingDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

export function sanitizeWorkingDirectory(
  candidate: string | undefined | null,
  validator: (dir: string) => boolean = isExistingDirectory,
): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed || trimmed.includes("\0")) return null;
  if (!path.isAbsolute(trimmed)) return null;
  const normalized = path.normalize(trimmed);
  return validator(normalized) ? normalized : null;
}

export function extractSessionWorkingDirectory(
  messages: AnthropicMessage[],
  system?: string | AnthropicTextBlock[],
  validator: (dir: string) => boolean = isExistingDirectory,
): string | null {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text") {
          const text = block.text.trimStart();
          if (text.startsWith("<system-reminder>")) {
            const match = text.match(ENV_REMINDER_BLOCK_REGEX);
            if (match && match[1]) {
              const sanitized = sanitizeWorkingDirectory(match[1], validator);
              if (sanitized) return sanitized;
            }
          }
        }
      }
    } else if (typeof message.content === "string") {
      const text = message.content.trimStart();
      if (text.startsWith("<system-reminder>")) {
        const match = text.match(ENV_REMINDER_BLOCK_REGEX);
        if (match && match[1]) {
          const sanitized = sanitizeWorkingDirectory(match[1], validator);
          if (sanitized) return sanitized;
        }
      }
    }
  }

  if (typeof system === "string") {
    const match = system.match(SYSTEM_ENV_REGEX);
    if (match && match[1]) {
      const sanitized = sanitizeWorkingDirectory(match[1], validator);
      if (sanitized) return sanitized;
    }
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (block.type === "text") {
        const match = block.text.match(SYSTEM_ENV_REGEX);
        if (match && match[1]) {
          const sanitized = sanitizeWorkingDirectory(match[1], validator);
          if (sanitized) return sanitized;
        }
      }
    }
  }

  return null;
}

export function codexDynamicToolInputSchema(toolName: string, inputSchema: unknown): unknown {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) {
    return {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    };
  }
  const schema = structuredClone(inputSchema) as Record<string, unknown>;
  if (schema["type"] === undefined && (schema["properties"] || schema["required"])) {
    schema["type"] = "object";
  }
  if (schema["type"] === "object") {
    if (!schema["properties"] || typeof schema["properties"] !== "object" || Array.isArray(schema["properties"])) {
      schema["properties"] = {};
    }
    if (!Array.isArray(schema["required"])) {
      schema["required"] = [];
    }
    if (schema["additionalProperties"] === undefined) {
      schema["additionalProperties"] = false;
    }
  }
  return schema;
}

export function requiredArgumentsFromSchema(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== "object") {
    return [];
  }
  const required = (inputSchema as Record<string, unknown>)["required"];
  return Array.isArray(required) ? required.filter((value): value is string => typeof value === "string") : [];
}

export function codexDynamicToolDescription(tool: AnthropicTool, inputSchema: unknown): string {
  let base = tool.description?.trim() ?? "";
  if (tool.name === "Write" || tool.name === "Edit" || tool.name === "NotebookEdit") {
    const hostNotice = "Claude Code client tool executed on the host filesystem outside the sandbox. Invoke this tool when requested to create or edit files; the read-only sandbox does not prevent calling this tool.";
    base = base ? `${hostNotice}\n\n${base}` : hostNotice;
  }
  const schema = JSON.stringify(inputSchema);
  const contract = `Call this Claude Code client tool with JSON arguments matching this schema: ${schema}`;
  return base ? `${base}\n\n${contract}` : contract;
}

export function traceDynamicTools(
  dynamicTools: Record<string, unknown>[],
  messages: AnthropicMessage[],
  system: AnthropicMessagesRequest["system"] | null,
): void {
  if (process.env.CODEX_GATEWAY_TRACE_TOOLS !== "1") {
    return;
  }
  const systemText = flattenSystem(system ?? undefined);
  console.error(JSON.stringify({
    event: "codex-gateway.dynamicTools",
    toolNames: dynamicTools.map((tool) => tool["name"]).filter((name): name is string => typeof name === "string"),
    dynamicTools,
    latestUserTextSnippet: latestUserMessageText(messages).slice(0, 240),
    systemTextSnippet: (systemText ?? "").slice(0, 240),
    messageSummaries: messages.map((message) => ({
      role: message.role,
      snippet: flattenContent(message.content).slice(0, 160),
    })).slice(-6),
  }));
}

export function traceRequestContext(request: AnthropicMessagesRequest): void {
  if (process.env.CODEX_GATEWAY_TRACE_TOOLS !== "1") {
    return;
  }
  const systemText = flattenSystem(request.system) ?? "";
  const explicitJsonIndex = systemText.search(/\bexact JSON input\s*:/i);
  console.error(JSON.stringify({
    event: "codex-gateway.requestContext",
    tools: request.tools ?? [],
    requestKeys: Object.keys(request as Record<string, unknown>).sort(),
    metadataKeys: request.metadata ? Object.keys(request.metadata).sort() : [],
    systemTextLength: systemText.length,
    systemTextSnippet: systemText.slice(0, 500),
    explicitJsonIndex,
    explicitJsonSnippet: explicitJsonIndex >= 0 ? systemText.slice(Math.max(0, explicitJsonIndex - 160), explicitJsonIndex + 240) : "",
    latestUserTextSnippet: latestUserMessageText(request.messages).slice(0, 240),
    messageSummaries: request.messages.map((message) => ({
      role: message.role,
      snippet: flattenContent(message.content).slice(0, 160),
    })).slice(-6),
  }));
}

export function traceClaudeGatewayRequest(trace: ClaudeGatewayRequestTrace): void {
  if (process.env.CLAUDE_CODE_GATEWAY_HINT_HEADERS !== "1" && process.env.CODEX_GATEWAY_TRACE_REQUESTS !== "1") {
    return;
  }
  console.error(JSON.stringify(trace));
}

export function traceToolCallMapping(
  notification: JsonRpcNotification,
  toolUse: AnthropicToolUseBlock | null,
  missingArguments: string | null,
): void {
  if (process.env.CODEX_GATEWAY_TRACE_TOOLS !== "1") {
    return;
  }
  console.error(JSON.stringify({
    event: "codex-gateway.toolCallMapping",
    codexEvent: notification,
    anthropicToolUse: toolUse,
    missingArguments,
  }));
}

export function resolveCodexModel(requestModel: string, selectedModel?: string): string {
  if (!requestModel.startsWith("claude-")) {
    return requestModel;
  }
  if (selectedModel && selectedModel.length > 0) {
    return selectedModel;
  }
  const envModel = process.env.CODEX_GATEWAY_MODEL || process.env.CODEX_MODEL;
  if (envModel) {
    return envModel;
  }
  throw new Error(
    "Claude model aliases cannot be forwarded to Codex directly; set CODEX_GATEWAY_MODEL to a Codex model id",
  );
}

export function toAnthropicStreamEvents(
  notifications: JsonRpcNotification[],
  state: GatewayState = createGatewayState(),
): AnthropicSseEvent[] {
  const events: AnthropicSseEvent[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${crypto.randomUUID()}`,
          type: "message",
          role: "assistant",
          content: [],
          model: state.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    },
  ];

  let textOpen = false;
  let contentIndex = 0;

  for (const notification of notifications) {
    const params = notification.params ?? {};
    if (isIgnorableCodexNotification(notification.method)) {
      continue;
    }

    if (notification.method === "turn/started") {
      const turnId = readTurnId(params);
      const threadId = readString(params, "threadId");
      if (turnId && threadId) {
        state.activeTurns.set(turnId, { threadId });
        state.appServerThreadId = threadId;
        state.appServerTurnId = turnId;
      }
      continue;
    }

    if (notification.method === "item/agentMessage/delta" || notification.method === "item/commandExecution/outputDelta") {
      let deltaText = readString(params, "delta") ?? "";
      if (state.toolResultContinuation) {
        state.emittedText += deltaText;
        continue;
      }
      if (!textOpen) {
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "text", text: "" },
          },
        });
        textOpen = true;
      }
      events.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: contentIndex,
          delta: { type: "text_delta", text: deltaText },
        },
      });
      state.emittedText += deltaText;
      continue;
    }

    if (notification.method === "item/tool/call") {
      const toolUse = repairToolUseInput(dynamicToolUseFromToolCallParams(params, state.toolNameAliases), state);
      const missingArguments = toolUse ? missingRequiredToolUseArguments(toolUse, state.toolRequiredArguments) : null;
      traceToolCallMapping(notification, toolUse, missingArguments);
      if (missingArguments) {
        events.push({
          event: "error",
          data: {
            type: "error",
            error: {
              type: "api_error",
              message: missingArguments,
            },
          },
        });
        continue;
      }
      if (toolUse && !state.emittedToolUseIds.has(toolUse.id)) {
        state.emittedToolUseIds.add(toolUse.id);
        if (textOpen) {
          events.push({
            event: "content_block_stop",
            data: { type: "content_block_stop", index: contentIndex },
          });
          contentIndex += 1;
          textOpen = false;
        }
        events.push(...anthropicToolUseSseEvents(contentIndex, toolUse));
        contentIndex += 1;
      }
      continue;
    }

    if (notification.method === "item/completed") {
      const toolUse = repairToolUseInput(dynamicToolUseFromItem(params["item"], state.toolNameAliases), state);
      if (toolUse) {
        const missingArguments = missingRequiredToolUseArguments(toolUse, state.toolRequiredArguments);
        traceToolCallMapping(notification, toolUse, missingArguments);
        if (missingArguments) {
          events.push({
            event: "error",
            data: {
              type: "error",
              error: {
                type: "api_error",
                message: missingArguments,
              },
            },
          });
          continue;
        }
        if (state.emittedToolUseIds.has(toolUse.id)) {
          continue;
        }
        state.emittedToolUseIds.add(toolUse.id);
        if (textOpen) {
          events.push({
            event: "content_block_stop",
            data: { type: "content_block_stop", index: contentIndex },
          });
          contentIndex += 1;
          textOpen = false;
        }
        events.push(...anthropicToolUseSseEvents(contentIndex, toolUse));
        contentIndex += 1;
      }
      continue;
    }

    if (notification.method === "turn/completed" || notification.method === "turn/failed" || notification.method === "turn/interrupted") {
      state.terminalTurnState = notification.method;
      state.appServerThreadId = readString(params, "threadId") ?? state.appServerThreadId;
      state.appServerTurnId = readTurnId(params) ?? state.appServerTurnId;
      if (state.toolResultContinuation && state.emittedText.length > 0) {
        events.push({
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: contentIndex,
            content_block: { type: "text", text: "" },
          },
        });
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: contentIndex,
            delta: { type: "text_delta", text: collapseAdjacentRepeatedText(state.emittedText) },
          },
        });
        events.push({
          event: "content_block_stop",
          data: { type: "content_block_stop", index: contentIndex },
        });
        contentIndex += 1;
        state.emittedText = "";
      }
      if (textOpen) {
        events.push({
          event: "content_block_stop",
          data: { type: "content_block_stop", index: contentIndex },
        });
        contentIndex += 1;
        textOpen = false;
      }
      const terminalError = terminalTurnError(notification.method, params);
      if (terminalError) {
        events.push({
          event: "error",
          data: {
            type: "error",
            error: {
              type: "api_error",
              message: terminalError,
            },
          },
        });
        continue;
      }
      events.push({
        event: "message_delta",
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 0 },
        },
      });
      continue;
    }

    if (notification.method === "error") {
      state.terminalTurnState = "error";
      const key = JSON.stringify(params);
      if (!state.emittedErrors.has(key)) {
        state.emittedErrors.add(key);
        events.push({
          event: "error",
          data: {
            type: "error",
            error: {
              type: "api_error",
              message: readString(params, "message") ?? "Codex app-server error",
            },
          },
        });
      }
      continue;
    }

    throw new Error(`Unsupported Codex notification: ${notification.method}`);
  }

  if (textOpen) {
    events.push({
      event: "content_block_stop",
      data: { type: "content_block_stop", index: contentIndex },
    });
  }
  if (!events.some((event) => event.event === "message_delta")
    && events.some((event) => event.event === "content_block_start"
    && (event.data["content_block"] as { type?: string } | undefined)?.type === "tool_use")) {
    events.push({ event: "message_delta", data: { type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 0 } } });
  }
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
}

export function nonStreamingAnthropicResponseFromEvents(
  request: AnthropicMessagesRequest,
  events: AnthropicSseEvent[],
  selectedModel?: string,
): AnthropicMessagesResponse {
  const error = events.find((event) => event.event === "error");
  if (error) {
    throw new Error(errorMessageFromEvent(error));
  }
  const text = events
    .filter((event) => event.event === "content_block_delta")
    .map((event) => {
      const delta = event.data["delta"] as { text?: string } | undefined;
      return delta?.text ?? "";
    })
    .join("");
  return {
    id: String((events.find((event) => event.event === "message_start")?.data.message as { id?: string } | undefined)?.id ?? `msg_${crypto.randomUUID()}`),
    type: "message",
    role: "assistant",
    model: resolveCodexModel(request.model, selectedModel),
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

export function anthropicToolUseSseEvents(index: number, toolUse: AnthropicToolUseBlock): AnthropicSseEvent[] {
  return [
    {
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index,
        content_block: { ...toolUse, input: {} },
      },
    },
    {
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(toolUse.input ?? {}),
        },
      },
    },
    {
      event: "content_block_stop",
      data: { type: "content_block_stop", index },
    },
  ];
}

export function toolOutputFromMessages(
  messages: AnthropicMessage[],
  toolAliasesByOriginal: Map<string, string> = new Map(),
): CodexTurnToolOutput | null {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_use") {
        toolNames.set(block.id, block.name);
      }
    }
  }
  const latestUser = latestUserMessage(messages);
  // Claude Code can merge an old tool result with the next user instruction.
  // Actionable current text always starts a fresh turn, even in that shape.
  if (latestUser && forwardableUserContentText(latestUser.content).trim()) return null;
  if (!latestUser || !Array.isArray(latestUser.content)) {
    return null;
  }
  for (let index = latestUser.content.length - 1; index >= 0; index -= 1) {
    const block = latestUser.content[index];
    if (block?.type !== "tool_result") {
      continue;
    }
    const name = toolNames.get(block.tool_use_id);
    if (!name) {
      continue;
    }
    const output = typeof block.content === "string" ? block.content : flattenContent(block.content);
    return {
      toolUseId: block.tool_use_id,
      name: toolAliasesByOriginal.get(name) ?? name,
      namespace: null,
      output: block.is_error === true ? `Claude Code tool failed:\n${output}` : output,
    };
  }
  return null;
}

export function cancellationRequest(
  threadId: string,
  turnId: string,
  id: string | number = crypto.randomUUID(),
): JsonRpcRequest {
  if (!threadId || !turnId) {
    throw new Error("Cancellation requires both threadId and turnId");
  }
  return {
    jsonrpc: "2.0",
    id,
    method: "turn/interrupt",
    params: { threadId, turnId },
  };
}

export function shouldForwardWithRetryDedupe(
  state: GatewayState,
  request: JsonRpcRequest,
): boolean {
  const key = JSON.stringify({
    method: request.method,
    params: request.params,
  });
  if (state.seenRequestKeys.has(key)) {
    return false;
  }
  state.seenRequestKeys.add(key);
  return true;
}

export function cleanShutdownRequests(
  activeTurns: Iterable<[string, { threadId: string }]>,
): JsonRpcRequest[] {
  return Array.from(activeTurns, ([turnId, turn]) =>
    cancellationRequest(turn.threadId, turnId),
  );
}

export function isIgnorableCodexNotification(method: string): boolean {
  return method === "thread/started"
    || method === "thread/status/changed"
    || method === "thread/name/updated"
    || method === "thread/tokenUsage/updated"
    || method === "thread/settings/updated"
    || method === "thread/queue/changed"
    || method === "hook/started"
    || method === "hook/completed"
    || method === "item/started"
    || method === "item/commandExecution/terminalInteraction"
    || method === "rawResponseItem/completed"
    || method === "rawResponse/completed"
    || method === "turn/diff/updated"
    || method === "turn/plan/updated"
    || method === "turn/moderationMetadata"
    || method === "model/verification"
    || method === "model/rerouted"
    || method === "model/safetyBuffering/updated"
    || method === "mcpServer/startupStatus/updated"
    || method === "account/updated"
    || method === "account/rateLimits/updated"
    || method === "configWarning"
    || method === "warning"
    || method === "deprecationNotice";
}

export function collapseAdjacentRepeatedText(text: string): string {
  if (text.length === 0 || text.length % 2 !== 0) {
    return text;
  }
  const half = text.length / 2;
  const first = text.slice(0, half);
  return first === text.slice(half) ? first : text;
}

export function terminalTurnError(method: string, params: Record<string, unknown>): string | null {
  if (method === "turn/failed") {
    return turnErrorMessage(params, "Codex turn failed");
  }
  if (method === "turn/interrupted") {
    return turnErrorMessage(params, "Codex turn interrupted");
  }
  const turn = params["turn"];
  if (turn && typeof turn === "object") {
    const record = turn as Record<string, unknown>;
    const status = record["status"];
    if (status === "failed") {
      return turnErrorMessage(params, "Codex turn failed");
    }
    if (status === "interrupted") {
      return turnErrorMessage(params, "Codex turn interrupted");
    }
  }
  return null;
}

export function turnErrorMessage(params: Record<string, unknown>, fallback: string): string {
  const direct = readString(params, "message");
  if (direct) return direct;
  const error = params["error"];
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  const turn = params["turn"];
  if (turn && typeof turn === "object") {
    const error = (turn as Record<string, unknown>)["error"];
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
  }
  return fallback;
}

export function errorMessageFromEvent(event: AnthropicSseEvent): string {
  const error = event.data["error"];
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Codex app-server error";
}

export function validateAnthropicRequest(request: AnthropicMessagesRequest): void {
  if (!request.model) {
    throw new Error("Anthropic request missing model");
  }
  if (!Number.isFinite(request.max_tokens) || request.max_tokens <= 0) {
    throw new Error("Anthropic request max_tokens must be positive");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new Error("Anthropic request must include at least one message");
  }
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "system") {
      // Allow mid-conversation system messages
    } else if (message.role !== "user" && message.role !== "assistant") {
      throw new Error(`Unsupported Anthropic message role at index ${index}`);
    }
  }
}

export function flattenMessages(request: AnthropicMessagesRequest): Record<string, unknown>[] {
  const text = latestUserMessageText(request.messages);
  if (!text) {
    throw new Error("Anthropic request has no current user text to forward");
  }
  return [{ type: "text", text: `user: ${text}`, text_elements: [] }];
}

export function forwardableUserContentText(content: AnthropicMessage["content"]): string {
  if (typeof content === "string") {
    return isActionableUserText(content) ? content : "";
  }
  return content
    .filter((block): block is AnthropicTextBlock => block.type === "text" && isActionableUserText(block.text))
    .map((block) => block.text)
    .join("\n");
}

export function flattenContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }
      if (block.type === "tool_result") {
        return JSON.stringify({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          is_error: block.is_error === true,
          content: typeof block.content === "string" ? block.content : flattenContent(block.content),
        });
      }
      if (block.type === "tool_use") {
        return JSON.stringify({
          type: "tool_use_observation",
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
      const unsupported: never = block;
      throw new Error(`Unsupported Anthropic content block: ${JSON.stringify(unsupported)}`);
    })
    .filter(Boolean)
    .join("\n");
}

export function flattenSystem(system: AnthropicMessagesRequest["system"]): string | null {
  if (!system) {
    return null;
  }
  if (typeof system === "string") {
    return system;
  }
  return system.map((block) => block.text).join("\n");
}

export function mergeNullableRecords(
  first: Record<string, unknown> | null,
  second: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!first && !second) {
    return null;
  }
  return { ...(first ?? {}), ...(second ?? {}) };
}

export function readString(
  params: Record<string, unknown>,
  key: string,
): string | null {
  const value = params[key];
  return typeof value === "string" ? value : null;
}

export function readTurnId(params: Record<string, unknown>): string | null {
  const turn = params["turn"];
  if (turn && typeof turn === "object" && "id" in turn) {
    const id = (turn as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return readString(params, "turnId");
}

export function dynamicToolUseFromItem(item: unknown, aliases: Map<string, string> = new Map()): AnthropicToolUseBlock | null {
  if (!item || typeof item !== "object") {
    return null;
  }
  const record = item as Record<string, unknown>;
  const type = record["type"];
  if (type !== "dynamic_tool_call" && type !== "mcp_tool_call" && type !== "dynamicToolCall" && type !== "mcpToolCall") {
    return null;
  }
  const id = typeof record["id"] === "string" ? record["id"] : "toolu_codex";
  const rawName =
    typeof record["toolName"] === "string"
      ? record["toolName"]
      : typeof record["tool"] === "string"
        ? record["tool"]
      : typeof record["name"] === "string"
        ? record["name"]
        : typeof record["tool"] === "string"
          ? record["tool"]
          : "codex_tool";
  const name = aliases.get(rawName) ?? rawName;
  return {
    type: "tool_use",
    id,
    name,
    input: dynamicToolInput(record),
  };
}

export function repairToolUseInput(toolUse: AnthropicToolUseBlock | null, state: GatewayState): AnthropicToolUseBlock | null {
  if (!toolUse || !isEmptyRecord(toolUse.input)) {
    return toolUse;
  }
  const repaired = explicitJsonInputForTool(state.turnText, toolUse.name);
  return repaired ? { ...toolUse, input: repaired } : toolUse;
}

export function explicitJsonInputForTool(turnText: string, toolName: string): Record<string, unknown> | null {
  const marker = new RegExp(`${escapeRegExp(toolName)}[^\\n{}]*exact JSON input\\s*:\\s*(\\{[^\\n]+\\})`, "i");
  const match = turnText.match(marker);
  if (!match?.[1]) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isEmptyRecord(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

export function missingRequiredToolUseArguments(toolUse: AnthropicToolUseBlock, requiredByTool: Map<string, string[]>): string | null {
  const required = requiredByTool.get(toolUse.name) ?? [];
  if (required.length === 0) {
    return null;
  }
  const record = toolUse.input && typeof toolUse.input === "object" && !Array.isArray(toolUse.input)
    ? toolUse.input as Record<string, unknown>
    : {};
  const missing = required.filter((name) => record[name] === undefined || record[name] === null);
  if (missing.length === 0) {
    return null;
  }
  return `Codex dynamic tool call ${toolUse.name} omitted required argument(s): ${missing.join(", ")}`;
}

export function dynamicToolUseFromToolCallParams(params: Record<string, unknown>, aliases: Map<string, string> = new Map()): AnthropicToolUseBlock | null {
  const id = readString(params, "callId");
  const rawName = readString(params, "tool");
  if (!id || !rawName) {
    return null;
  }
  return {
    type: "tool_use",
    id,
    name: aliases.get(rawName) ?? rawName,
    input: params["arguments"] ?? {},
  };
}

export function missingRequiredToolArguments(params: Record<string, unknown>, requiredByTool: Map<string, string[]>): string | null {
  const tool = readString(params, "tool");
  if (!tool) {
    return null;
  }
  const required = requiredByTool.get(tool) ?? [];
  if (required.length === 0) {
    return null;
  }
  const args = params["arguments"];
  const record = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const missing = required.filter((name) => record[name] === undefined || record[name] === null);
  if (missing.length === 0) {
    return null;
  }
  return `Codex dynamic tool call ${tool} omitted required argument(s): ${missing.join(", ")}`;
}

export function dynamicToolInput(record: Record<string, unknown>): unknown {
  const value = dynamicToolInputValue(record);
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return { arguments: value };
    }
  }
  return value ?? {};
}

export function dynamicToolInputValue(record: Record<string, unknown>): unknown {
  if (record["arguments"] !== undefined) {
    return record["arguments"];
  }
  const input = record["input"];
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const inputRecord = input as Record<string, unknown>;
    if (Object.keys(inputRecord).length === 1 && inputRecord["arguments"] !== undefined) {
      return inputRecord["arguments"];
    }
  }
  return input;
}

