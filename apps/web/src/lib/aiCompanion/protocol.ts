// Shared between the AI companion's browser panel and its server routes.

export const AI_COMPANION_ROUTE = "/api/ai-companion";
export const AI_COMPANION_MESH_ROUTE = "/api/ai-companion/mesh";
export const AI_COMPANION_KEY_HEADER = "x-companion-key";

/** The tools the companion defines itself; they are not editor commands and run in the panel. */
export const COMPANION_TOOL_HELP = "tool_help";
export const COMPANION_RUN_TOOL = "run_tool";
export const COMPANION_GENERATE_MODEL = "generate_3d_model";

/** Status the panel asks for before it shows the chat. */
export type AiCompanionStatus = {
  configured: boolean;
  meshConfigured: boolean;
  needsKey: boolean;
  model: string;
};

// The Anthropic Messages format, only as much as the companion uses.
export type AiTextBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
export type AiImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string };
  cache_control?: { type: "ephemeral" };
};
export type AiToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type AiToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<AiTextBlock | AiImageBlock>;
  is_error?: boolean;
  cache_control?: { type: "ephemeral" };
};
export type AiContentBlock = AiTextBlock | AiImageBlock | AiToolUseBlock | AiToolResultBlock;
export type AiMessage = { role: "user" | "assistant"; content: AiContentBlock[] };

export type AiChatRequest = { messages: AiMessage[] };
export type AiChatResponse = {
  content: AiContentBlock[];
  stop_reason: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
};

export type MeshSource = "photo" | "text";
export type MeshStartRequest = { source: MeshSource; prompt?: string; image?: string };
export type MeshTaskStatus = {
  taskId: string;
  kind: "image" | "text";
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";
  progress: number;
  error?: string;
};
