import { runConnectorService } from "@range/connector-sdk";
import { createLighterAdapter } from "./adapter.js";

runConnectorService(createLighterAdapter())
  .catch(() => { console.error("Lighter read-only connector startup failed."); process.exitCode = 1; });
