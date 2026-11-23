import { timingSafeEqual } from "node:crypto";
import catalogJson from "./toolCatalog.generated.json";
import {
  AI_COMPANION_KEY_HEADER,
  COMPANION_GENERATE_MODEL,
  COMPANION_RUN_TOOL,
  COMPANION_TOOL_HELP,
  type AiCompanionStatus,
} from "./protocol";

type CatalogTool = { name: string; action: string; description: string; inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] } };
type ClaudeTool = { name: string; description: string; input_schema: Record<string, unknown>; cache_control?: { type: "ephemeral" } };

const catalog = (catalogJson as { tools: CatalogTool[] }).tools;
const catalogByName = new Map(catalog.map((tool) => [tool.name, tool]));

export const DEFAULT_MODEL = "claude-sonnet-5-5";

export function companionModel() {
  return (process.env.AI_COMPANION_MODEL || "").trim() || DEFAULT_MODEL;
}

function anthropicKey() {
  return (process.env.ANTHROPIC_API_KEY || "").trim();
}

function meshyKey() {
  return (process.env.MESHY_API_KEY || "").trim();
}

function companionPassword() {
  return (process.env.AI_COMPANION_PASSWORD || "").trim();
}

export function companionStatus(): AiCompanionStatus {
  const production = process.env.NODE_ENV === "production";
  return {
    // In production the companion needs a password as well as the key: every message costs money.
    configured: Boolean(anthropicKey()) && (!production || Boolean(companionPassword())),
    meshConfigured: Boolean(meshyKey()),
    needsKey: Boolean(companionPassword()),
    model: companionModel(),
  };
}

export function anthropicApiKey() {
  return anthropicKey();
}

export function meshyApiKey() {
  return meshyKey();
}

/** Checks the companion password sent by the panel. Returns an error message, or null when the request may go on. */
export function checkCompanionAccess(request: Request): { status: number; error: string } | null {
  const status = companionStatus();
  if (!status.configured) {
    return { status: 503, error: "The AI companion is not set up on this server (ANTHROPIC_API_KEY and AI_COMPANION_PASSWORD)." };
  }
  const expected = companionPassword();
  if (!expected) return null;
  const given = (request.headers.get(AI_COMPANION_KEY_HEADER) || "").trim();
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: 401, error: "Wrong companion password." };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Tools

/** Tools sent to Claude with their full schema on every turn: the everyday ones, all small. */
const CORE_FULL = [
  "layerling_list_objects",
  "layerling_read_scene",
  "layerling_select_objects",
  "layerling_delete_objects",
  "layerling_group_objects",
  "layerling_ungroup_objects",
  "layerling_align_objects",
  "layerling_scale_objects",
  "layerling_array_objects",
  "layerling_list_edges",
  "layerling_apply_edge_treatment",
  "layerling_hollow_object",
  "layerling_inspect_errors",
  "layerling_capture_image",
];

/** The shape fields sent with create and update every turn; everything else goes through `settings`. */
const SHAPE_FIELDS = [
  "name", "color", "x", "z", "elevation", "width", "depth", "height", "rotation", "rotationX", "rotationZ",
  "sides", "topRadius", "baseRadius", "bevel", "text", "font", "cornerFillet",
];

const POSITION_HELP: Record<string, string> = {
  x: "Position of the body's centre along X (left/right), mm.",
  z: "Position of the body's centre along Z (+z towards the front, -z towards the back), mm.",
  elevation: "Height of the body's bottom above the plate, mm. 0 stands on the plate.",
  width: "Size along X, mm.",
  depth: "Size along Z, mm.",
  height: "Size upward, mm.",
  rotation: "Turn about the vertical axis, degrees.",
  rotationX: "Tilt about the X axis, degrees.",
  rotationZ: "Tilt about the Z axis, degrees.",
  color: "Colour as #rrggbb.",
};

function pickProperties(source: CatalogTool | undefined, fields: string[]) {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    const base = (source?.inputSchema.properties?.[field] ?? { type: "string" }) as Record<string, unknown>;
    properties[field] = POSITION_HELP[field] ? { ...base, description: POSITION_HELP[field] } : base;
  }
  return properties;
}

const SETTINGS_FIELD = {
  type: "object",
  additionalProperties: true,
  description:
    "Any other setting of the shape by its exact field name (threads, gears, Gridfinity, hinges, springs, text options, vase, ports ...). Look the names up first with tool_help.",
};

function slimCreateShape(): ClaudeTool {
  const full = catalogByName.get("layerling_create_shape");
  const kind = full?.inputSchema.properties?.kind ?? { type: "string" };
  return {
    name: "layerling_create_shape",
    description:
      `${full?.description ?? "Create a shape."} Only the everyday fields are listed here; pass any other field in settings (look them up with tool_help). Set hole: true to make the shape a cutter (a hole) that removes material once grouped with solids. Returns the new object with its id.`,
    input_schema: {
      type: "object",
      properties: {
        kind,
        hole: { type: "boolean", description: "true makes it a hole (cutter), false or left out a solid." },
        ...pickProperties(full, SHAPE_FIELDS),
        settings: SETTINGS_FIELD,
      },
      required: ["kind"],
    },
  };
}

function slimUpdateObject(): ClaudeTool {
  const full = catalogByName.get("layerling_update_object");
  return {
    name: "layerling_update_object",
    description:
      "Change an existing object by id: position, size, rotation, colour, name, solid/hole and any shape setting. Only the everyday fields are listed; pass others in settings (look them up with tool_help, name layerling_update_object).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The object's id from layerling_list_objects." },
        hole: { type: "boolean", description: "true makes it a hole (cutter), false a solid." },
        ...pickProperties(full, SHAPE_FIELDS),
        settings: SETTINGS_FIELD,
      },
      required: ["id"],
    },
  };
}

function firstSentence(text: string) {
  const sentence = text.split(/(?<=\.)\s/)[0] ?? text;
  return sentence.length > 170 ? `${sentence.slice(0, 167)}...` : sentence;
}

function runToolTool(): ClaudeTool {
  const listed = new Set([...CORE_FULL, "layerling_create_shape", "layerling_update_object"]);
  const index = catalog
    .filter((tool) => !listed.has(tool.name))
    .map((tool) => `- ${tool.name}: ${firstSentence(tool.description)}`)
    .join("\n");
  return {
    name: COMPANION_RUN_TOOL,
    description:
      "Run any other editor tool by name. Call tool_help first to see its fields, then pass them in args.\nAvailable tools:\n" + index,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The tool's name, for example layerling_make_lid." },
        args: { type: "object", additionalProperties: true, description: "The tool's fields, as tool_help lists them." },
      },
      required: ["name"],
    },
  };
}

function toolHelpTool(): ClaudeTool {
  return {
    name: COMPANION_TOOL_HELP,
    description:
      "Read the full description and fields of an editor tool (any layerling_* tool, including create_shape and update_object). Without `fields` it lists every field with a short description; with `fields` it gives those fields in full.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        fields: { type: "array", items: { type: "string" }, description: "Field names to describe in full." },
      },
      required: ["name"],
    },
  };
}

function generateModelTool(): ClaudeTool {
  return {
    name: COMPANION_GENERATE_MODEL,
    description:
      "Generate a 3D mesh with an image-to-3D / text-to-3D service (Meshy) and import it into the design. Use it for organic, sculpted things that basic shapes cannot make well: animals, figurines, characters, faces, plants, food, ornate decorations. Do NOT use it for functional or geometric parts (boxes, holders, brackets, signs, cases, cookie cutters): build those from shapes. It takes 1 to 4 minutes and costs credits, so confirm the choice in your reply first unless the user clearly asked for it. Prefer source photo when the user attached a photo of the object.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["photo", "text"], description: "photo: from one of the user's attached photos; text: from a description." },
        photoNumber: { type: "number", description: "With source photo: which attached photo, counting from 1 in the order the user sent them." },
        prompt: { type: "string", description: "With source text: a short, concrete description of the object (shape, pose, style). English." },
        heightMm: { type: "number", description: "Bring the imported model to this height in mm, keeping its proportions. Default 60." },
        name: { type: "string", description: "Name for the imported body." },
        color: { type: "string", description: "Colour as #rrggbb." },
      },
      required: ["source"],
    },
  };
}

let cachedTools: ClaudeTool[] | null = null;

export function companionTools(meshEnabled: boolean): ClaudeTool[] {
  if (!cachedTools) {
    const core = CORE_FULL.map((name) => catalogByName.get(name)).filter((tool): tool is CatalogTool => Boolean(tool));
    cachedTools = [
      slimCreateShape(),
      slimUpdateObject(),
      ...core.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema as Record<string, unknown> })),
      toolHelpTool(),
      runToolTool(),
    ];
  }
  const tools = meshEnabled ? [...cachedTools, generateModelTool()] : [...cachedTools];
  // The tools never change between turns, so they are cached with the system prompt.
  tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: "ephemeral" } };
  return tools;
}

const HELP_LIMIT = 24000;

/** The answer to tool_help: the tool's description and its fields, short or in full. */
export function toolHelp(name: string, fields?: string[]) {
  const tool = catalogByName.get(name) ?? catalogByName.get(`layerling_${name}`);
  if (!tool) {
    return { error: `No tool named ${name}.`, tools: catalog.map((entry) => entry.name) };
  }
  const properties = tool.inputSchema.properties ?? {};
  if (fields?.length) {
    const picked = Object.fromEntries(fields.map((field) => [field, properties[field] ?? "(no such field)"]));
    return { name: tool.name, fields: picked, required: tool.inputSchema.required ?? [] };
  }
  let text = JSON.stringify({ name: tool.name, description: tool.description, required: tool.inputSchema.required ?? [] });
  const summary: Record<string, string> = {};
  for (const [field, schema] of Object.entries(properties)) {
    const entry = schema as { type?: string; enum?: unknown[]; description?: string };
    const kind = entry.enum ? `one of ${entry.enum.slice(0, 12).join("|")}${entry.enum.length > 12 ? "|..." : ""}` : entry.type ?? "value";
    const description = entry.description ? ` - ${entry.description.length > 160 ? `${entry.description.slice(0, 157)}...` : entry.description}` : "";
    summary[field] = `${kind}${description}`;
  }
  text = JSON.stringify({ name: tool.name, description: tool.description, required: tool.inputSchema.required ?? [], fields: summary });
  if (text.length > HELP_LIMIT) {
    text = `${text.slice(0, HELP_LIMIT)}... (cut; ask for specific fields)`;
  }
  return text;
}

export function catalogAction(name: string) {
  return catalogByName.get(name)?.action ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// System prompt

export const COMPANION_SYSTEM_PROMPT = `You are the design companion built into Sentire Layer, a browser CAD app for 3D printing (based on layerling, which works like Tinkercad with extra tools). You sit in a side panel next to the user's design and build parts directly in their editor with your tools, while they watch.

The user is a beginner. They describe what they want in plain words, or attach a photo, and you make it.

How the editor works
- Units are millimetres. The build plate is flat; X runs left to right, Z runs back (-) to front (+), and up is "elevation". x and z place a body's centre; elevation is how high its bottom sits above the plate (0 = standing on the plate). width is along X, depth along Z, height upward.
- Everything is made from shapes: solids add material, holes (hole: true) take it away once grouped with solids. Group solids and holes with layerling_group_objects to get the final part. Edges can then be rounded or chamfered (layerling_list_edges + layerling_apply_edge_treatment), bodies hollowed, arrayed, aligned and so on.
- Many ready-made parametric shapes exist (text, threads, screws, nuts, gears, hinges, Gridfinity bins, springs, vases, ports, screw bosses, snap fits...). Their extra fields go in settings; use tool_help to look them up before using them. Use run_tool for any tool not listed directly (lids, molds, textures, cookie cutters, hole patterns, paint, QR codes...).
- Read back with layerling_list_objects after you build, and use the real ids it returns. Never invent ids.

How to work
1. Decide what the object is and how it will be used. If one measurement decides whether it fits (the phone it holds, the screw it takes), and the user did not give it, make a sensible standard guess, say what you assumed, and offer to change it. Ask a question first only when a guess would waste their time.
2. Choose the approach:
   - Functional or geometric objects (holders, boxes, cases, brackets, hooks, signs, tags, organisers, replacement parts, cookie cutters, anything with straight walls or exact sizes): build them from shapes so they stay editable and print well.
   - Organic or sculpted objects (animals, figurines, characters, faces, plants, food, ornate decoration): use generate_3d_model when it is available. Combining is fine: a generated figurine on a box-shaped base with a name in text.
3. From a photo: identify the object, estimate its proportions from the picture, pick realistic real-world sizes, and rebuild it from shapes (or generate it, if organic). Say briefly what you recognised.
4. Build step by step: a few shapes, then group, then refine. Keep names meaningful ("Base", "Phone slot").
5. Check your work: call layerling_capture_image (face "home" or a useful angle) after the main steps and look at it. Fix what is wrong before you say you are done.
6. Design for FDM printing: flat bottom on the plate, walls at least 1.6 mm, avoid overhangs steeper than 45 degrees or note that supports are needed, 0.2-0.4 mm clearance between parts that fit together, holes for screws slightly larger than the screw.

How to talk
- Short, plain and friendly. No jargon unless you explain it in a few words. After building, give a 1-3 line summary: what you made, its main sizes, and one useful next step ("Want me to round the edges?").
- Do not describe every tool call; the user sees the steps in the panel.
- If a tool fails, read the error, try another way, and tell the user plainly if something could not be done. Never claim something is done when the tool said otherwise.
- Work on the user's current design. Do not delete objects you did not make unless the user asks.`;
