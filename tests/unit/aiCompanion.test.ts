import { afterEach, describe, expect, it } from "vitest";
import actions from "../../apps/web/src/lib/aiCompanion/toolActions.generated.json";
import { AI_COMPANION_KEY_HEADER } from "../../apps/web/src/lib/aiCompanion/protocol";
import { catalogAction, checkCompanionAccess, companionStatus, companionTools, toolHelp } from "../../apps/web/src/lib/aiCompanion/server";

const env = { ...process.env };

afterEach(() => {
  process.env = { ...env };
});

describe("AI companion tool catalog", () => {
  it("maps the bridge tools to the editor actions the MCP server uses", () => {
    expect(catalogAction("layerling_read_scene")).toBe("get_scene");
    expect(catalogAction("layerling_paint")).toBe("paint_object");
    expect(catalogAction("layerling_create_shape")).toBe("create_shape");
    expect((actions as Record<string, string>).layerling_capture_image).toBe("capture_image");
    // Tools for outside clients only stay out.
    expect(catalogAction("layerling_list_editors")).toBeNull();
    expect(catalogAction("layerling_save_project")).toBeNull();
  });

  it("sends a compact, unique tool list with the cache mark on the last tool", () => {
    const tools = companionTools(true);
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("generate_3d_model");
    expect(companionTools(false).map((tool) => tool.name)).not.toContain("generate_3d_model");
    expect(tools[tools.length - 1].cache_control).toEqual({ type: "ephemeral" });
    expect(tools.slice(0, -1).every((tool) => !tool.cache_control)).toBe(true);
    // Every direct editor tool has an action the panel can run.
    for (const name of names.filter((entry) => entry.startsWith("layerling_"))) {
      expect((actions as Record<string, string>)[name], name).toBeTruthy();
    }
    // The full create_shape schema is ~100 KB; the companion's must stay small.
    expect(JSON.stringify(tools).length).toBeLessThan(80000);
  });

  it("describes a tool's fields on request", () => {
    const summary = toolHelp("layerling_create_shape");
    expect(typeof summary).toBe("string");
    expect(String(summary)).toContain("threadSize");
    const picked = toolHelp("create_shape", ["threadSize"]) as { fields: Record<string, unknown> };
    expect(picked.fields.threadSize).toBeTruthy();
    expect(toolHelp("layerling_nope")).toHaveProperty("error");
  });
});

describe("AI companion access", () => {
  const request = (key?: string) => new Request("http://localhost/api/ai-companion", { headers: key ? { [AI_COMPANION_KEY_HEADER]: key } : {} });

  it("is off without an API key", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(companionStatus().configured).toBe(false);
    expect(checkCompanionAccess(request())?.status).toBe(503);
  });

  it("needs the password when one is set", () => {
    process.env.ANTHROPIC_API_KEY = "test";
    process.env.AI_COMPANION_PASSWORD = "secret";
    expect(companionStatus()).toMatchObject({ configured: true, needsKey: true });
    expect(checkCompanionAccess(request())?.status).toBe(401);
    expect(checkCompanionAccess(request("wrong"))?.status).toBe(401);
    expect(checkCompanionAccess(request("secret"))).toBeNull();
  });

  it("refuses to run in production without a password", () => {
    process.env.ANTHROPIC_API_KEY = "test";
    delete process.env.AI_COMPANION_PASSWORD;
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(companionStatus().configured).toBe(false);
  });
});
