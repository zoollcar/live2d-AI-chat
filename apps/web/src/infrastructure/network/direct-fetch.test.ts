import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIRECT_CORS_GUIDANCE,
  directCorsAwareFetch,
  isDirectCorsGuidanceError,
} from "./direct-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("direct CORS guidance", () => {
  it("turns browser network TypeErrors into an explicit Extension transport action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const request = directCorsAwareFetch("https://api.example.com/v1/models");
    await expect(request).rejects.toThrow(DIRECT_CORS_GUIDANCE);
    await request.catch((error) => expect(isDirectCorsGuidanceError(error)).toBe(true));
  });

  it("does not rewrite provider HTTP or application failures", async () => {
    const upstream = new Error("Provider rejected the request");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(upstream));

    await expect(directCorsAwareFetch("https://api.example.com")).rejects.toBe(upstream);
  });
});
