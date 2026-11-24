import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const rixRoot = path.resolve(import.meta.dir, "../..");
const temporaryRoot = path.join(rixRoot, "tmp");
const moduleFile = path.join(rixRoot, "tests/fixtures/ratmath-bridge/index.js");
const temporaryDirectories = [];

function program(source) {
    mkdirSync(temporaryRoot, { recursive: true });
    const directory = mkdtempSync(path.join(temporaryRoot, "ratmath-flag-"));
    temporaryDirectories.push(directory);
    const filename = path.join(directory, "sample.rix");
    writeFileSync(filename, source);
    return filename;
}

const cli = (...args) => spawnSync("bun", [path.join(rixRoot, "bin/rix.js"), ...args], { encoding: "utf8" });

afterEach(() => {
    while (temporaryDirectories.length) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

describe("rix --ratmath", () => {
    test("registers and loads every plugin the bridge names", () => {
        const file = program(".outsideDouble.Double(21)\n");
        const result = cli(`--ratmath=${moduleFile}`, "--plugins=none", file);
        expect(result.stderr).toBe("");
        expect(result.stdout.trim()).toBe("42");
    });

    test("without the flag the plugin is unknown", () => {
        const file = program('.Plugin.Load("outside-double")\n');
        const result = cli("--plugins=none", file);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Unknown plugin 'outside-double'");
    });

    test("without a path it looks for @ratmath/rix-bridge", () => {
        const file = program("1\n");
        const result = spawnSync("bun", [path.join(rixRoot, "bin/rix.js"), "--ratmath", file], { encoding: "utf8", cwd: path.dirname(file) });
        if (result.status === 0) return; // installed next to this RiX
        expect(result.stderr).toContain("cannot find @ratmath/rix-bridge");
    });

    test("a module without the hook is refused", () => {
        const file = program("1\n");
        const result = cli(`--ratmath=${path.join(rixRoot, "tests/fixtures/ratmath-bridge/no-hook.js")}`, file);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("does not export registerRixPlugins");
    });
});
