/** Shared temp-workspace fixture for the CLI and MCP tests (not a test file itself). */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../src/cli/context.js";

export const DATE = "2026-01-01";

export interface TempEnv {
  root: string;
  ws: string;
  userParts: string;
  bins: string;
  ctx: CommandContext;
  /** Toggle what the injected isRunning reports. */
  running: { value: boolean };
  cleanup: () => void;
}

export function tempEnv(prefix = "fritzkit-cli-"): TempEnv {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const ws = join(root, "ws");
  const userParts = join(root, "user-parts");
  const bins = join(root, "bins");
  mkdirSync(userParts, { recursive: true });
  const running = { value: false };
  const ctx: CommandContext = {
    env: {
      USERPROFILE: root,
      HOME: root,
      FRITZKIT_FRITZING_USER_PARTS: userParts,
      FRITZKIT_FRITZING_BINS: bins,
    },
    cwd: root,
    workspace: ws,
    date: DATE,
    isRunning: async () => running.value,
    doctorOptions: { skipLxml: true, uvPath: "fritzkit-test-no-such-uv" },
  };
  return {
    root,
    ws,
    userParts,
    bins,
    ctx,
    running,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
