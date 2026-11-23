"use client";

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { Check, ImagePlus, Loader2, RotateCcw, Send, Sparkles, Square, X, AlertTriangle } from "lucide-react";
import toolActionsJson from "@/lib/aiCompanion/toolActions.generated.json";
import {
  AI_COMPANION_KEY_HEADER,
  AI_COMPANION_MESH_ROUTE,
  AI_COMPANION_ROUTE,
  COMPANION_GENERATE_MODEL,
  COMPANION_RUN_TOOL,
  COMPANION_TOOL_HELP,
  type AiChatResponse,
  type AiCompanionStatus,
  type AiContentBlock,
  type AiImageBlock,
  type AiMessage,
  type AiTextBlock,
  type AiToolResultBlock,
  type AiToolUseBlock,
  type MeshTaskStatus,
} from "@/lib/aiCompanion/protocol";

/** Runs one editor command, the same ones the MCP bridge sends; throws on failure. */
export type CompanionExecute = (action: string, params: Record<string, unknown>) => Promise<unknown>;

type DisplayItem =
  | { kind: "user"; id: string; text: string; images: string[] }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; label: string; state: "running" | "done" | "error"; detail?: string }
  | { kind: "error"; id: string; text: string };

const TOOL_ACTIONS = toolActionsJson as Record<string, string>;
const KEY_STORAGE = "sentire-layer.companion-key";
const MAX_STEPS = 40;
const RESULT_TEXT_LIMIT = 12000;
const PHOTO_EDGE = 1568;
const VIEW_EDGE = 1024;
const KEEP_VIEW_IMAGES = 2;
const MESH_POLL_MS = 5000;
const MESH_TIMEOUT_MS = 8 * 60 * 1000;

let idCounter = 0;
const nextId = () => `c${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function readStoredKey() {
  try {
    return window.localStorage.getItem(KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

function storeKey(value: string) {
  try {
    if (value) window.localStorage.setItem(KEY_STORAGE, value);
    else window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Private windows may refuse storage; the key then lasts for this page only.
  }
}

/** Scales a picture down so its longer side is at most `edge` and returns it as a JPEG data URL. */
async function downscale(source: string, edge: number): Promise<string> {
  const image = new Image();
  image.decoding = "async";
  image.src = source;
  await image.decode();
  const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the picture."));
    reader.readAsDataURL(file);
  });
}

function imageBlock(dataUrl: string): AiImageBlock {
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.*)$/);
  const mediaType = (match?.[1] ?? "image/jpeg") as AiImageBlock["source"]["media_type"];
  return { type: "image", source: { type: "base64", media_type: mediaType, data: match?.[2] ?? "" } };
}

function resultText(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}... (cut, ${text.length} characters)` : text;
}

/** Old viewport pictures are dropped from what is sent again; only the newest few stay. User photos always stay. */
function pruneViewImages(messages: AiMessage[]): AiMessage[] {
  let kept = 0;
  const pruned = [...messages];
  for (let index = pruned.length - 1; index >= 0; index -= 1) {
    const message = pruned[index];
    if (message.role !== "user") continue;
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) return block;
      if (!block.content.some((part) => part.type === "image")) return block;
      kept += 1;
      if (kept <= KEEP_VIEW_IMAGES) return block;
      changed = true;
      return {
        ...block,
        content: block.content.map((part) => (part.type === "image" ? ({ type: "text", text: "[older view picture removed]" } as AiTextBlock) : part)),
      };
    });
    if (changed) pruned[index] = { ...message, content };
  }
  return pruned;
}

function shortToolName(name: string) {
  return name.replace(/^layerling_/, "").replace(/_/g, " ");
}

function toolLabel(block: AiToolUseBlock): string {
  const input = block.input ?? {};
  const named = typeof input.name === "string" && input.name ? ` "${input.name}"` : "";
  switch (block.name) {
    case "layerling_create_shape":
      return `Add ${typeof input.kind === "string" ? input.kind : "shape"}${named}`;
    case "layerling_update_object":
      return "Change a part";
    case "layerling_capture_image":
      return "Look at the design";
    case "layerling_list_objects":
    case "layerling_read_scene":
      return "Read the design";
    case "layerling_group_objects":
      return "Group parts";
    case "layerling_apply_edge_treatment":
      return `${typeof input.kind === "string" ? input.kind : "Round"} edges`;
    case COMPANION_TOOL_HELP:
      return `Look up ${shortToolName(String(input.name ?? "tool"))}`;
    case COMPANION_RUN_TOOL:
      return shortToolName(String(input.name ?? "tool")).replace(/^./, (letter) => letter.toUpperCase());
    case COMPANION_GENERATE_MODEL:
      return input.source === "photo" ? "Generate 3D model from photo" : "Generate 3D model from description";
    default:
      return shortToolName(block.name).replace(/^./, (letter) => letter.toUpperCase());
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Stopped", "AbortError"));
    }, { once: true });
  });

export function AiCompanionPanel({ execute }: { execute: CompanionExecute }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AiCompanionStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [key, setKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [input, setInput] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [tokens, setTokens] = useState({ input: 0, output: 0 });
  const [dragging, setDragging] = useState(false);

  const messagesRef = useRef<AiMessage[]>([]);
  const sentPhotosRef = useRef<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setKey(readStoredKey());
  }, []);

  useEffect(() => {
    if (!open || status) return;
    fetch(AI_COMPANION_ROUTE)
      .then((response) => response.json())
      .then((data: AiCompanionStatus) => setStatus(data))
      .catch(() => setStatusError("Could not reach the server."));
  }, [open, status]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [items, progress]);

  useEffect(() => {
    if (open) window.setTimeout(() => textRef.current?.focus(), 50);
  }, [open]);

  const headers = useCallback(
    (json = true): HeadersInit => ({ ...(json ? { "Content-Type": "application/json" } : {}), ...(key ? { [AI_COMPANION_KEY_HEADER]: key } : {}) }),
    [key],
  );

  const addItem = useCallback((item: DisplayItem) => setItems((current) => [...current, item]), []);
  const patchItem = useCallback(
    (id: string, patch: Partial<DisplayItem>) => setItems((current) => current.map((item) => (item.id === id ? ({ ...item, ...patch } as DisplayItem) : item))),
    [],
  );

  const handleUnauthorized = useCallback(() => {
    storeKey("");
    setKey("");
  }, []);

  /** Asks the server for one turn of the conversation. */
  const askClaude = useCallback(
    async (signal: AbortSignal): Promise<AiChatResponse> => {
      const response = await fetch(AI_COMPANION_ROUTE, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ messages: pruneViewImages(messagesRef.current) }),
        signal,
      });
      const data = (await response.json().catch(() => null)) as (AiChatResponse & { error?: string }) | null;
      if (response.status === 401) handleUnauthorized();
      if (!response.ok || !data?.content) throw new Error(data?.error || `The server answered HTTP ${response.status}.`);
      return data;
    },
    [handleUnauthorized, headers],
  );

  const generateModel = useCallback(
    async (input: Record<string, unknown>, signal: AbortSignal, itemId: string): Promise<unknown> => {
      const source = input.source === "photo" ? "photo" : "text";
      let image: string | undefined;
      if (source === "photo") {
        const number = typeof input.photoNumber === "number" ? input.photoNumber : sentPhotosRef.current.length;
        image = sentPhotosRef.current[number - 1];
        if (!image) throw new Error(`There is no attached photo number ${number}.`);
      }
      const start = await fetch(AI_COMPANION_MESH_ROUTE, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ source, prompt: input.prompt, image }),
        signal,
      });
      const started = (await start.json().catch(() => null)) as { taskId?: string; kind?: string; error?: string } | null;
      if (!start.ok || !started?.taskId) throw new Error(started?.error || `Could not start the generation (HTTP ${start.status}).`);

      const query = `task=${encodeURIComponent(started.taskId)}&kind=${started.kind === "text" ? "text" : "image"}`;
      const deadline = Date.now() + MESH_TIMEOUT_MS;
      for (;;) {
        await sleep(MESH_POLL_MS, signal);
        const poll = await fetch(`${AI_COMPANION_MESH_ROUTE}?${query}`, { headers: headers(false), signal });
        const state = (await poll.json().catch(() => null)) as (MeshTaskStatus & { error?: string }) | null;
        if (!poll.ok || !state) throw new Error(state?.error || `Checking the generation failed (HTTP ${poll.status}).`);
        if (state.status === "SUCCEEDED") break;
        if (state.status === "FAILED" || state.status === "CANCELED") throw new Error(state.error || "The generation failed.");
        patchItem(itemId, { detail: `${Math.round(state.progress)}%` });
        if (Date.now() > deadline) throw new Error("The generation took too long.");
      }

      patchItem(itemId, { detail: "importing" });
      const download = await fetch(`${AI_COMPANION_MESH_ROUTE}?${query}&download=1`, { headers: headers(false), signal });
      const file = (await download.json().catch(() => null)) as { fileName?: string; base64?: string; error?: string } | null;
      if (!download.ok || !file?.base64 || !file.fileName) throw new Error(file?.error || "Could not download the model.");

      const isObj = file.fileName.endsWith(".obj");
      const imported = (await execute("import_file", {
        fileName: file.fileName,
        ...(isObj ? { text: atob(file.base64) } : { base64: file.base64 }),
      })) as { imported?: Array<{ id: string; width?: number; depth?: number; height?: number }> } | null;

      const body = imported?.imported?.[0];
      const notes: string[] = [];
      if (body?.id) {
        // Generated meshes are dense; thinning them keeps the editor quick and cuts possible.
        try {
          await execute("simplify_mesh", { id: body.id, targetTriangles: 60000 });
        } catch {
          notes.push("not simplified");
        }
        const { height, width, depth } = body;
        const targetHeight = typeof input.heightMm === "number" && input.heightMm > 0 ? input.heightMm : 60;
        const patch: Record<string, unknown> = { id: body.id, elevation: 0 };
        if (height && width && depth) {
          const factor = targetHeight / height;
          Object.assign(patch, { width: width * factor, depth: depth * factor, height: targetHeight });
        }
        if (typeof input.name === "string" && input.name) patch.name = input.name;
        if (typeof input.color === "string" && input.color) patch.color = input.color;
        try {
          await execute("update_object", patch);
        } catch (error) {
          notes.push(`resize failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { imported, notes };
    },
    [execute, headers, patchItem],
  );

  /** Runs one tool call from Claude and returns the tool_result block. */
  const runTool = useCallback(
    async (block: AiToolUseBlock, signal: AbortSignal): Promise<AiToolResultBlock> => {
      const itemId = nextId();
      addItem({ kind: "tool", id: itemId, label: toolLabel(block), state: "running" });
      try {
        let value: unknown;
        const input = block.input ?? {};
        if (block.name === COMPANION_TOOL_HELP) {
          const fields = Array.isArray(input.fields) ? input.fields.join(",") : "";
          const response = await fetch(
            `${AI_COMPANION_ROUTE}?help=${encodeURIComponent(String(input.name ?? ""))}&fields=${encodeURIComponent(fields)}`,
            { headers: headers(false), signal },
          );
          const data = (await response.json().catch(() => null)) as { help?: unknown; error?: string } | null;
          if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
          value = data?.help;
        } else if (block.name === COMPANION_GENERATE_MODEL) {
          value = await generateModel(input, signal, itemId);
        } else {
          const name = block.name === COMPANION_RUN_TOOL ? String(input.name ?? "") : block.name;
          const args =
            block.name === COMPANION_RUN_TOOL
              ? ((input.args && typeof input.args === "object" ? input.args : {}) as Record<string, unknown>)
              : input;
          const action = TOOL_ACTIONS[name] ?? TOOL_ACTIONS[`layerling_${name}`];
          if (!action) throw new Error(`There is no editor tool named ${name}.`);
          const { settings, ...rest } = args as Record<string, unknown> & { settings?: unknown };
          const params = settings && typeof settings === "object" ? { ...(settings as Record<string, unknown>), ...rest } : rest;
          value = await execute(action, params);
        }

        patchItem(itemId, { state: "done", detail: undefined });
        const capture = value as { dataUrl?: string; face?: string } | null;
        if (capture && typeof capture.dataUrl === "string" && capture.dataUrl.startsWith("data:image/")) {
          const small = await downscale(capture.dataUrl, VIEW_EDGE);
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: [{ type: "text", text: `View: ${capture.face ?? "current"}` }, imageBlock(small)],
          };
        }
        return { type: "tool_result", tool_use_id: block.id, content: resultText(value) };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        const message = error instanceof Error ? error.message : String(error);
        patchItem(itemId, { state: "error", detail: message.length > 140 ? `${message.slice(0, 137)}...` : message });
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${message}`, is_error: true };
      }
    },
    [addItem, execute, generateModel, headers, patchItem],
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && !photos.length) || busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setInput("");
    const attached = photos;
    setPhotos([]);

    const firstPhoto = sentPhotosRef.current.length + 1;
    sentPhotosRef.current = [...sentPhotosRef.current, ...attached];
    addItem({ kind: "user", id: nextId(), text, images: attached });
    const content: AiContentBlock[] = [];
    attached.forEach((photo, index) => {
      content.push({ type: "text", text: `Photo ${firstPhoto + index}:` }, imageBlock(photo));
    });
    content.push({ type: "text", text: text || "Make this." });
    messagesRef.current = [...messagesRef.current, { role: "user", content }];

    try {
      for (let step = 0; step < MAX_STEPS; step += 1) {
        setProgress("Thinking...");
        const reply = await askClaude(controller.signal);
        setTokens((current) => ({
          input: current.input + (reply.usage?.input_tokens ?? 0) + (reply.usage?.cache_read_input_tokens ?? 0) + (reply.usage?.cache_creation_input_tokens ?? 0),
          output: current.output + (reply.usage?.output_tokens ?? 0),
        }));
        messagesRef.current = [...messagesRef.current, { role: "assistant", content: reply.content }];
        for (const block of reply.content) {
          if (block.type === "text" && block.text.trim()) addItem({ kind: "assistant", id: nextId(), text: block.text.trim() });
        }
        const calls = reply.content.filter((block): block is AiToolUseBlock => block.type === "tool_use");
        if (reply.stop_reason !== "tool_use" || !calls.length) break;
        setProgress("Working...");
        const results: AiToolResultBlock[] = [];
        for (const call of calls) {
          results.push(await runTool(call, controller.signal));
        }
        messagesRef.current = [...messagesRef.current, { role: "user", content: results }];
        if (step === MAX_STEPS - 1) {
          addItem({ kind: "error", id: nextId(), text: "Stopped after many steps. Say \"go on\" to continue." });
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        addItem({ kind: "error", id: nextId(), text: "Stopped." });
      } else {
        addItem({ kind: "error", id: nextId(), text: error instanceof Error ? error.message : String(error) });
      }
      // A conversation that ends on unanswered tool calls cannot be continued; answer them as stopped.
      const last = messagesRef.current[messagesRef.current.length - 1];
      if (last?.role === "assistant") {
        const open = last.content.filter((block): block is AiToolUseBlock => block.type === "tool_use");
        if (open.length) {
          messagesRef.current = [
            ...messagesRef.current,
            { role: "user", content: open.map((block) => ({ type: "tool_result", tool_use_id: block.id, content: "Stopped by the user.", is_error: true })) },
          ];
        }
      } else if (last?.role === "user" && last.content.every((block) => block.type !== "tool_result")) {
        // The question itself never got an answer: take it back so the next one does not follow two user turns.
        messagesRef.current = messagesRef.current.slice(0, -1);
      }
    } finally {
      setBusy(false);
      setProgress("");
      abortRef.current = null;
    }
  }, [addItem, askClaude, busy, input, photos, runTool]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    messagesRef.current = [];
    sentPhotosRef.current = [];
    setItems([]);
    setTokens({ input: 0, output: 0 });
  }, []);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const pictures = Array.from(files).filter((file) => file.type.startsWith("image/")).slice(0, 4);
    const prepared: string[] = [];
    for (const file of pictures) {
      try {
        prepared.push(await downscale(await fileToDataUrl(file), PHOTO_EDGE));
      } catch {
        // A file the browser cannot draw is skipped.
      }
    }
    if (prepared.length) setPhotos((current) => [...current, ...prepared].slice(0, 4));
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
  };

  const saveKey = () => {
    const value = keyDraft.trim();
    storeKey(value);
    setKey(value);
    setKeyDraft("");
  };

  const needsKey = Boolean(status?.needsKey && !key);

  return (
    <>
      {!open ? (
        <button className="ai-companion-launcher" type="button" onClick={() => setOpen(true)} title="Design companion (AI)">
          <Sparkles size={18} strokeWidth={2.2} aria-hidden="true" />
          <span>Ask AI</span>
        </button>
      ) : null}
      {open ? (
        <aside
          className={`ai-companion-panel${dragging ? " is-dragging" : ""}`}
          aria-label="Design companion"
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <header className="ai-companion-header">
            <Sparkles size={16} strokeWidth={2.2} aria-hidden="true" />
            <strong>Design companion</strong>
            <span className="ai-companion-spacer" />
            <button type="button" className="ai-companion-icon" onClick={reset} title="New conversation" disabled={!items.length}>
              <RotateCcw size={15} aria-hidden="true" />
            </button>
            <button type="button" className="ai-companion-icon" onClick={() => setOpen(false)} title="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </header>

          {statusError ? <p className="ai-companion-note">{statusError}</p> : null}
          {status && !status.configured ? (
            <p className="ai-companion-note">
              The AI companion is not set up on this server yet. The administrator needs to set ANTHROPIC_API_KEY and AI_COMPANION_PASSWORD.
            </p>
          ) : null}

          {status?.configured && needsKey ? (
            <form
              className="ai-companion-key"
              onSubmit={(event) => {
                event.preventDefault();
                saveKey();
              }}
            >
              <label htmlFor="ai-companion-key">Companion password</label>
              <input
                id="ai-companion-key"
                type="password"
                autoComplete="current-password"
                value={keyDraft}
                onChange={(event) => setKeyDraft(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />
              <button type="submit" disabled={!keyDraft.trim()}>
                Unlock
              </button>
            </form>
          ) : null}

          {status?.configured && !needsKey ? (
            <>
              <div className="ai-companion-messages" ref={listRef}>
                {!items.length ? (
                  <div className="ai-companion-empty">
                    <p>Describe what you want to print, or drop in a photo of it.</p>
                    <ul>
                      {[
                        "A phone stand for a 75 mm wide phone, tilted back 15°",
                        "A name tag that says MEJIE with a keyring hole",
                        "A box 80 × 50 × 30 mm with a lid",
                      ].map((example) => (
                        <li key={example}>
                          <button type="button" onClick={() => setInput(example)}>
                            {example}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {!status.meshConfigured ? <p className="ai-companion-hint">Photo-to-mesh generation is off (no MESHY_API_KEY); photos are rebuilt from shapes.</p> : null}
                  </div>
                ) : null}
                {items.map((item) => {
                  if (item.kind === "user") {
                    return (
                      <div key={item.id} className="ai-companion-msg is-user">
                        {item.images.length ? (
                          <div className="ai-companion-thumbs">
                            {item.images.map((src, index) => (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img key={index} src={src} alt={`Photo ${index + 1}`} />
                            ))}
                          </div>
                        ) : null}
                        {item.text ? <p>{item.text}</p> : null}
                      </div>
                    );
                  }
                  if (item.kind === "assistant") {
                    return (
                      <div key={item.id} className="ai-companion-msg is-assistant">
                        <p>{item.text}</p>
                      </div>
                    );
                  }
                  if (item.kind === "tool") {
                    return (
                      <div key={item.id} className={`ai-companion-step is-${item.state}`}>
                        {item.state === "running" ? (
                          <Loader2 size={13} className="ai-companion-spin" aria-hidden="true" />
                        ) : item.state === "done" ? (
                          <Check size={13} aria-hidden="true" />
                        ) : (
                          <AlertTriangle size={13} aria-hidden="true" />
                        )}
                        <span>{item.label}</span>
                        {item.detail ? <em>{item.detail}</em> : null}
                      </div>
                    );
                  }
                  return (
                    <div key={item.id} className="ai-companion-msg is-error">
                      <p>{item.text}</p>
                    </div>
                  );
                })}
                {progress ? (
                  <div className="ai-companion-progress">
                    <Loader2 size={13} className="ai-companion-spin" aria-hidden="true" />
                    {progress}
                  </div>
                ) : null}
              </div>

              <div className="ai-companion-compose">
                {photos.length ? (
                  <div className="ai-companion-thumbs is-pending">
                    {photos.map((src, index) => (
                      <span key={index}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt={`Attached photo ${index + 1}`} />
                        <button type="button" onClick={() => setPhotos((current) => current.filter((_, i) => i !== index))} title="Remove photo">
                          <X size={11} aria-hidden="true" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <textarea
                  ref={textRef}
                  value={input}
                  rows={3}
                  placeholder="Describe a part, or attach a photo…"
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                />
                <div className="ai-companion-actions">
                  <button type="button" className="ai-companion-icon" onClick={() => fileRef.current?.click()} title="Attach a photo" disabled={busy}>
                    <ImagePlus size={17} aria-hidden="true" />
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(event) => {
                      if (event.target.files) void addFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <span className="ai-companion-usage" title="Tokens used in this conversation (input / output)">
                    {tokens.input || tokens.output ? `${Math.round(tokens.input / 1000)}k / ${Math.round(tokens.output / 1000)}k tokens` : status.model}
                  </span>
                  {busy ? (
                    <button type="button" className="ai-companion-send is-stop" onClick={stop} title="Stop">
                      <Square size={14} aria-hidden="true" />
                      Stop
                    </button>
                  ) : (
                    <button type="button" className="ai-companion-send" onClick={() => void send()} disabled={!input.trim() && !photos.length} title="Send (Enter)">
                      <Send size={14} aria-hidden="true" />
                      Send
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </aside>
      ) : null}
    </>
  );
}
