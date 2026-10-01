import { runConnectorService } from "@range/connector-sdk";
import { createNadoAdapter } from "./adapter.js";

runConnectorService(createNadoAdapter())
  .catch(() => { console.error("Nado read-only connector startup failed."); process.exitCode = 1; });
