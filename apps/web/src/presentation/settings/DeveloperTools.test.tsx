// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeveloperTools, type ManualToolDefinition } from "./DeveloperTools";

const tools: ManualToolDefinition[] = [{
  name: "setState",
  description: "Set the character state.",
  category: "scene",
  inputSchema: {
    type: "object",
    properties: { state: { type: "string", enum: ["idle", "happy"] } },
    required: ["state"],
  },
}, {
  name: "listResources",
  description: "List resources.",
  category: "read",
  inputSchema: { type: "object", properties: {} },
}];

afterEach(() => {
  document.body.innerHTML = "";
});

describe("DeveloperTools", () => {
  it("marks the grouped tool selector for readable native optgroup styling", () => {
    const markup = renderToStaticMarkup(createElement(DeveloperTools, {
      tools,
      onInvoke: vi.fn(async () => ({ ok: true })),
    }));

    expect(markup).toContain('class="developer-tool-select"');
    expect(markup).toContain('<optgroup label="Character &amp; stage">');
  });

  it("groups tools and invokes the selected tool with form arguments", async () => {
    const onInvoke = vi.fn(async () => ({ ok: true, state: "happy" }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<DeveloperTools tools={tools} onInvoke={onInvoke} />));

    const details = container.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    const state = container.querySelector("select:not([value='setState'])") as HTMLSelectElement;
    await act(async () => {
      state.value = "happy";
      state.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const run = [...container.querySelectorAll("button")].find((button) => button.textContent === "Run setState")!;
    await act(async () => run.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onInvoke).toHaveBeenCalledWith("setState", { state: "happy" });
    expect(container.textContent).toContain('"state": "happy"');
    await act(async () => root.unmount());
  });

  it("shows validation and execution failures without closing the console", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<DeveloperTools tools={tools} onInvoke={async () => { throw new Error("Rejected input"); }} />));
    const run = [...container.querySelectorAll("button")].find((button) => button.textContent === "Run setState")!;
    await act(async () => run.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Rejected input");
    await act(async () => root.unmount());
  });
});
