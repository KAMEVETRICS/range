import { runConnectorService } from "@range/connector-sdk";
import { createQfexAdapter } from "./adapter.js";

runConnectorService(createQfexAdapter())
  .catch(() => { console.error("QFEX read-only connector startup failed."); process.exitCode = 1; });
