import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addBinInstance,
  backupBin,
  binInstanceXml,
  EMPTY_MY_PARTS_BIN,
  MAX_BIN_BACKUPS,
  nextModelIndex,
  parseBinInstances,
  readBin,
  removeBinInstances,
  writeBin,
  writeFileAtomic,
} from "../src/core/export/index.js";
import { tempFritzing } from "./export-helpers.js";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
function tmp() {
  const t = tempFritzing();
  cleanups.push(t.cleanup);
  return t;
}

/** search.fzb shape (Fritzing-written), LF variant for readability. */
const POPULATED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<module fritzingVersion="1.0.7" icon="Search.png" search="seeed">',
  "    <title>Search</title>",
  "    <instances>",
  '        <instance moduleIdRef="seeeduino_v3" modelIndex="85536071" path="seeed_seeeduino_v3.fzp">',
  "            <views/>",
  "        </instance>",
  '        <instance moduleIdRef="other_part" modelIndex="7" path="other.fzp"/>',
  "    </instances>",
  "</module>",
  "",
].join("\n");

describe("EMPTY_MY_PARTS_BIN", () => {
  it("matches the real 165-byte my_parts.fzb", () => {
    expect(EMPTY_MY_PARTS_BIN.length).toBe(165);
    expect(EMPTY_MY_PARTS_BIN).toContain('icon="Mine.png" >\r\n');
  });
});

describe("parseBinInstances / nextModelIndex", () => {
  it("parses both element shapes in file order", () => {
    expect(parseBinInstances(POPULATED)).toEqual([
      { moduleIdRef: "seeeduino_v3", modelIndex: 85536071, path: "seeed_seeeduino_v3.fzp" },
      { moduleIdRef: "other_part", modelIndex: 7, path: "other.fzp" },
    ]);
    expect(parseBinInstances(EMPTY_MY_PARTS_BIN)).toEqual([]);
  });

  it("starts at 100000 and stays above the max", () => {
    expect(nextModelIndex(EMPTY_MY_PARTS_BIN)).toBe(100000);
    expect(nextModelIndex(POPULATED)).toBe(85536072);
    expect(nextModelIndex('<instances><instance modelIndex="5"/></instances>')).toBe(100000);
  });
});

describe("binInstanceXml", () => {
  it("emits the Fritzing instance shape and escapes attributes", () => {
    expect(
      binInstanceXml({ moduleIdRef: 'a&"b', modelIndex: 1, path: "C:/x<y>.fzp" }, "  ", "", "\n"),
    ).toBe(
      '<instance moduleIdRef="a&amp;&quot;b" modelIndex="1" path="C:/x&lt;y&gt;.fzp">\n' +
        "  <views/>\n</instance>",
    );
  });
});

describe("addBinInstance", () => {
  it("expands the inline empty instances element, keeping CRLF and 4-space indent", () => {
    const xml = addBinInstance(EMPTY_MY_PARTS_BIN, {
      moduleIdRef: "fritzkit-spike-vector-00000001",
      path: "C:/parts/fritzkit-spike-vector-00000001/fritzkit-spike-vector-00000001.fzp",
    });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\r\n' +
        '<module fritzingVersion="0.4.3b.0.0" icon="Mine.png" >\r\n' +
        "    <title>My Parts</title>\r\n" +
        "    <instances>\r\n" +
        '        <instance moduleIdRef="fritzkit-spike-vector-00000001" modelIndex="100000" ' +
        'path="C:/parts/fritzkit-spike-vector-00000001/fritzkit-spike-vector-00000001.fzp">\r\n' +
        "            <views/>\r\n" +
        "        </instance>\r\n" +
        "    </instances>\r\n" +
        "</module>\r\n",
    );
    expect(xml).not.toMatch(/[^\r]\n/);
  });

  it("appends before a closing tag on its own line (LF file)", () => {
    const xml = addBinInstance(POPULATED, { moduleIdRef: "new_one_1", path: "n.fzp" });
    expect(xml).toContain(
      '        <instance moduleIdRef="other_part" modelIndex="7" path="other.fzp"/>\n' +
        '        <instance moduleIdRef="new_one_1" modelIndex="85536072" path="n.fzp">\n' +
        "            <views/>\n" +
        "        </instance>\n" +
        "    </instances>\n",
    );
    expect(xml).not.toContain("\r");
  });

  it("is a no-op when the moduleIdRef is present, and honours an explicit modelIndex", () => {
    expect(addBinInstance(POPULATED, { moduleIdRef: "other_part", path: "z" })).toBe(POPULATED);
    const xml = addBinInstance(POPULATED, { moduleIdRef: "q_q_q_q_q", path: "q", modelIndex: 42 });
    expect(parseBinInstances(xml).at(-1)).toEqual({
      moduleIdRef: "q_q_q_q_q",
      modelIndex: 42,
      path: "q",
    });
  });

  it("handles an empty string, a self-closing instances element and a missing one", () => {
    expect(parseBinInstances(addBinInstance("", { moduleIdRef: "aaaaaaaa", path: "p" }))).toEqual([
      { moduleIdRef: "aaaaaaaa", modelIndex: 100000, path: "p" },
    ]);
    const self = addBinInstance("<module>\n  <instances/>\n</module>\n", {
      moduleIdRef: "bbbbbbbb",
      path: "p",
    });
    expect(self).toBe(
      "<module>\n  <instances>\n" +
        '    <instance moduleIdRef="bbbbbbbb" modelIndex="100000" path="p">\n' +
        "      <views/>\n    </instance>\n  </instances>\n</module>\n",
    );
    expect(() => addBinInstance("<module/>", { moduleIdRef: "cccccccc", path: "p" })).toThrow(
      /no <instances>/,
    );
  });
});

describe("removeBinInstances", () => {
  it("removes matching instances with their lines and collapses an emptied element", () => {
    const one = addBinInstance(EMPTY_MY_PARTS_BIN, { moduleIdRef: "aaaaaaaa", path: "p" });
    const two = addBinInstance(one, { moduleIdRef: "bbbbbbbb", path: "p" });
    expect(removeBinInstances(two, (i) => i.moduleIdRef === "bbbbbbbb")).toBe(one);
    expect(removeBinInstances(two, () => true)).toBe(EMPTY_MY_PARTS_BIN);
    const lf = removeBinInstances(POPULATED, (i) => i.moduleIdRef === "seeeduino_v3");
    expect(parseBinInstances(lf).map((i) => i.moduleIdRef)).toEqual(["other_part"]);
    expect(lf).toContain(
      "    <instances>\n" +
        '        <instance moduleIdRef="other_part" modelIndex="7" path="other.fzp"/>\n' +
        "    </instances>",
    );
  });

  it("returns the input unchanged when nothing matches", () => {
    expect(removeBinInstances(POPULATED, () => false)).toBe(POPULATED);
  });
});

describe("readBin / writeBin / backupBin", () => {
  it("reads a missing or empty bin as the minimal document", async () => {
    const { paths } = tmp();
    expect(await readBin(paths.myPartsBin)).toEqual({ xml: EMPTY_MY_PARTS_BIN, instances: [] });
    writeFileSync(paths.myPartsBin, "  \r\n");
    expect((await readBin(paths.myPartsBin)).xml).toBe(EMPTY_MY_PARTS_BIN);
    writeFileSync(paths.myPartsBin, POPULATED);
    expect((await readBin(paths.myPartsBin)).instances).toHaveLength(2);
  });

  it("backs up with a timestamped name, suffixes clashes and keeps the 10 newest", async () => {
    const { paths } = tmp();
    expect(await backupBin(paths.myPartsBin)).toBeUndefined();
    writeFileSync(paths.myPartsBin, POPULATED);
    const now = () => new Date(2026, 0, 2, 3, 4, 5);
    const b1 = await backupBin(paths.myPartsBin, now);
    expect(b1).toBe(`${paths.myPartsBin}.bak-20260102-030405`);
    expect(readFileSync(b1!, "utf8")).toBe(POPULATED);
    expect(await backupBin(paths.myPartsBin, now)).toBe(`${b1}-1`);
    for (let s = 10; s < 22; s++)
      await backupBin(paths.myPartsBin, () => new Date(2026, 0, 3, 0, 0, s));
    const left = readdirSync(paths.binsDir).filter((f) => f.includes(".bak-"));
    expect(left).toHaveLength(MAX_BIN_BACKUPS);
    expect(left.sort()[0]).toBe("my_parts.fzb.bak-20260103-000012");
  });

  it("writeBin backs up unless told not to, and writes atomically", async () => {
    const { paths } = tmp();
    expect(await writeBin(paths.myPartsBin, "first")).toBeUndefined();
    const bak = await writeBin(paths.myPartsBin, "second", { now: () => new Date(2026, 0, 1) });
    expect(readFileSync(bak!, "utf8")).toBe("first");
    expect(await writeBin(paths.myPartsBin, "third", { backup: false })).toBeUndefined();
    expect(readFileSync(paths.myPartsBin, "utf8")).toBe("third");
    expect(readdirSync(paths.binsDir).some((f) => f.includes(".tmp-"))).toBe(false);
  });

  it("writeFileAtomic creates parents and cleans its temp file on failure", async () => {
    const { root } = tmp();
    const p = join(root, "a", "b", "c.txt");
    await writeFileAtomic(p, new Uint8Array([65]));
    expect(readFileSync(p, "utf8")).toBe("A");
    // Renaming a file over a directory fails.
    await expect(writeFileAtomic(join(root, "a", "b"), "x")).rejects.toThrow();
    expect(existsSync(join(root, "a", `b.tmp-${process.pid}`))).toBe(false);
  });
});
