import { runConnectorService } from "@range/connector-sdk";
import { createVariationalAdapter } from "./adapter.js";

runConnectorService(createVariationalAdapter())
  .catch(() => { console.error("Variational read-only connector startup failed."); process.exitCode = 1; });
