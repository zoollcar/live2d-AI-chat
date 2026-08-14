import { createApp } from "../app";
import { loadProxyConfig } from "../config";

export default createApp(loadProxyConfig(process.env));
