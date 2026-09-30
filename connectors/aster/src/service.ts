import { runConnectorService } from "@range/connector-sdk";
import { createAsterAdapter } from "./adapter.js";

runConnectorService(createAsterAdapter())
  .catch(() => { console.error("Aster read-only connector startup failed."); process.exitCode = 1; });
