import { runClaudeCallback } from "../../src/claude-callback-runtime.js";

await runClaudeCallback({
  backend: {}, // Oversized input fails before any credential operation.
  readRuntimeConfiguration: async () => ({
    previousCommand: `"${process.execPath}" -e "let bytes=0;process.stdin.on('data',c=>bytes+=c.length);process.stdin.on('end',()=>process.stdout.write('existing bytes='+bytes))"`,
  }),
});
