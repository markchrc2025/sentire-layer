// Builds the tool catalog the in-app AI companion uses.
//
// The MCP bridge (scripts/layerling-mcp-tools.mjs and scripts/layerling-mcp-server.mjs) already describes every
// editor command an agent can run. The companion runs those same commands inside the browser, so it reuses that
// description instead of keeping a second copy. This script writes two files:
//
//   apps/web/src/lib/aiCompanion/toolCatalog.generated.json  every tool with its action and full schema (server only)
//   apps/web/src/lib/aiCompanion/toolActions.generated.json  tool name -> editor action (small, used in the browser)
//
// Run with `npm run ai:catalog`; predev and prebuild run it too.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { tools } = await import(resolve(root, "scripts/layerling-mcp-tools.mjs"));
const serverSource = await readFile(resolve(root, "scripts/layerling-mcp-server.mjs"), "utf8");

// Tools that only make sense for an outside MCP client: finding or opening editor tabs, waiting for notes,
// writing files to a path on the server, or wiping history. The companion leaves them out.
const EXCLUDED = new Set([
  "layerling_list_editors",
  "layerling_open_editor",
  "layerling_wait_for_notes",
  "layerling_save_project",
  "layerling_export_mesh",
  "layerling_clear_history",
  "layerling_delete_history_steps",
  "layerling_open_backup",
]);

// The editor-target fields every bridge tool carries; inside the editor there is only one editor.
const TARGET_FIELDS = new Set(["editorNumber", "editorId", "timeoutMs"]);

const actionByName = new Map();
// Each `case "layerling_x":` up to the next case; the first bridgeCommand("action") inside it is the action.
for (const chunk of serverSource.split(/(?=case "layerling_)/)) {
  const name = chunk.match(/^case "(layerling_[a-z_]+)":/)?.[1];
  const action = chunk.match(/bridgeCommand\("([a-z_]+)"/)?.[1];
  if (name && action && !actionByName.has(name)) actionByName.set(name, action);
}

function stripTarget(schema) {
  const properties = Object.fromEntries(Object.entries(schema?.properties ?? {}).filter(([key]) => !TARGET_FIELDS.has(key)));
  const required = (schema?.required ?? []).filter((key) => !TARGET_FIELDS.has(key));
  return { ...schema, type: "object", properties, ...(required.length ? { required } : { required: undefined }) };
}

const catalog = [];
const missing = [];
for (const tool of tools) {
  if (EXCLUDED.has(tool.name)) continue;
  const action = actionByName.get(tool.name);
  if (!action) {
    missing.push(tool.name);
    continue;
  }
  catalog.push({ name: tool.name, action, description: tool.description, inputSchema: stripTarget(tool.inputSchema) });
}

if (missing.length) {
  console.warn(`ai:catalog: no editor action found for ${missing.join(", ")}; left out.`);
}

const outDir = resolve(root, "apps/web/src/lib/aiCompanion");
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "toolCatalog.generated.json"), `${JSON.stringify({ tools: catalog })}\n`);
await writeFile(
  resolve(outDir, "toolActions.generated.json"),
  `${JSON.stringify(Object.fromEntries(catalog.map((tool) => [tool.name, tool.action])), null, 2)}\n`,
);
console.log(`ai:catalog: ${catalog.length} tools written.`);
