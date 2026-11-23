import { NextResponse } from "next/server";
import type { AiChatRequest, AiContentBlock, AiMessage } from "@/lib/aiCompanion/protocol";
import {
  anthropicApiKey,
  checkCompanionAccess,
  companionModel,
  companionStatus,
  companionTools,
  COMPANION_SYSTEM_PROMPT,
  toolHelp,
} from "@/lib/aiCompanion/server";

export const dynamic = "force-dynamic";
export const revalidate = false;
// A turn with images and tools can take a while.
export const maxDuration = 300;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_MESSAGES = 400;

/**
 * GET without parameters: whether the companion is set up (no password needed, it says nothing else).
 * GET ?help=<tool>&fields=a,b: the description of an editor tool, for the companion's tool_help.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const help = url.searchParams.get("help");
  if (!help) {
    return NextResponse.json(companionStatus());
  }
  const blocked = checkCompanionAccess(request);
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  const fields = (url.searchParams.get("fields") || "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  return NextResponse.json({ help: toolHelp(help, fields) });
}

function isMessage(value: unknown): value is AiMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as AiMessage;
  return (message.role === "user" || message.role === "assistant") && Array.isArray(message.content);
}

/** Marks the end of the conversation so far for prompt caching; the next turn reads it from the cache. */
function withCacheBreakpoint(messages: AiMessage[]): AiMessage[] {
  const copy = messages.map((message) => ({
    ...message,
    content: message.content.map((block) => {
      if ("cache_control" in block) {
        const { cache_control: _dropped, ...rest } = block as AiContentBlock & { cache_control?: unknown };
        return rest as AiContentBlock;
      }
      return block;
    }),
  }));
  const last = copy[copy.length - 1];
  if (last && last.content.length) {
    const index = last.content.length - 1;
    const block = last.content[index];
    if (block.type !== "tool_use") {
      last.content[index] = { ...block, cache_control: { type: "ephemeral" } } as AiContentBlock;
    }
  }
  return copy;
}

/** POST { messages }: one turn of the conversation, answered by Claude with the editor's tools. */
export async function POST(request: Request) {
  const blocked = checkCompanionAccess(request);
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status });

  let body: AiChatRequest | null = null;
  try {
    body = (await request.json()) as AiChatRequest;
  } catch {
    body = null;
  }
  const messages = body?.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES || !messages.every(isMessage)) {
    return NextResponse.json({ error: "Send the conversation as messages." }, { status: 400 });
  }

  const status = companionStatus();
  const response = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicApiKey(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: companionModel(),
      max_tokens: 8000,
      system: [{ type: "text", text: COMPANION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: companionTools(status.meshConfigured),
      messages: withCacheBreakpoint(messages),
    }),
    signal: request.signal,
  }).catch((error: unknown) => {
    return new Response(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }), { status: 502 });
  });

  const payload = (await response.json().catch(() => null)) as
    | { content?: AiContentBlock[]; stop_reason?: string; usage?: Record<string, number>; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.content) {
    const message = payload?.error?.message || `The AI service answered HTTP ${response.status}.`;
    // 401 and 403 from Anthropic mean the server's API key; the panel keeps 401 for its own password.
    const statusCode = response.status === 429 || response.status === 529 ? response.status : 502;
    return NextResponse.json({ error: `AI service: ${message}` }, { status: statusCode });
  }
  return NextResponse.json({ content: payload.content, stop_reason: payload.stop_reason ?? null, usage: payload.usage });
}
