import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "connectors/*/src/**/*.test.ts", "tests/contracts/**/*.test.ts"],
    },
  },
]);
