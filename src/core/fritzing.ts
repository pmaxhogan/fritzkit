/**
 * Where Fritzing lives on this machine and whether it is running. Shared by install,
 * prune, doctor and the e2e harness. Windows first (the only tested platform);
 * macOS/Linux paths are best-effort guesses that doctor reports as unverified.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface FritzingPaths {
  /** Fritzing executable, or undefined when not found. */
  exe?: string;
  /** Folder holding fzp_checker.py and core/, or undefined. */
  partsLibrary?: string;
  /** %APPDATA%/Fritzing/Fritzing/local_parts/user - where imported parts live. */
  userPartsDir: string;
  /** ~/Documents/Fritzing/bins/my_parts.fzb - the My Parts bin. */
  myPartsBin: string;
  binsDir: string;
}

export function fritzingPaths(env: NodeJS.ProcessEnv = process.env): FritzingPaths {
  const home = env.USERPROFILE ?? homedir();
  const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
  const candidates =
    process.platform === "win32"
      ? [
          join(env.ProgramFiles ?? "C:\\Program Files", "Fritzing", "Fritzing.exe"),
          join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Fritzing", "Fritzing.exe"),
          join(
            env.LOCALAPPDATA ?? join(home, "AppData", "Local"),
            "Programs",
            "Fritzing",
            "Fritzing.exe",
          ),
        ]
      : process.platform === "darwin"
        ? ["/Applications/Fritzing.app/Contents/MacOS/Fritzing"]
        : ["/usr/bin/Fritzing", "/usr/local/bin/Fritzing", "/opt/fritzing/Fritzing"];
  const exe = env.FRITZKIT_FRITZING_EXE ?? candidates.find((c) => existsSync(c));
  const partsLibrary = exe
    ? [join(exe, "..", "fritzing-parts"), join(exe, "..", "..", "fritzing-parts")].find((p) =>
        existsSync(join(p, "fzp_checker.py")),
      )
    : undefined;
  const userPartsDir =
    process.platform === "win32"
      ? join(appData, "Fritzing", "Fritzing", "local_parts", "user")
      : process.platform === "darwin"
        ? join(
            home,
            "Library",
            "Application Support",
            "Fritzing",
            "Fritzing",
            "local_parts",
            "user",
          )
        : join(home, ".local", "share", "Fritzing", "Fritzing", "local_parts", "user");
  const binsDir = join(home, "Documents", "Fritzing", "bins");
  return { exe, partsLibrary, userPartsDir, binsDir, myPartsBin: join(binsDir, "my_parts.fzb") };
}

export type FritzingRunState = "running" | "stopped" | "unknown";

/** Whether a Fritzing process is running; "unknown" when the process list cannot be read. */
export async function fritzingRunState(): Promise<FritzingRunState> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileP("tasklist", ["/FI", "IMAGENAME eq Fritzing.exe", "/NH"]);
      return /Fritzing\.exe/i.test(stdout) ? "running" : "stopped";
    }
    const { stdout } = await execFileP("pgrep", ["-ix", "fritzing"]);
    return stdout.trim().length > 0 ? "running" : "stopped";
  } catch (err) {
    // pgrep exits 1 when nothing matches; anything else means we could not tell.
    const code = (err as { code?: unknown }).code;
    if (process.platform !== "win32" && code === 1) return "stopped";
    return "unknown";
  }
}

/**
 * True unless Fritzing is known to be stopped. Fails CLOSED: install and prune must not
 * touch Fritzing's user folders when the process list cannot be read.
 */
export async function isFritzingRunning(): Promise<boolean> {
  return (await fritzingRunState()) !== "stopped";
}

/** File version of Fritzing.exe (Windows), e.g. "1.0.7.0"; undefined elsewhere. */
export async function fritzingVersion(exe: string | undefined): Promise<string | undefined> {
  if (!exe || process.platform !== "win32") return undefined;
  try {
    const { stdout } = await execFileP("powershell", [
      "-NoProfile",
      "-Command",
      `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
    ]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
