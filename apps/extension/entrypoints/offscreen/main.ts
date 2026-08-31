import { browser } from "wxt/browser";
import { OFFSCREEN_PORT } from "../../src/constants";
import { OffscreenExecutor } from "../../src/offscreen-executor";

let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

function connect(): void {
  const port = browser.runtime.connect({ name: OFFSCREEN_PORT });
  const executor = new OffscreenExecutor(port);
  port.onDisconnect.addListener(() => {
    executor.dispose();
    if (reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, 500);
  });
}

connect();
