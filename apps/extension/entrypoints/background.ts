import { browser } from "wxt/browser";
import { OffscreenBroker } from "../src/offscreen-broker";
import { CONNECTED_SITE_PATTERNS_KEY } from "../src/constants";
import { reconcileSiteBridgeRegistration } from "../src/site-registration";

export default defineBackground({
  type: "module",
  main() {
    const broker = new OffscreenBroker();
    browser.runtime.onConnect.addListener((port) => broker.acceptPort(port));

    const initialize = async () => {
      await Promise.all([
        browser.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
        browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
      ]);
      await reconcileSiteBridgeRegistration();
    };

    browser.runtime.onInstalled.addListener(() => void initialize());
    browser.runtime.onStartup.addListener(() => void initialize());
    browser.permissions.onRemoved.addListener(() => {
      void Promise.all([reconcileSiteBridgeRegistration(), broker.reconcileClients()]);
    });
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === "local" && CONNECTED_SITE_PATTERNS_KEY in changes) {
        void broker.reconcileClients();
      }
    });
    void initialize();
  },
});
