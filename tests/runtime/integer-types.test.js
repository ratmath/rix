import { describe, expect, test } from "bun:test";
import { parseAndEvaluate } from "../../src/eval/evaluator.js";
import { formatValue } from "../../src/eval/format.js";
import {
    INTEGER_SHAPES,
    buildIntegerConstraint,
    complementShape,
    intersectShapes,
    normalizeShape,
    shapeHas,
    shapeNext,
    shapePrev,
} from "../../src/runtime/integer-types.js";

const text = (code) => formatValue(parseAndEvaluate(code));
const S = INTEGER_SHAPES;
const members = (shape, from, to) => {
    const out = [];
    for (let n = BigInt(from); n <= BigInt(to); n++) if (shapeHas(shape, n)) out.push(Number(n));
    return out;
};

describe("integer shapes", () => {
    test("built-in shapes", () => {
        expect(members(S.natural, -2, 2)).toEqual([0, 1, 2]);
        expect(members(S.positive, -2, 2)).toEqual([1, 2]);
        expect(members(S.negative, -2, 2)).toEqual([-2, -1]);
        expect(members(S.even, -3, 3)).toEqual([-2, 0, 2]);
        expect(members(S.odd, -3, 3)).toEqual([-3, -1, 1, 3]);
    });

    test("normalizing reduces the modulus", () => {
        expect(normalizeShape({ mod: 4n, residues: [1n, 3n] })).toMatchObject({ mod: 2n, residues: [1n] });
        expect(normalizeShape({ mod: 6n, residues: [0n, 1n, 2n, 3n, 4n, 5n] })).toMatchObject({ mod: 1n, residues: [0n] });
        expect(() => normalizeShape({ mod: 0n })).toThrow("modulus must be positive");
    });

    test("intersection uses the Chinese remainder theorem and both bounds", () => {
        const threeMod4 = normalizeShape({ mod: 4n, residues: [3n] });
        const oneMod3 = normalizeShape({ mod: 3n, residues: [1n] });
        const both = intersectShapes(threeMod4, oneMod3);
        expect(both).toMatchObject({ mod: 12n, residues: [7n] });
        expect(intersectShapes(S.positive, S.even)).toMatchObject({ mod: 2n, residues: [0n], min: 1n });
        expect(intersectShapes(S.even, S.odd)).toEqual({ empty: true });
        expect(intersectShapes(S.positive, S.negative)).toEqual({ empty: true });
    });

    test("complements stay shapes when they can", () => {
        expect(complementShape(S.even)).toMatchObject({ mod: 2n, residues: [1n] });
        expect(complementShape(S.natural)).toMatchObject({ max: -1n });
        expect(complementShape(S.negative)).toMatchObject({ min: 0n });
        expect(complementShape(S.integer)).toEqual({ empty: true });
        expect(complementShape(intersectShapes(S.positive, S.even))).toBeNull();
    });

    test("next and previous members", () => {
        expect(shapeNext(S.odd, 4n, true)).toBe(5n);
        expect(shapeNext(S.odd, 5n, false)).toBe(5n);
        expect(shapeNext(S.odd, 5n, true)).toBe(7n);
        expect(shapePrev(S.even, 5n, false)).toBe(4n);
        expect(shapePrev(S.even, -3n, true)).toBe(-4n);
        expect(shapePrev(S.natural, 0n, true)).toBeNull();
        expect(shapeNext(S.negative, -1n, true)).toBeNull();
    });
});

describe("integer constraints from type chains", () => {
    const resolve = (name) => {
        const shape = S[name.toLowerCase()];
        if (shape) return { shape };
        if (name === "Square") return { test: (n) => n >= 0n && BigInt(Math.round(Math.sqrt(Number(n)))) ** 2n === n };
        throw new Error(`Unknown semantic type: ${name}`);
    };

    test("chains of shaped types stay shaped", () => {
        const c = buildIntegerConstraint([{ name: "Positive", exclude: false }, { name: "Even", exclude: true }], resolve);
        expect(c.shape).toMatchObject({ mod: 2n, residues: [1n], min: 1n });
        expect(c.next(2n, true)).toBe(3n);
        expect(c.prev(1n, true)).toBeNull();
    });

    test("an exclusion that is not a shape becomes a test", () => {
        const c = buildIntegerConstraint([{ name: "Natural", exclude: false }, { name: "Square", exclude: true }], resolve);
        expect(c.shape).toBeNull();
        expect([0n, 1n, 2n, 3n, 4n, 5n].filter(c.test)).toEqual([2n, 3n, 5n]);
        expect(c.next(4n, true)).toBe(5n);
        expect(c.prev(4n, false)).toBe(3n);
    });

    test("an empty chain has no members", () => {
        const c = buildIntegerConstraint([{ name: "Even", exclude: false }, { name: "Odd", exclude: false }], resolve);
        expect(c.empty).toBe(true);
        expect(c.next(0n)).toBeNull();
    });
});

describe("integer subtypes in RiX", () => {
    test("type checks test the value, chain with ::, and negate with ::!", () => {
        expect(text("[5 ? :Positive, -5 ? :Positive, 0 ? :Natural, 0 ? :Positive, -3 ? :Negative, 4 ? :Even, 4 ? :Odd]"))
            .toBe("[1, _, 1, _, 1, 1, _]");
        expect(text("[4 ? :Positive::Even, 3 ? :Positive::!Even, 4 ? :Positive::!Even, -3 ? :Integer::!Even::!Positive]"))
            .toBe("[1, 1, _, 1]");
        expect(text("[1/2 ? :Natural, 3 ~: :Odd, 4 ~: :Odd]")).toBe("[_, 3, _]");
    });

    test(".IntegerType registers a shaped subtype", () => {
        expect(text(".IntegerType(:ThreeMod4, {= mod=4, residues=[3], min=0 }); [7 ? :ThreeMod4, -1 ? :ThreeMod4, 8 ? :ThreeMod4]"))
            .toBe("[1, _, _]");
        expect(text(".TypeRegister({= name=:OneMod3, shape={= mod=3, residues=[1] } }); [4 ? :OneMod3, -2 ? :OneMod3, 3 ? :OneMod3]"))
            .toBe("[1, 1, _]");
        expect(() => parseAndEvaluate(".IntegerType(:Bad, {= mod=0 })")).toThrow("modulus must be positive");
    });
});
