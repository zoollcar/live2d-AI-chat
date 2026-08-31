import { bridgeProtocolMessageSchema, type BridgeProtocolMessage } from "@live2d-chat/shared";

export interface RoutedBridgeFrame {
  clientId: string;
  message: BridgeProtocolMessage;
}

export interface ClientDisconnectedFrame {
  clientId: string;
  disconnected: true;
}

export interface OffscreenKeepAliveFrame {
  keepAlive: true;
}

export type BackgroundToOffscreenFrame = RoutedBridgeFrame | ClientDisconnectedFrame;

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;

export function parseRoutedBridgeFrame(value: unknown): RoutedBridgeFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { clientId?: unknown; message?: unknown };
  if (typeof candidate.clientId !== "string" || !CLIENT_ID_PATTERN.test(candidate.clientId)) return undefined;
  const parsed = bridgeProtocolMessageSchema.safeParse(candidate.message);
  return parsed.success ? { clientId: candidate.clientId, message: parsed.data } : undefined;
}

export function parseBackgroundToOffscreenFrame(value: unknown): BackgroundToOffscreenFrame | undefined {
  const routed = parseRoutedBridgeFrame(value);
  if (routed) return routed;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { clientId?: unknown; disconnected?: unknown };
  if (candidate.disconnected !== true
    || typeof candidate.clientId !== "string"
    || !CLIENT_ID_PATTERN.test(candidate.clientId)) return undefined;
  return { clientId: candidate.clientId, disconnected: true };
}

export function isOffscreenKeepAliveFrame(value: unknown): value is OffscreenKeepAliveFrame {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { keepAlive?: unknown };
  return candidate.keepAlive === true && Object.keys(candidate).length === 1;
}
