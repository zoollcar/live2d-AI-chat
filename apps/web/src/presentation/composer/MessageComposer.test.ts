// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractComposerUrls, MessageComposer, type ComposerAttachment } from "./MessageComposer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function renderComposer(attachments: ComposerAttachment[], value = "", onSubmit = vi.fn()) {
  await act(async () => root.render(createElement(MessageComposer, {
    value,
    attachments,
    listening: false,
    running: false,
    sceneReady: true,
    onChange: vi.fn(),
    onFiles: vi.fn(),
    onRecognizedUrls: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onMic: vi.fn(),
    onStop: vi.fn(),
    onSubmit,
  })));
  return onSubmit;
}

function sendButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === "Send");
  if (!(button instanceof HTMLButtonElement)) throw new Error("Send button not found.");
  return button;
}

describe("MessageComposer", () => {
  it("recognizes and de-duplicates public HTTP links without treating punctuation as part of the URL", () => {
    expect(extractComposerUrls("See https://example.com/a, then https://example.com/a and http://news.example/b)."))
      .toEqual(["https://example.com/a", "http://news.example/b"]);
  });

  it("allows an attachment-only turn once processing finishes", async () => {
    const onSubmit = await renderComposer([{
      id: "resource-1",
      kind: "pdf",
      name: "notes.pdf",
      mediaType: "application/pdf",
      size: 10,
      status: "ready",
    }]);

    await act(async () => sendButton().click());
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("holds Send while an uploaded attachment is still processing", async () => {
    await renderComposer([{
      id: "resource-1",
      kind: "pdf",
      name: "notes.pdf",
      mediaType: "application/pdf",
      size: 0,
      status: "processing",
    }], "ready text");

    expect(sendButton().disabled).toBe(true);
  });

  it("allows a processing web or video resource to be sent while the provider continues in the background", async () => {
    const onSubmit = await renderComposer([{
      id: "resource-1",
      kind: "video-transcript",
      name: "video transcript",
      mediaType: "text/plain",
      size: 0,
      status: "processing",
    }]);

    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
