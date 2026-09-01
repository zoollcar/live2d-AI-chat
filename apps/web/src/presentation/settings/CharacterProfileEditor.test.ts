// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CharacterProfileEditor } from "./CharacterProfileEditor";

describe("CharacterProfileEditor", () => {
  it("uses form controls for editing and reserves JSON for import and export", () => {
    const markup = renderToStaticMarkup(createElement(CharacterProfileEditor, {
      onActivateProfile: vi.fn(async () => undefined),
      onClose: vi.fn(),
    }));

    expect(markup).toContain("Personality");
    expect(markup).toContain("Default decorations");
    expect(markup).toContain("Enabled tools");
    expect(markup).toContain("Close stage content");
    expect(markup).not.toContain("Profile JSON");
  });
});
