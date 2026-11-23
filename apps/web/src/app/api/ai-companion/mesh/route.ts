import { NextResponse } from "next/server";
import type { MeshStartRequest, MeshTaskStatus } from "@/lib/aiCompanion/protocol";
import { checkCompanionAccess, meshyApiKey } from "@/lib/aiCompanion/server";

export const dynamic = "force-dynamic";
export const revalidate = false;
export const maxDuration = 120;

const MESHY = "https://api.meshy.ai/openapi";
const IMAGE_LIMIT = 12 * 1024 * 1024; // a data URL of a phone photo, already scaled down by the panel
const DOWNLOAD_LIMIT = 80 * 1024 * 1024;

function meshyModel() {
  return (process.env.MESHY_AI_MODEL || "").trim() || "latest";
}

function endpoint(kind: "image" | "text") {
  return kind === "image" ? `${MESHY}/v1/image-to-3d` : `${MESHY}/v2/text-to-3d`;
}

function denied(request: Request) {
  const blocked = checkCompanionAccess(request);
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  if (!meshyApiKey()) return NextResponse.json({ error: "Image-to-3D is not set up on this server (MESHY_API_KEY)." }, { status: 503 });
  return null;
}

async function meshy(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${meshyApiKey()}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { response, payload };
}

function meshyError(payload: Record<string, unknown> | null, status: number) {
  const message = typeof payload?.message === "string" ? payload.message : `Meshy answered HTTP ${status}.`;
  return status === 402 ? `Meshy: not enough credits. ${message}` : `Meshy: ${message}`;
}

/** POST { source, prompt?, image? }: starts a generation and answers { taskId, kind }. */
export async function POST(request: Request) {
  const blocked = denied(request);
  if (blocked) return blocked;
  const body = (await request.json().catch(() => null)) as MeshStartRequest | null;
  const kind = body?.source === "photo" ? "image" : body?.source === "text" ? "text" : null;
  if (!kind) return NextResponse.json({ error: "source must be photo or text." }, { status: 400 });

  let attempts: Record<string, unknown>[];
  if (kind === "image") {
    const image = typeof body?.image === "string" ? body.image : "";
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(image) || image.length > IMAGE_LIMIT) {
      return NextResponse.json({ error: "Attach a PNG, JPEG or WebP photo." }, { status: 400 });
    }
    const base = { image_url: image, ai_model: meshyModel(), should_texture: false, target_formats: ["stl"] };
    // Remeshing keeps the triangle count reasonable for the editor; if this model refuses it, try without.
    attempts = [{ ...base, should_remesh: true, target_polycount: 60000 }, base, { image_url: image, should_texture: false }];
  } else {
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 600) : "";
    if (!prompt) return NextResponse.json({ error: "Give a description to generate from." }, { status: 400 });
    const base = { mode: "preview", prompt, ai_model: meshyModel(), target_formats: ["stl"] };
    attempts = [{ ...base, should_remesh: true, target_polycount: 60000 }, base, { mode: "preview", prompt }];
  }

  let lastError = "";
  for (const attempt of attempts) {
    const { response, payload } = await meshy(endpoint(kind), { method: "POST", body: JSON.stringify(attempt) });
    if (response.ok && typeof payload?.result === "string") {
      return NextResponse.json({ taskId: payload.result, kind });
    }
    lastError = meshyError(payload, response.status);
    // Only a refused request is worth another try with fewer options; credits, keys and limits are not.
    if (response.status !== 400 && response.status !== 422) {
      return NextResponse.json({ error: lastError }, { status: response.status === 402 || response.status === 429 ? response.status : 502 });
    }
  }
  return NextResponse.json({ error: lastError }, { status: 502 });
}

/**
 * GET ?task=<id>&kind=image|text: the task's status and progress.
 * GET ?task=<id>&kind=...&download=1: the finished model as { fileName, base64 }.
 */
export async function GET(request: Request) {
  const blocked = denied(request);
  if (blocked) return blocked;
  const url = new URL(request.url);
  const taskId = url.searchParams.get("task") || "";
  const kind = url.searchParams.get("kind") === "text" ? "text" : "image";
  if (!/^[A-Za-z0-9-]{8,80}$/.test(taskId)) return NextResponse.json({ error: "Unknown task." }, { status: 400 });

  const { response, payload } = await meshy(`${endpoint(kind)}/${taskId}`);
  if (!response.ok || !payload) {
    return NextResponse.json({ error: meshyError(payload, response.status) }, { status: 502 });
  }
  const status = String(payload.status || "PENDING") as MeshTaskStatus["status"];
  const taskError = payload.task_error as { message?: string } | undefined;

  if (url.searchParams.get("download") !== "1") {
    const answer: MeshTaskStatus = {
      taskId,
      kind,
      status,
      progress: typeof payload.progress === "number" ? payload.progress : 0,
      ...(taskError?.message ? { error: taskError.message } : {}),
    };
    return NextResponse.json(answer);
  }

  if (status !== "SUCCEEDED") return NextResponse.json({ error: "The model is not ready yet." }, { status: 409 });
  const urls = (payload.model_urls || {}) as Record<string, string | undefined>;
  const format = urls.stl ? "stl" : urls.obj ? "obj" : null;
  const fileUrl = format ? urls[format] : undefined;
  if (!format || !fileUrl) return NextResponse.json({ error: "Meshy returned no STL or OBJ file." }, { status: 502 });
  let host = "";
  try {
    host = new URL(fileUrl).hostname;
  } catch {
    host = "";
  }
  if (!host.endsWith("meshy.ai")) return NextResponse.json({ error: "Unexpected download address." }, { status: 502 });

  const file = await fetch(fileUrl);
  if (!file.ok) return NextResponse.json({ error: `Download failed (HTTP ${file.status}).` }, { status: 502 });
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > DOWNLOAD_LIMIT) return NextResponse.json({ error: "The generated model is too large." }, { status: 502 });
  return NextResponse.json({ fileName: `generated.${format}`, base64: buffer.toString("base64") });
}
