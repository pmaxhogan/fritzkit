/** `fritzkit doctor`: what this machine has and lacks. */
import { doctor, formatDoctor, type DoctorReport } from "../../core/validate/index.js";
import type { CommandContext, CommandResult } from "../context.js";

export async function doctorCommand(ctx: CommandContext): Promise<CommandResult<DoctorReport>> {
  const report = await doctor({ env: ctx.env, ...(ctx.doctorOptions ?? {}) });
  return { exitCode: report.ok ? 0 : 1, text: formatDoctor(report), data: report };
}
