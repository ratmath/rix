/**
 * Static facts about piecewise regions, shared by the runtime and the linter.
 *
 * chainInfo reads a lowered betweenness chain. shadowedArms finds arms that
 * earlier arms already cover, using only what can be known without running
 * the program: one-variable regions with literal bounds, plus periodic arms
 * whose copies tile the whole line.
 */

import { Rational } from "@ratmath/core";

/** A lowered chain with a header variable in the middle, or null. */
export function chainInfo(node, variables) {
    let points;
    let strict;
    let ends;
    if (node?.fn === "INTERVAL" && node.args.length === 3) {
        points = node.args;
        strict = [false, false, false];
        ends = [false, false, false];
    } else if (node?.fn === "BETWEEN" && node.args.length === 4) {
        const shape = String(node.args[0]?.args?.[0] ?? node.args[0]);
        points = node.args.slice(1);
        strict = [false];
        ends = [];
        for (const ch of shape) {
            if (ch === "_" || ch === "v") ends.push(ch === "_");
            else strict.push(ch === "!");
        }
    } else {
        return null;
    }
    const middle = points[1];
    if (middle?.fn !== "RETRIEVE" || !variables.includes(middle.args[0])) return null;
    return {
        node,
        variable: middle.args[0],
        lo: ends[0] ? null : points[0],
        hi: ends[2] ? null : points[2],
        loStrict: strict[1] === true,
        hiStrict: strict[2] === true,
        oneSided: ends[0] || ends[2],
    };
}

// ---- literal arithmetic --------------------------------------------------------

const unwrapDefer = (node) => (node?.fn === "DEFER" ? node.args[0] : node);

function literalValue(text) {
    const s = String(text).replace(/_/g, "");
    if (/^\d+$/.test(s)) return new Rational(BigInt(s), 1n);
    const m = s.match(/^(\d*)\.(\d+)$/);
    if (m) return new Rational(BigInt(`${m[1] || "0"}${m[2]}`), 10n ** BigInt(m[2].length));
    return null;
}

/** The value of literal arithmetic, with `bindings` for named integers; null if unknown. */
function constant(node, bindings = new Map()) {
    if (!node?.fn) return null;
    if (node.fn === "LITERAL") return literalValue(node.args[0]);
    if (node.fn === "RETRIEVE") return bindings.get(node.args[0]) ?? null;
    if (node.fn === "NEG") {
        const v = constant(node.args[0], bindings);
        return v && v.negate();
    }
    const ops = { ADD: "add", SUB: "subtract", MUL: "multiply", DIV: "divide" };
    if (!ops[node.fn] || node.args.length !== 2) return null;
    const a = constant(node.args[0], bindings);
    const b = constant(node.args[1], bindings);
    if (!a || !b) return null;
    if (node.fn === "DIV" && b.numerator === 0n) return null;
    return a[ops[node.fn]](b);
}

// ---- sets of intervals -----------------------------------------------------------

// An interval is { lo, loClosed, hi, hiClosed }; lo or hi null means unbounded.
const ALL = Object.freeze({ lo: null, loClosed: false, hi: null, hiClosed: false });

const cmpLo = (a, b) => {
    if (a.lo === null || b.lo === null) return a.lo === null ? (b.lo === null ? 0 : -1) : 1;
    const c = a.lo.compareTo(b.lo);
    if (c !== 0) return c;
    return a.loClosed === b.loClosed ? 0 : a.loClosed ? -1 : 1;
};

function nonEmpty(i) {
    if (i.lo === null || i.hi === null) return true;
    const c = i.lo.compareTo(i.hi);
    return c < 0 || (c === 0 && i.loClosed && i.hiClosed);
}

/** Sorted, merged components of a union of intervals. */
function merge(intervals) {
    const sorted = intervals.filter(nonEmpty).sort(cmpLo);
    const out = [];
    for (const next of sorted) {
        const last = out.at(-1);
        // Does next start inside or right at the end of last (with no gap)?
        const joins = last && (last.hi === null || next.lo === null || (() => {
            const c = next.lo.compareTo(last.hi);
            return c < 0 || (c === 0 && (last.hiClosed || next.loClosed));
        })());
        if (!joins) {
            out.push({ ...next });
            continue;
        }
        if (last.hi === null) continue;
        if (next.hi === null) {
            last.hi = null;
            last.hiClosed = false;
            continue;
        }
        const c = next.hi.compareTo(last.hi);
        if (c > 0 || (c === 0 && next.hiClosed)) {
            last.hi = next.hi;
            last.hiClosed = last.hiClosed && c === 0 ? true : next.hiClosed;
        }
    }
    return out;
}

function intersect(a, b) {
    const lo = a.lo === null ? b : b.lo === null ? a : (() => {
        const c = a.lo.compareTo(b.lo);
        return c > 0 ? a : c < 0 ? b : { lo: a.lo, loClosed: a.loClosed && b.loClosed };
    })();
    const hi = a.hi === null ? b : b.hi === null ? a : (() => {
        const c = a.hi.compareTo(b.hi);
        return c < 0 ? a : c > 0 ? b : { hi: a.hi, hiClosed: a.hiClosed && b.hiClosed };
    })();
    return { lo: lo.lo, loClosed: lo.loClosed, hi: hi.hi, hiClosed: hi.hiClosed };
}

/** Is every interval of `set` inside one merged component of `cover`? */
function covers(cover, set) {
    const inside = (outer, inner) => {
        const loOk = outer.lo === null || (inner.lo !== null && (() => {
            const c = outer.lo.compareTo(inner.lo);
            return c < 0 || (c === 0 && (outer.loClosed || !inner.loClosed));
        })());
        const hiOk = outer.hi === null || (inner.hi !== null && (() => {
            const c = outer.hi.compareTo(inner.hi);
            return c > 0 || (c === 0 && (outer.hiClosed || !inner.hiClosed));
        })());
        return loOk && hiOk;
    };
    return set.filter(nonEmpty).every((i) => cover.some((outer) => inside(outer, i)));
}

// ---- regions ------------------------------------------------------------------------

/** The set of one chain with literal bounds (either orientation), or null. */
function chainSet(chain) {
    const lo = chain.lo === null ? null : constant(chain.lo);
    const hi = chain.hi === null ? null : constant(chain.hi);
    if ((chain.lo !== null && !lo) || (chain.hi !== null && !hi)) return null;
    const up = { lo, loClosed: !chain.loStrict, hi, hiClosed: !chain.hiStrict };
    if (chain.oneSided || lo === null || hi === null) return [up];
    const down = { lo: hi, loClosed: !chain.hiStrict, hi: lo, hiClosed: !chain.loStrict };
    return merge([up, down]);
}

/**
 * Does a periodic chain on one untyped integer cover the whole line? True
 * when its bounds are affine with the same positive slope and consecutive
 * copies meet with no gap.
 */
function tilesLine(chain, integer) {
    if (chain.lo === null || chain.hi === null || chain.oneSided) return false;
    const at = (node, k) => constant(node, new Map([[integer, new Rational(k, 1n)]]));
    const lo = [0n, 1n, 2n].map((k) => at(chain.lo, k));
    const hi = [0n, 1n, 2n].map((k) => at(chain.hi, k));
    if ([...lo, ...hi].some((v) => !v)) return false;
    const slope = lo[1].subtract(lo[0]);
    if (!lo[2].subtract(lo[1]).equals(slope)) return false;
    if (!hi[1].subtract(hi[0]).equals(slope) || !hi[2].subtract(hi[1]).equals(slope)) return false;
    if (slope.numerator <= 0n) return false;
    // Copy k ends at hi(k); copy k+1 starts at lo(k+1).
    const c = hi[0].compareTo(lo[1]);
    return c > 0 || (c === 0 && (!chain.hiStrict || !chain.loStrict));
}

const flatten = (node, fn) => (node?.fn === fn ? node.args.flatMap((arg) => flatten(arg, fn)) : [node]);

function namesIn(node, out = new Set()) {
    if (!node || typeof node !== "object") return out;
    if (node.fn === "RETRIEVE") out.add(node.args[0]);
    for (const arg of node.args || []) if (arg && typeof arg === "object") namesIn(arg, out);
    return out;
}

/**
 * The set a region covers, as merged intervals, or null when it cannot be
 * known statically.
 */
function regionSet(condition, variable, integers) {
    const parts = [];
    for (const alt of flatten(condition, "OR")) {
        let current = [ALL];
        for (const conjunct of flatten(alt, "AND")) {
            const chain = chainInfo(conjunct, [variable]);
            if (!chain) return null;
            const used = [...namesIn(conjunct)].filter((name) => integers.has(name));
            let set;
            if (used.length === 0) set = chainSet(chain);
            else if (used.length === 1 && integers.get(used[0]).types.length === 0 && !integers.get(used[0]).neighbor && tilesLine(chain, used[0])) set = [ALL];
            else return null;
            if (!set) return null;
            current = merge(current.flatMap((a) => set.map((b) => intersect(a, b))));
        }
        parts.push(...current);
    }
    return merge(parts);
}

/**
 * Arms of a lowered PIECEWISE node that earlier arms already cover:
 * [{ index, coveredBy }] with zero-based arm indexes. Only one-variable
 * literals are checked; anything unknown is left alone.
 */
export function shadowedArms(node) {
    if (node?.fn !== "PIECEWISE") return [];
    const meta = node.args[0];
    if (meta.variables.length !== 1) return [];
    const variable = meta.variables[0];
    const integers = new Map(meta.integers.map((entry) => [entry.name, entry]));
    const found = [];
    let cover = [];
    const owners = [];
    node.args.slice(1).forEach((raw, index) => {
        const arm = unwrapDefer(raw);
        if (arm?.fn !== "CONDITION") {
            if (covers(cover, [ALL])) found.push({ index, coveredBy: [...owners] });
            return;
        }
        const set = regionSet(arm.args[0], variable, integers);
        if (!set) return;
        if (cover.length && covers(cover, set)) {
            found.push({ index, coveredBy: [...owners] });
            return;
        }
        if (set.length) {
            cover = merge([...cover, ...set]);
            owners.push(index);
        }
    });
    return found;
}
