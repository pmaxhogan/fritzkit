/** `fritzkit ui [part] [--port <n>]`: placeholder until the editor UI ships. */
import { NotImplementedError, type CommandContext, type CommandResult } from "../context.js";

// TODO(ui): replaced by the UI agent's implementation (src/ui). Keep the signature so
// program.ts does not need to change: (part, { port }, ctx) -> CommandResult.
export async function uiCommand(
  _part: string | undefined,
  _opts: { port?: string },
  _ctx: CommandContext,
): Promise<CommandResult<never>> {
  throw new NotImplementedError("fritzkit ui is coming in a later release");
}
