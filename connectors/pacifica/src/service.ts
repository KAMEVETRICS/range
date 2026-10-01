import { runConnectorService } from "@range/connector-sdk";
import { createPacificaAdapter } from "./adapter.js";

runConnectorService(createPacificaAdapter())
  .catch(() => { console.error("Pacifica read-only connector startup failed."); process.exitCode = 1; });
