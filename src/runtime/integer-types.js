/**
 * Integer subtypes and their shapes.
 *
 * A shape is { mod, residues, min, max }: the integers n with n mod `mod` in
 * `residues` and min <= n <= max (either bound may be null). Shapes are closed
 * under intersection, so chained types such as Positive::Even stay shapes and
 * keep closed-form membership, next and previous. Excluding a shape (`::!T`)
 * stays a shape when T is a pure residue class or a one-sided bound; any
 * other exclusion becomes a plain test.
 *
 * Types without a shape (registered with only `validate`) still work: their
 * members are found by stepping and testing, within a budget.
 */

import { Integer, Rational } from "@ratmath/core";

export const INTEGER_SEARCH_BUDGET = 10000;

const mod = (a, m) => ((a % m) + m) % m;
const gcd = (a, b) => {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) [a, b] = [b, a % b];
    return a;
};
const lcm = (a, b) => (a / gcd(a, b)) * b;
const big = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (value instanceof Integer) return value.value;
    if (value instanceof Rational) {
        if (value.denominator !== 1n) throw new Error("Integer type shapes need integer bounds and residues");
        return value.numerator;
    }
    if (typeof value === "string") return BigInt(value);
    throw new Error("Integer type shapes need integer bounds and residues");
};

export function normalizeShape(spec = {}) {
    const m = big(spec.mod) ?? 1n;
    if (m <= 0n) throw new Error("An integer type's modulus must be positive");
    const raw = spec.residues === undefined || spec.residues === null ? [0n] : spec.residues;
    const residues = [...new Set((m === 1n ? [0n] : raw.map((r) => mod(big(r), m))).map(String))]
        .map((r) => BigInt(r))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (residues.length === 0) throw new Error("An integer type needs at least one residue");
    const min = big(spec.min);
    const max = big(spec.max);
    // Reduce mod to the smallest period that gives the same residues.
    let shape = { mod: m, residues, min, max };
    for (let d = 1n; d < m; d++) {
        if (m % d !== 0n) continue;
        const reduced = [...new Set(residues.map((r) => String(mod(r, d))))].map((r) => BigInt(r));
        const expanded = [];
        for (let k = 0n; k < m / d; k++) for (const r of reduced) expanded.push(r + k * d);
        if (expanded.length === residues.length) {
            shape = { mod: d, residues: reduced.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), min, max };
            break;
        }
    }
    return Object.freeze(shape);
}

export const INTEGER_SHAPES = Object.freeze({
    integer: normalizeShape({}),
    natural: normalizeShape({ min: 0n }),
    positive: normalizeShape({ min: 1n }),
    negative: normalizeShape({ max: -1n }),
    even: normalizeShape({ mod: 2n, residues: [0n] }),
    odd: normalizeShape({ mod: 2n, residues: [1n] }),
});

export const BUILTIN_INTEGER_TYPE_NAMES = Object.freeze(["Natural", "Positive", "Negative", "Even", "Odd"]);

export function shapeHas(shape, n) {
    if (shape.min !== null && n < shape.min) return false;
    if (shape.max !== null && n > shape.max) return false;
    return shape.residues.includes(mod(n, shape.mod));
}

export function intersectShapes(a, b) {
    const m = lcm(a.mod, b.mod);
    const residues = [];
    for (let r = 0n; r < m; r++) {
        if (a.residues.includes(mod(r, a.mod)) && b.residues.includes(mod(r, b.mod))) residues.push(r);
    }
    const min = a.min === null ? b.min : b.min === null ? a.min : (a.min > b.min ? a.min : b.min);
    const max = a.max === null ? b.max : b.max === null ? a.max : (a.max < b.max ? a.max : b.max);
    if (residues.length === 0 || (min !== null && max !== null && min > max)) return { empty: true };
    return normalizeShape({ mod: m, residues, min, max });
}

/** The integers outside `shape`, as a shape when that is one; otherwise null. */
export function complementShape(shape) {
    const hasBounds = shape.min !== null || shape.max !== null;
    const restricted = shape.residues.length < Number(shape.mod);
    if (!hasBounds) {
        if (!restricted) return { empty: true };
        const residues = [];
        for (let r = 0n; r < shape.mod; r++) if (!shape.residues.includes(r)) residues.push(r);
        return normalizeShape({ mod: shape.mod, residues });
    }
    if (restricted) return null;
    if (shape.min !== null && shape.max === null) return normalizeShape({ max: shape.min - 1n });
    if (shape.max !== null && shape.min === null) return normalizeShape({ min: shape.max + 1n });
    return null;
}

/** Least member >= n (or > n when strict), or null. */
export function shapeNext(shape, n, strict = false) {
    let start = strict ? n + 1n : n;
    if (shape.min !== null && start < shape.min) start = shape.min;
    const base = start - mod(start, shape.mod);
    for (const offset of [0n, shape.mod]) {
        for (const r of shape.residues) {
            const candidate = base + offset + r;
            if (candidate >= start) {
                return shape.max !== null && candidate > shape.max ? null : candidate;
            }
        }
    }
    return null;
}

/** Greatest member <= n (or < n when strict), or null. */
export function shapePrev(shape, n, strict = false) {
    let start = strict ? n - 1n : n;
    if (shape.max !== null && start > shape.max) start = shape.max;
    const base = start - mod(start, shape.mod);
    for (const offset of [0n, -shape.mod]) {
        for (let i = shape.residues.length - 1; i >= 0; i--) {
            const candidate = base + offset + shape.residues[i];
            if (candidate <= start) {
                return shape.min !== null && candidate < shape.min ? null : candidate;
            }
        }
    }
    return null;
}

export function shapeText(shape) {
    const parts = [];
    if (shape.mod !== 1n) parts.push(`n mod ${shape.mod} in [${shape.residues.join(", ")}]`);
    if (shape.min !== null) parts.push(`n >= ${shape.min}`);
    if (shape.max !== null) parts.push(`n <= ${shape.max}`);
    return parts.length ? parts.join(", ") : "every integer";
}

/**
 * A constraint on an integer built from a chain of [{ name, exclude }] and a
 * resolver that turns a type name into { shape } or { test, next?, prev? }.
 * Returns { shape, test(n), next(n, strict), prev(n, strict), text }.
 */
export function buildIntegerConstraint(chain, resolve) {
    let shape = INTEGER_SHAPES.integer;
    let empty = false;
    const tests = [];
    const hooks = [];
    for (const { name, exclude } of chain) {
        const entry = resolve(name);
        if (entry.shape) {
            const part = exclude ? complementShape(entry.shape) : entry.shape;
            if (part === null) {
                tests.push((n) => !shapeHas(entry.shape, n));
                continue;
            }
            if (part.empty) {
                empty = true;
                continue;
            }
            const joined = intersectShapes(shape, part);
            if (joined.empty) empty = true;
            else shape = joined;
            continue;
        }
        tests.push(exclude ? (n) => !entry.test(n) : entry.test);
        if (!exclude && (entry.next || entry.prev)) hooks.push(entry);
    }
    const text = chain.length ? chain.map((t) => `::${t.exclude ? "!" : ""}${t.name}`).join("") : "::Integer";
    if (empty) {
        return { empty: true, shape: null, test: () => false, next: () => null, prev: () => null, text };
    }
    if (tests.length === 0) {
        return {
            shape,
            test: (n) => shapeHas(shape, n),
            next: (n, strict = false) => shapeNext(shape, n, strict),
            prev: (n, strict = false) => shapePrev(shape, n, strict),
            text,
        };
    }
    const test = (n) => shapeHas(shape, n) && tests.every((t) => t(n));
    const hook = hooks.length === 1 && tests.length === 1 ? hooks[0] : null;
    const step = (n, strict, direction) => {
        let candidate = direction > 0
            ? shapeNext(shape, n, strict)
            : shapePrev(shape, n, strict);
        for (let i = 0; candidate !== null && i < INTEGER_SEARCH_BUDGET; i++) {
            if (test(candidate)) return candidate;
            if (hook && (direction > 0 ? hook.next : hook.prev)) {
                const jumped = direction > 0 ? hook.next(candidate) : hook.prev(candidate);
                if (jumped === null) return null;
                candidate = jumped;
                if (test(candidate)) return candidate;
            }
            candidate = direction > 0 ? shapeNext(shape, candidate, true) : shapePrev(shape, candidate, true);
        }
        if (candidate === null) return null;
        throw new Error(`No member of ${text} found within ${INTEGER_SEARCH_BUDGET} steps ${direction > 0 ? "above" : "below"} ${n}; a bound such as ::Natural keeps the search finite`);
    };
    return {
        shape: null,
        test,
        next: (n, strict = false) => step(n, strict, 1),
        prev: (n, strict = false) => step(n, strict, -1),
        text,
    };
}
