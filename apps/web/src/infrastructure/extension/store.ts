import type { ExtensionConnectionState } from "@live2d-chat/shared";
import { create } from "zustand";

interface ExtensionStore extends ExtensionConnectionState {
  replace(state: ExtensionConnectionState): void;
  setStatus(status: ExtensionConnectionState["status"], error?: string): void;
  reset(): void;
}

const initialState: ExtensionConnectionState = {
  status: "checking",
  capabilities: [],
  grantedOrigins: [],
};

/**
 * Runtime-only companion extension state. It is deliberately not persisted:
 * every page load has to perform a fresh nonce-bound handshake and permission
 * state is owned by the extension.
 */
export const useExtensionStore = create<ExtensionStore>((set) => ({
  ...initialState,
  replace(state) {
    set(state);
  },
  setStatus(status, error) {
    set((state) => ({ ...state, status, error }));
  },
  reset() {
    set(initialState);
  },
}));
