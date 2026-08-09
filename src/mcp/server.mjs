import readline from "node:readline";
import { MCP_TOOLS, callMcpTool } from "./tools.mjs";
import { SERVICE_NAME, VERSION } from "../version.mjs";

export const MODERN_MCP_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_MCP_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([
  MODERN_MCP_PROTOCOL_VERSION,
  ...LEGACY_MCP_PROTOCOL_VERSIONS,
]);

export const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
export const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
export const MCP_SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

const DEFAULT_LEGACY_PROTOCOL_VERSION = LEGACY_MCP_PROTOCOL_VERSIONS[0];
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const STATIC_CATALOG_TTL_MS = 300_000;
const SERVER_INFO = Object.freeze({
  name: SERVICE_NAME,
  version: VERSION,
  description: "Agent-first OpenAI Responses gateway control and acceptance tools.",
});
const SERVER_CAPABILITIES = Object.freeze({ tools: { listChanged: false } });
const SERVER_INSTRUCTIONS = "Use aocx_verify only with trusted local acceptance specifications; commands execute directly without a shell.";
const TOOL_NAMES = new Set(MCP_TOOLS.map((tool) => tool.name));

export async function runMcpServer(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(output, errorResponse(null, -32700, "Parse error"));
      continue;
    }
    const response = await handleMcpMessage(message, options);
    if (response) write(output, response);
  }
}

export async function handleMcpMessage(message, options = {}) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return errorResponse(message?.id ?? null, -32600, "Invalid Request");
  }

  const isNotification = message.id === undefined;
  try {
    const requestVersion = protocolVersionFromMessage(message);
    if (requestVersion && !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestVersion)) {
      throw rpcError(UNSUPPORTED_PROTOCOL_VERSION, `Unsupported MCP protocol version: ${requestVersion}`, {
        supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
        requested: requestVersion,
      });
    }

    const modern = requestVersion === MODERN_MCP_PROTOCOL_VERSION || message.method === "server/discover";
    if (modern) validateModernRequestMetadata(message);

    let result;
    switch (message.method) {
      case "server/discover":
        result = modernResult({
          supportedVersions: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
          capabilities: SERVER_CAPABILITIES,
          instructions: SERVER_INSTRUCTIONS,
          ttlMs: STATIC_CATALOG_TTL_MS,
          cacheScope: "public",
        });
        break;

      case "initialize":
        result = {
          protocolVersion: negotiateLegacyProtocolVersion(message.params?.protocolVersion),
          capabilities: SERVER_CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        };
        break;

      case "ping":
        result = modern ? modernResult({}) : {};
        break;

      case "tools/list":
        result = modern
          ? modernResult({ tools: MCP_TOOLS, ttlMs: STATIC_CATALOG_TTL_MS, cacheScope: "public" })
          : { tools: MCP_TOOLS };
        break;

      case "tools/call": {
        const name = message.params?.name;
        if (typeof name !== "string" || name.length === 0) {
          throw rpcError(-32602, "tools/call requires params.name");
        }
        if (!TOOL_NAMES.has(name)) {
          throw rpcError(-32602, `Unknown tool: ${name}`);
        }

        let toolResult;
        try {
          const structuredContent = await callMcpTool(name, message.params?.arguments ?? {}, options);
          toolResult = {
            content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
            structuredContent,
            isError: false,
          };
        } catch (error) {
          toolResult = {
            content: [{ type: "text", text: `${error.name ?? "Error"}: ${error.message}` }],
            structuredContent: { error: { name: error.name, message: error.message, code: error.code } },
            isError: true,
          };
        }
        result = modern ? modernResult(toolResult) : toolResult;
        break;
      }

      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;

      default:
        throw rpcError(-32601, `Method not found: ${message.method}`);
    }

    if (isNotification) return undefined;
    return { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    if (isNotification) return undefined;
    return errorResponse(message.id, error.rpcCode ?? -32603, error.message ?? "Internal error", error.data);
  }
}

function protocolVersionFromMessage(message) {
  const value = message.params?._meta?.[MCP_PROTOCOL_VERSION_META_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validateModernRequestMetadata(message) {
  const meta = message.params?._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw rpcError(-32602, `${message.method} requires params._meta for MCP ${MODERN_MCP_PROTOCOL_VERSION}`);
  }
  if (meta[MCP_PROTOCOL_VERSION_META_KEY] !== MODERN_MCP_PROTOCOL_VERSION) {
    const requested = meta[MCP_PROTOCOL_VERSION_META_KEY];
    if (typeof requested === "string" && requested.length > 0) {
      throw rpcError(UNSUPPORTED_PROTOCOL_VERSION, `Unsupported MCP protocol version: ${requested}`, {
        supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS],
        requested,
      });
    }
    throw rpcError(-32602, `params._meta.${MCP_PROTOCOL_VERSION_META_KEY} is required`);
  }
  const capabilities = meta[MCP_CLIENT_CAPABILITIES_META_KEY];
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw rpcError(-32602, `params._meta.${MCP_CLIENT_CAPABILITIES_META_KEY} must be an object`);
  }
  const clientInfo = meta[MCP_CLIENT_INFO_META_KEY];
  if (clientInfo !== undefined && !isImplementation(clientInfo)) {
    throw rpcError(-32602, `params._meta.${MCP_CLIENT_INFO_META_KEY} must contain string name and version`);
  }
}

function isImplementation(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof value.name === "string"
    && value.name.length > 0
    && typeof value.version === "string"
    && value.version.length > 0;
}

function negotiateLegacyProtocolVersion(requested) {
  return LEGACY_MCP_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : DEFAULT_LEGACY_PROTOCOL_VERSION;
}

function modernResult(result) {
  return {
    resultType: "complete",
    ...result,
    _meta: {
      ...(result._meta && typeof result._meta === "object" ? result._meta : {}),
      [MCP_SERVER_INFO_META_KEY]: SERVER_INFO,
    },
  };
}

function write(output, message) {
  output.write(`${JSON.stringify(message)}\n`);
}

function errorResponse(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function rpcError(code, message, data) {
  const error = new Error(message);
  error.rpcCode = code;
  error.data = data;
  return error;
}
