import { runConnectorService } from "@range/connector-sdk";
import { createBybitAdapter } from "./adapter.js";

runConnectorService(createBybitAdapter())
  .catch(() => { console.error("Bybit read-only connector startup failed."); process.exitCode = 1; });
