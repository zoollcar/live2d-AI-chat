import { ResourceError } from "./errors";

export async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new ResourceError("storage_failed", "This browser cannot calculate resource integrity hashes.");
  }
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return `sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function sha256Blob(blob: Blob): Promise<string> {
  return sha256(new Uint8Array(await blob.arrayBuffer()));
}
