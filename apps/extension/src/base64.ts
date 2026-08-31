import { BRIDGE_CHUNK_BYTES, type BridgeProtocolMessage } from "@live2d-chat/shared";

type BodyChunkMessage = Extract<BridgeProtocolMessage, { type: "body-chunk" }>;

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const sliceSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += sliceSize) {
    const slice = bytes.subarray(offset, Math.min(offset + sliceSize, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  if (!BASE64_PATTERN.test(value)) {
    throw new Error("Chunk is not valid base64.");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function decodeBodyChunk(message: BodyChunkMessage): Uint8Array {
  const bytes = message.encoding === "base64"
    ? decodeBase64(message.data)
    : new TextEncoder().encode(message.data);
  if (bytes.byteLength > BRIDGE_CHUNK_BYTES) {
    throw new Error(`Chunk exceeds the ${BRIDGE_CHUNK_BYTES}-byte protocol limit.`);
  }
  return bytes;
}
