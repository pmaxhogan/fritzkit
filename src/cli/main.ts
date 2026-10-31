#!/usr/bin/env node
/** fritzkit CLI entry point (package.json bin). All logic lives in program.ts. */
import { runCli } from "./program.js";

process.exitCode = await runCli(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});
