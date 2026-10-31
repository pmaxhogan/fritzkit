/**
 * Optional ML background remover (spec decision D19, method "ml").
 *
 * Uses @imgly/background-removal-node, which is AGPL-3.0 licensed. fritzkit is MIT, so
 * the module is NOT a dependency: the user installs it explicitly to opt in, and it is
 * only loaded at runtime when method "ml" is requested.
 */

export const ML_REMOVER_MODULE = "@imgly/background-removal-node";

export const ML_INSTALL_HINT =
  `The "ml" background remover needs the optional package ${ML_REMOVER_MODULE} ` +
  `(AGPL-3.0, not installed by default). Install it with: npm install ${ML_REMOVER_MODULE} ` +
  `- or use the default "key" method.`;

interface ImglyModule {
  removeBackground: (
    input: unknown,
    config?: unknown,
  ) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}

export interface RemoverOptions {
  /** Module loader (tests inject a fake). Defaults to a dynamic import of the package. */
  load?: () => Promise<unknown>;
}

/** Mime type from magic bytes (PNG, JPEG, WebP); PNG when unknown. */
export function sniffMime(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  const tag = String.fromCharCode(...data.subarray(0, 12));
  if (tag.startsWith("RIFF") && tag.slice(8, 12) === "WEBP") return "image/webp";
  return "image/png";
}

function isModuleNotFound(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

function pickApi(mod: unknown): ImglyModule["removeBackground"] | undefined {
  const m = mod as { removeBackground?: unknown; default?: { removeBackground?: unknown } };
  const fn = m?.removeBackground ?? m?.default?.removeBackground;
  return typeof fn === "function" ? (fn as ImglyModule["removeBackground"]) : undefined;
}

/** Remove the background with the ML model. Returns RGBA PNG bytes. */
export async function removeBackgroundMl(
  data: Uint8Array,
  opts: RemoverOptions = {},
): Promise<Uint8Array> {
  const specifier = ML_REMOVER_MODULE;
  const load = opts.load ?? (() => import(specifier) as Promise<unknown>);
  let mod: unknown;
  try {
    mod = await load();
  } catch (err) {
    if (isModuleNotFound(err)) throw new Error(ML_INSTALL_HINT, { cause: err });
    throw new Error(`failed to load ${ML_REMOVER_MODULE}: ${String(err)}`, { cause: err });
  }
  const removeBackground = pickApi(mod);
  if (!removeBackground) {
    throw new Error(`${ML_REMOVER_MODULE} does not export removeBackground(); unsupported version`);
  }
  const input = new Blob([new Uint8Array(data)], { type: sniffMime(data) });
  const blob = await removeBackground(input, { output: { format: "image/png" } });
  return new Uint8Array(await blob.arrayBuffer());
}
