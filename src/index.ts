#!/usr/bin/env bun
import { serve, doctor } from "./server.ts";
export { toAnthropicModelsList, createGatewayState, codexAppServerCommand, toCodexRequests, shouldStreamAnthropicResponse, codexThreadStartParams, codexDynamicToolSpecs, codexDynamicToolsForTurn, codexDynamicToolName, latestUserContentBlockTypes, promptlessInitialTurnError, codexDynamicToolInputSchema, resolveCodexModel, toAnthropicStreamEvents, nonStreamingAnthropicResponseFromEvents, toolOutputFromMessages, cancellationRequest, shouldForwardWithRetryDedupe, cleanShutdownRequests } from "./protocol.ts";
export type { AnthropicRole, AnthropicTextBlock, AnthropicToolUseBlock, AnthropicToolResultBlock, AnthropicContentBlock, AnthropicMessage, AnthropicTool, AnthropicMessagesRequest, JsonRpcRequest, CodexTurnToolOutput, JsonRpcNotification, CodexGatewayOptions, GatewayRequestBatch, AnthropicSseEvent, AnthropicMessagesResponse, GatewayState, CodexModelCatalogEntry, CodexModelListResult } from "./protocol.ts";
export { CodexJsonRpcClient, gatewayTimeout, failClosedClientRequestResult } from "./client.ts";

if (import.meta.main) {
  const command = process.argv[2] ?? "serve";
  if (command === "serve") await serve();
  else if (command === "doctor") doctor();
  else {
    console.error("usage: bun run src/index.ts [serve|doctor]");
    process.exitCode = 2;
  }
}
