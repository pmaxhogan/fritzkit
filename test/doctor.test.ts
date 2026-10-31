import { describe, expect, it } from "vitest";
import {
  doctor,
  doctorStatus,
  formatDoctor,
  nodeVersionCheck,
  type DoctorReport,
} from "../src/core/validate/doctor.js";

describe("nodeVersionCheck", () => {
  it("accepts 22+ and rejects older", () => {
    expect(nodeVersionCheck("22.0.0").ok).toBe(true);
    expect(nodeVersionCheck("26.5.0").detail).toBe("v26.5.0");
    const old = nodeVersionCheck("20.11.1");
    expect(old.ok).toBe(false);
    expect(old.detail).toContain("upgrade");
    expect(nodeVersionCheck().ok).toBe(true);
  });
});

describe("doctorStatus / formatDoctor", () => {
  const report: DoctorReport = {
    ok: false,
    checks: [
      { name: "node >= 22", ok: true, detail: "v26.5.0" },
      { name: "uv on PATH", ok: false, detail: "install uv" },
      { name: "AutoHotkey", ok: false, detail: "not found", optional: true },
    ],
  };

  it("maps checks to ok / MISSING / warn", () => {
    expect(report.checks.map(doctorStatus)).toEqual(["ok", "MISSING", "warn"]);
  });

  it("formats an aligned ASCII table", () => {
    expect(formatDoctor(report)).toBe(
      [
        "ok      node >= 22  v26.5.0",
        "MISSING uv on PATH  install uv",
        "warn    AutoHotkey  not found",
        "",
        "Some required checks failed.",
      ].join("\n"),
    );
    expect(formatDoctor({ ok: true, checks: report.checks.slice(0, 1) })).toContain(
      "All required checks passed.",
    );
  });
});

describe("doctor", () => {
  it("returns every check with the right shape", async () => {
    const r = await doctor();
    expect(r.checks.map((c) => c.name)).toEqual([
      "node >= 22",
      "Fritzing executable",
      "Fritzing not running",
      "parts library + fzp_checker.py",
      "user parts dir",
      "My Parts bin",
      "uv on PATH",
      "vendored fzp checker",
      "lxml importable",
      "AutoHotkey v2 (e2e harness)",
      "sharp loads",
    ]);
    for (const c of r.checks) {
      expect(typeof c.ok).toBe("boolean");
      expect(typeof c.detail).toBe("string");
    }
    expect(r.checks[0]?.ok).toBe(true);
    expect(r.checks.find((c) => c.name.startsWith("AutoHotkey"))?.optional).toBe(true);
    expect(r.ok).toBe(r.checks.every((c) => c.ok || c.optional === true));
    expect(formatDoctor(r).split("\n")[0]).toMatch(/^(ok|warn|MISSING) +node >= 22 /);
  }, 180_000);

  it("reports missing tools when uv and Fritzing cannot be found", async () => {
    const r = await doctor({
      uvPath: "C:\\definitely\\not\\uv.exe",
      env: {
        ...process.env,
        FRITZKIT_FRITZING_EXE: "C:\\nope\\Fritzing.exe",
        USERPROFILE: "C:\\nope",
      },
    });
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    expect(byName["Fritzing executable"]?.ok).toBe(false);
    expect(byName["Fritzing executable"]?.detail).toContain("does not exist");
    expect(byName["uv on PATH"]?.ok).toBe(false);
    expect(byName["lxml importable"]?.ok).toBe(false);
    expect(byName["My Parts bin"]?.ok).toBe(false);
    expect(r.ok).toBe(false);
    const emptyUv = await doctor({ uvPath: "", skipLxml: true });
    expect(emptyUv.checks.find((c) => c.name === "uv on PATH")?.ok).toBe(false);
    const skipped = await doctor({ skipLxml: true });
    expect(skipped.checks.find((c) => c.name === "lxml importable")?.detail).toBe("skipped");
  }, 180_000);
});
