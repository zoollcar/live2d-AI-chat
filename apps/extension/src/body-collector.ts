import type { BridgeProtocolMessage } from "@live2d-chat/shared";
import { decodeBodyChunk } from "./base64";
import { MAX_TRANSFER_BYTES } from "./constants";

type RequestStartMessage = Extract<BridgeProtocolMessage, { type: "request-start" }>;
type BodyChunkMessage = Extract<BridgeProtocolMessage, { type: "body-chunk" }>;

export class RequestBodyCollector {
  readonly #start: RequestStartMessage;
  readonly #chunks: Uint8Array[] = [];
  #expectedSequence = 0;
  #receivedBytes = 0;
  #finished = false;

  constructor(start: RequestStartMessage) {
    this.#start = start;
    if ((start.totalBytes ?? 0) > MAX_TRANSFER_BYTES) {
      throw new Error("Request body exceeds the extension transfer limit.");
    }
    if (start.bodyKind === "none" && (start.totalBytes ?? 0) !== 0) {
      throw new Error("A body-less request cannot declare body bytes.");
    }
  }

  append(message: BodyChunkMessage): { final: boolean; sequence: number } {
    if (this.#start.bodyKind === "none") {
      throw new Error("A body-less request cannot receive body chunks.");
    }
    if (this.#finished) {
      throw new Error("Request body is already complete.");
    }
    if (message.requestId !== this.#start.requestId) {
      throw new Error("Body chunk request ID does not match request-start.");
    }
    if (message.sequence !== this.#expectedSequence) {
      throw new Error(`Expected body chunk ${this.#expectedSequence}, received ${message.sequence}.`);
    }

    const bytes = decodeBodyChunk(message);
    this.#receivedBytes += bytes.byteLength;
    if (this.#receivedBytes > MAX_TRANSFER_BYTES) {
      throw new Error("Request body exceeds the extension transfer limit.");
    }
    if (this.#start.totalBytes !== undefined && this.#receivedBytes > this.#start.totalBytes) {
      throw new Error("Request body exceeds its declared length.");
    }

    this.#chunks.push(bytes);
    this.#expectedSequence += 1;
    this.#finished = message.final;
    if (this.#finished && this.#start.totalBytes !== undefined && this.#receivedBytes !== this.#start.totalBytes) {
      throw new Error("Request body length does not match its declared length.");
    }
    return { final: this.#finished, sequence: message.sequence };
  }

  finishBodyless(): Uint8Array {
    if (this.#start.bodyKind !== "none") {
      throw new Error("Request body has not received a final chunk.");
    }
    this.#finished = true;
    return new Uint8Array();
  }

  toBytes(): Uint8Array {
    if (!this.#finished) {
      throw new Error("Request body has not received a final chunk.");
    }
    const result = new Uint8Array(this.#receivedBytes);
    let offset = 0;
    for (const chunk of this.#chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
}
