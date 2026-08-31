import { defineConfig } from "wxt";
import { commonHostPermissions } from "./src/constants";

export default defineConfig({
  manifest: {
    name: "Live2D AI Chat Network Bridge",
    description: "User-authorized network bridge for Live2D AI Chat.",
    minimum_chrome_version: "116",
    permissions: ["activeTab", "offscreen", "scripting", "storage"],
    host_permissions: [...commonHostPermissions],
    optional_host_permissions: ["https://*/*", "http://*/*"],
  },
});
