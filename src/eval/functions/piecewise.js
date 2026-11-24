/**
 * Piecewise functions: {?: /x; n::Natural, m::Odd > n/ region ? rule; ...; default }
 *
 * The literal builds a callable. Arms are tried in order and the first whose
 * region holds supplies the value; a bare last arm is the default; no match
 * gives `_`. Regions are betweenness chains on a header variable, joined with
 * `&&` and `||`; any other condition is a predicate tested pointwise.
 *
 * Integer binders are solved, not supplied: for each arm the runtime finds
 * the integers that make its chains hold. When a chain's bounds are affine in
 * the integer (within each residue class of its type), the candidates come
 * from exact arithmetic. Otherwise the bounds are assumed to increase with the
 * integer and the solver searches, within a budget.
 *
 * Inputs: exact rationals give exact results; a RationalInterval input splits
 * at the breakpoints and returns the hull; a certified approximation whose
 * enclosure straddles a breakpoint gives `?`.
 */

import { Integer, Rational, RationalInterval, CertifiedApproximation } from "@ratmath/core";
import { UNDECIDED, decisionState, isUndecided } from "../../runtime/decision.js";
import { attachBuiltinProto } from "../../runtime/methods.js";
import { buildIntegerConstraint, INTEGER_SEARCH_BUDGET } from "../../runtime/integer-types.js";
import { resolveIntegerType, registerIntegerTypeFromRix, stringObj } from "../../runtime/type-system.js";
import { irToText } from "../ir-to-text.js";
import { derivative } from "./symbolic.js";
import { chainInfo } from "../piecewise-regions.js";

export const PIECE_BUDGET = 10000;

// ---- small exact helpers ------------------------------------------------------

const ZERO = new Rational(0n, 1n);
const TWO = new Rational(2n, 1n);

function toQ(value) {
    if (value instanceof Rational) return value;
    if (value instanceof Integer) return new Rational(value.value, 1n);
    if (typeof value === "bigint") return new Rational(value, 1n);
    return null;
}

function fromQ(q) {
    return q.denominator === 1n ? new Integer(q.numerator) : q;
}

function floorDiv(n, d) {
    const q = n / d;
    return (n % d !== 0n && (n < 0n) !== (d < 0n)) ? q - 1n : q;
}
const floorQ = (q) => floorDiv(q.numerator, q.denominator);
const ceilQ = (q) => -floorDiv(-q.numerator, q.denominator);
const cmp = (a, b) => a.compareTo(b);
const minB = (a, b) => (a < b ? a : b);
const maxB = (a, b) => (a > b ? a : b);

function seq(values) {
    return attachBuiltinProto({ type: "sequence", values });
}

function rixMap(entries) {
    return attachBuiltinProto({ type: "map", entries: new Map(entries) });
}

// ---- IR helpers ---------------------------------------------------------------

const unwrapDefer = (node) => (node?.fn === "DEFER" ? node.args[0] : node);

function namesIn(node, out = new Set()) {
    if (!node || typeof node !== "object") return out;
    if (Array.isArray(node)) {
        for (const item of node) namesIn(item, out);
        return out;
    }
    if (node.fn === "RETRIEVE" && typeof node.args?.[0] === "string") out.add(node.args[0]);
    if (Array.isArray(node.args)) for (const arg of node.args) namesIn(arg, out);
    return out;
}

function flatten(node, fn) {
    if (node?.fn === fn) return node.args.flatMap((arg) => flatten(arg, fn));
    return [node];
}

const PRINT_OPS = { ADD: "+", SUB: "-", MUL: "*", DIV: "/", POW: "^", LT: "<", GT: ">", LTE: "<=", GTE: ">=", EQ: "==", NEQ: "!=" };
const PRECEDENCE = { ADD: 1, SUB: 1, MUL: 2, DIV: 2, NEG: 3, POW: 4 };

/** RiX-like text for the expression subset used in regions and rules. */
export function regionText(node) {
    const print = (n, parent = 0) => {
        if (!n) return "_";
        switch (n.fn) {
            case "LITERAL": return String(n.args[0]);
            case "RETRIEVE": return String(n.args[0]);
            case "NULL": return "_";
            case "NEG": {
                const inner = print(n.args[0], PRECEDENCE.NEG);
                return parent > PRECEDENCE.NEG ? `(-${inner})` : `-${inner}`;
            }
            case "ADD": case "SUB": case "MUL": case "DIV": case "POW": {
                const p = PRECEDENCE[n.fn];
                const left = print(n.args[0], n.fn === "POW" ? p + 1 : p);
                const right = print(n.args[1], n.fn === "POW" ? p : p + 1);
                const text = n.fn === "MUL" && /^[0-9]/.test(left) && /^[a-z]/.test(right)
                    ? `${left}${right}`
                    : `${left}${PRINT_OPS[n.fn]}${right}`;
                return parent > p ? `(${text})` : text;
            }
            case "LT": case "GT": case "LTE": case "GTE": case "EQ": case "NEQ":
                return `${print(n.args[0])} ${PRINT_OPS[n.fn]} ${print(n.args[1])}`;
            case "AND": return n.args.map((a) => print(a, 10)).join(" && ");
            case "OR": return n.args.map((a) => print(a, 10)).join(" || ");
            case "INTERVAL": return n.args.map((a) => print(a, 0)).join(":");
            case "BETWEEN": {
                const shape = n.args[0]?.args?.[0] ?? n.args[0];
                const links = [...String(shape)].filter((c) => c === ":" || c === "!");
                const points = n.args.slice(1);
                let text = "";
                points.forEach((point, k) => {
                    if (k > 0) text += links[k - 1] === "!" ? ":!" : ":";
                    text += point?.fn === "NULL" ? "_" : print(point, 0);
                });
                return text;
            }
            default:
                return irToText(n);
        }
    };
    return print(node);
}

/**
 * A chain on a header variable: { variable, lo, hi, loStrict, hiStrict,
 * loOpen, hiOpen } where lo/hi are IR (null for an unbounded end).
 */

// ---- construction -------------------------------------------------------------

function buildSpec(meta, armNodes, context, evaluate) {
    const variables = meta.variables;
    const integerList = meta.integers;
    const declared = new Map();
    for (const name of variables) {
        if (declared.has(name)) throw new Error(`Piecewise header declares ${name} twice`);
        declared.set(name, "variable");
    }
    for (const entry of integerList) {
        if (declared.has(entry.name)) throw new Error(`Piecewise header declares ${entry.name} twice`);
        declared.set(entry.name, "integer");
    }

    const integers = new Map();
    const resolve = (name) => resolveIntegerType(name, context, evaluate);
    for (const entry of integerList) {
        integers.set(entry.name, {
            name: entry.name,
            constraint: buildIntegerConstraint(entry.types, resolve),
            typeText: entry.types.length ? entry.types.map((t) => `::${t.exclude ? "!" : ""}${t.name}`).join("") : "",
            neighbor: entry.neighbor ?? null,
        });
    }
    for (const info of integers.values()) {
        if (!info.neighbor) continue;
        const anchor = integers.get(info.neighbor.of);
        if (!anchor) throw new Error(`${info.name} ${info.neighbor.relation} ${info.neighbor.of}: ${info.neighbor.of} is not an integer declared in this header`);
    }
    const rootOf = (name, seen = new Set()) => {
        const info = integers.get(name);
        if (!info.neighbor) return name;
        if (seen.has(name)) throw new Error(`Neighbor integers ${[...seen].join(", ")} refer to each other in a cycle`);
        seen.add(name);
        return rootOf(info.neighbor.of, seen);
    };
    for (const name of integers.keys()) integers.get(name).root = rootOf(name);
    // Neighbors in dependency order, so each anchor is known before it is used.
    const neighborOrder = [];
    const placed = new Set();
    const place = (name) => {
        if (placed.has(name)) return;
        const info = integers.get(name);
        if (info.neighbor) place(info.neighbor.of);
        placed.add(name);
        if (info.neighbor) neighborOrder.push(name);
    };
    for (const name of integers.keys()) place(name);

    const intsIn = (node) => [...namesIn(node)].filter((name) => integers.has(name));
    const rootsOf = (names) => new Set(names.map((name) => integers.get(name).root));

    const arms = [];
    armNodes.forEach((raw, index) => {
        const inner = unwrapDefer(raw);
        const isDefault = inner?.fn !== "CONDITION";
        if (isDefault) {
            if (index !== armNodes.length - 1) throw new Error("A piecewise default (an arm without '?') must be the last arm");
            const used = intsIn(inner);
            if (used.length) throw new Error(`The default arm uses ${used.join(", ")}, but only a region can fix an integer; give the default its own region`);
            arms.push({ index, isDefault: true, rule: inner, ruleText: regionText(inner) });
            return;
        }
        const [condition, rule] = inner.args;
        const ruleInts = intsIn(rule);
        const alternatives = flatten(condition, "OR").map((alt) => {
            const conjuncts = flatten(alt, "AND").map((node) => ({ node, chain: chainInfo(node, variables) }));
            const used = new Set([...intsIn(alt), ...ruleInts]);
            const roots = rootsOf([...used]);
            const pins = new Map();
            for (const root of roots) {
                const pin = conjuncts.find(({ chain }) => {
                    if (!chain) return false;
                    const chainRoots = rootsOf([...intsIn(chain.lo), ...intsIn(chain.hi)]);
                    return chainRoots.size === 1 && chainRoots.has(root);
                });
                if (!pin) {
                    const where = ruleInts.some((name) => integers.get(name).root === root) && !intsIn(alt).some((name) => integers.get(name).root === root)
                        ? `the rule uses ${root} but the region ${regionText(alt)} does not mention it`
                        : `no chain in ${regionText(alt)} has bounds using ${root} alone, so nothing fixes it`;
                    throw new Error(`Piecewise arm ${index + 1}: ${where}`);
                }
                pins.set(root, pin.chain);
            }
            const needed = new Set();
            for (const name of used) {
                let current = name;
                while (integers.get(current).neighbor) {
                    needed.add(current);
                    current = integers.get(current).neighbor.of;
                }
            }
            const neighbors = neighborOrder.filter((name) => needed.has(name));
            return { node: alt, conjuncts, roots: [...roots], pins, neighbors };
        });
        arms.push({ index, isDefault: false, condition, rule, alternatives, regionText: regionText(condition), ruleText: regionText(rule) });
    });

    return {
        variables,
        integers,
        neighborOrder,
        arms,
        name: meta.name ?? null,
        traits: meta.traits ?? [],
        source: meta.source ?? null,
    };
}

// ---- evaluation ----------------------------------------------------------------

function withBindings(context, bindings, run) {
    if (!bindings || bindings.size === 0) return run();
    context.push(new Map(bindings));
    try {
        return run();
    } finally {
        context.pop();
    }
}

/** Fill neighbor integers from their anchors; null when a neighbor has no member. */
function completeBindings(spec, rootValues, neededNeighbors) {
    const values = new Map(rootValues);
    for (const name of spec.neighborOrder) {
        if (!neededNeighbors.includes(name)) continue;
        const info = spec.integers.get(name);
        const anchor = values.get(info.neighbor.of);
        if (anchor === undefined) continue;
        const c = info.constraint;
        const relation = info.neighbor.relation;
        const found = relation === ">" ? c.next(anchor, true)
            : relation === ">=" ? c.next(anchor, false)
                : relation === "<" ? c.prev(anchor, true)
                    : c.prev(anchor, false);
        if (found === null) return null;
        values.set(name, found);
    }
    return values;
}

const asIntegerBindings = (values) => new Map([...values].map(([name, n]) => [name, new Integer(n)]));

/**
 * A bound as an exact box [low, high]: a rational gives [q, q]; an interval,
 * a certified approximation, or a .numerics.Refine record gives its
 * enclosure. null means unbounded.
 */
function evaluateBound(node, bindings, context, evaluate) {
    if (node === null) return null;
    const value = withBindings(context, bindings, () => evaluate(node));
    const box = enclosure(value);
    if (box) return box;
    if (value?.type === "map" && value.entries?.get?.("valuekind")?.value === "numericsAlgorithmReal") {
        throw new Error(`Piecewise bound ${regionText(node)} is a real without an enclosure; use .numerics.Refine(real, {= absoluteWidth=1/10^9 })[:approximation]`);
    }
    throw new Error(`Piecewise bounds must be rational or enclosures; ${regionText(node)} gave ${value?.toString?.() ?? String(value)}`);
}

/** Candidate values for `root` that might make `chain` hold for x in [xlo, xhi], ascending. */
function solveRoot(spec, alt, root, xlo, xhi, context, evaluate) {
    const chain = alt.pins.get(root);
    const info = spec.integers.get(root);
    const constraint = info.constraint;
    if (constraint.empty) return [];
    const needed = alt.neighbors;
    const boundsAt = (k) => {
        const values = completeBindings(spec, new Map([[root, k]]), needed);
        if (values === null) return null;
        const bindings = asIntegerBindings(values);
        return [evaluateBound(chain.lo, bindings, context, evaluate), evaluateBound(chain.hi, bindings, context, evaluate)];
    };
    // Each bound box has a low and a high edge; candidates use the edge that
    // keeps every integer the true bound could admit (0 = low, 1 = high).

    // Affine path: per residue class of the root's shape, with period widened
    // by the moduli of shaped neighbors that depend on it.
    const shape = constraint.shape;
    const neighborShapes = needed.map((name) => spec.integers.get(name).constraint.shape);
    if (shape && neighborShapes.every(Boolean)) {
        let period = shape.mod;
        const g = (a, b) => (b ? g(b, a % b) : a);
        for (const s of neighborShapes) period = (period / g(period, s.mod)) * s.mod;
        const residues = [];
        for (let r = 0n; r < period; r++) if (shape.residues.includes(((r % shape.mod) + shape.mod) % shape.mod)) residues.push(r);
        const ranges = [];
        let affine = true;
        for (const r of residues) {
            const k = (j) => period * j + r;
            let jmin = shape.min === null ? null : -floorDiv(-(shape.min - r), period);
            let jmax = shape.max === null ? null : floorDiv(shape.max - r, period);
            // Sample three members inside the type's bounds.
            const j0 = jmin ?? (jmax !== null ? jmax - 2n : 0n);
            const samples = [j0, j0 + 1n, j0 + 2n].map((j) => boundsAt(k(j)));
            if (samples.some((s) => s === null)) { affine = false; break; }
            const line = (which, edge) => {
                const [f0, f1, f2] = samples.map((s) => s[which]?.[edge] ?? null);
                if (f0 === null) return null;
                const d1 = f1.subtract(f0);
                if (!f2.subtract(f1).equals(d1)) return undefined;
                return { slope: d1, at: (j) => f0.add(d1.multiply(new Rational(j - j0, 1n))), base: f0.subtract(d1.multiply(new Rational(j0, 1n))) };
            };
            const loLow = line(0, 0);
            const loHigh = line(0, 1);
            const hiLow = line(1, 0);
            const hiHigh = line(1, 1);
            if ([loLow, loHigh, hiLow, hiHigh].includes(undefined)) { affine = false; break; }
            // j where base + slope*j <= X (side = "below") or >= X ("above").
            const half = (lineInfo, x, side) => {
                if (!lineInfo) return [null, null];
                const { slope, base } = lineInfo;
                if (slope.equals(ZERO)) {
                    const ok = side === "below" ? cmp(base, x) <= 0 : cmp(base, x) >= 0;
                    return ok ? [null, null] : "empty";
                }
                const t = x.subtract(base).divide(slope);
                const positive = cmp(slope, ZERO) > 0;
                if ((side === "below") === positive) return [null, floorQ(t)];
                return [ceilQ(t), null];
            };
            const clip = (parts) => {
                let a = jmin;
                let b = jmax;
                for (const part of parts) {
                    if (part === "empty") return null;
                    const [pa, pb] = part;
                    if (pa !== null) a = a === null ? pa : maxB(a, pa);
                    if (pb !== null) b = b === null ? pb : minB(b, pb);
                }
                if (a !== null && b !== null && a > b) return null;
                return [a, b];
            };
            // Ascending: lo <= x and x <= hi somewhere in [xlo, xhi].
            const asc = clip([half(loLow, xhi, "below"), half(hiHigh, xlo, "above")]);
            if (asc) ranges.push({ r, k, range: asc });
            if (!chain.oneSided && loLow && hiLow) {
                const desc = clip([half(hiLow, xhi, "below"), half(loHigh, xlo, "above")]);
                if (desc) ranges.push({ r, k, range: desc });
            }
        }
        if (affine) {
            const values = new Set();
            for (const { k, range: [a, b] } of ranges) {
                if (a === null) {
                    throw new Error(`Infinitely many values of ${root} fit the region ${regionText(chain.node)}; bound it on both sides or give ${root} a type with a lower bound, such as ${root}::Natural`);
                }
                const last = b === null ? a + BigInt(PIECE_BUDGET) : b;
                if (last - a > BigInt(PIECE_BUDGET)) {
                    throw new Error(`More than ${PIECE_BUDGET} values of ${root} fit ${regionText(chain.node)} here; narrow the input`);
                }
                for (let j = a; j <= last; j++) values.add(k(j));
            }
            return [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
        }
    }

    // Search path: bounds are assumed to increase with the integer.
    if (chain.lo === null) {
        throw new Error(`Cannot solve ${regionText(chain.node)} for ${root}: its bounds are not affine in ${root}, and the search needs a lower bound`);
    }
    const loAt = (k) => {
        const bounds = boundsAt(k);
        return bounds === null ? null : bounds[0][0];
    };
    const start = constraint.prev(floorQ(xhi)) ?? constraint.next(floorQ(xhi));
    if (start === null) return [];
    let steps = 0;
    const tick = () => {
        if (++steps > INTEGER_SEARCH_BUDGET) throw new Error(`Could not solve ${regionText(chain.node)} for ${root} within ${INTEGER_SEARCH_BUDGET} steps`);
    };
    // Largest K with lo(K) <= xhi.
    let low;
    let high;
    const startLo = loAt(start);
    if (startLo !== null && cmp(startLo, xhi) <= 0) {
        low = start;
        let step = 1n;
        while (true) {
            tick();
            const next = constraint.next(low + step);
            if (next === null) { high = null; break; }
            const v = loAt(next);
            if (v === null || cmp(v, xhi) > 0) { high = next; break; }
            low = next;
            step *= 2n;
        }
    } else {
        high = start;
        let step = 1n;
        while (true) {
            tick();
            const prev = constraint.prev(high - step);
            if (prev === null) return [];
            const v = loAt(prev);
            if (v !== null && cmp(v, xhi) <= 0) { low = prev; break; }
            high = prev;
            step *= 2n;
        }
    }
    while (high !== null) {
        tick();
        const between = constraint.next(low, true);
        if (between === null || between >= high) break;
        let mid = constraint.prev(low + (high - low) / 2n);
        if (mid === null || mid <= low) mid = between;
        const v = loAt(mid);
        if (v !== null && cmp(v, xhi) <= 0) low = mid;
        else high = mid;
    }
    const found = [];
    let k = low;
    while (k !== null) {
        tick();
        const bounds = boundsAt(k);
        if (bounds !== null) {
            if (bounds[1] !== null && cmp(bounds[1][1], xlo) < 0) break;
            found.push(k);
        }
        if (found.length > PIECE_BUDGET) throw new Error(`More than ${PIECE_BUDGET} values of ${root} fit ${regionText(chain.node)} here; narrow the input`);
        k = constraint.prev(k, true);
    }
    return found.reverse();
}

function enclosure(value) {
    if (value instanceof RationalInterval) return cmp(value.low, value.high) <= 0 ? [value.low, value.high] : [value.high, value.low];
    if (value instanceof CertifiedApproximation) return [value.enclosure.low, value.enclosure.high];
    if (value?.type === "map" && value.entries instanceof Map) {
        const inner = value.entries.get("approximation") ?? value.entries.get("interval");
        return inner ? enclosure(inner) : null;
    }
    const q = toQ(value);
    return q ? [q, q] : null;
}

/** Three-state truth of a chain at the current bindings: "truth" | "false" | "undecided". */
function chainState(chain, context, evaluate) {
    const x = withBindings(context, null, () => evaluate({ fn: "RETRIEVE", args: [chain.variable] }));
    const box = enclosure(x);
    if (!box) return decisionState(evaluate(chain.node));
    const [a, b] = box;
    const lo = evaluateBound(chain.lo, null, context, evaluate);
    const hi = evaluateBound(chain.hi, null, context, evaluate);
    // le(p, q, strict): p <= q, or p < q for a strict link; null means unbounded.
    const le = (p, q, strict) => (p === null || q === null ? true : strict ? cmp(p, q) < 0 : cmp(p, q) <= 0);
    const holds = (first, firstStrict, second, secondStrict) => {
        // first ⋈ x ⋈ second for every x in [a, b] and every bound value in
        // the bound boxes, for none, or for some.
        const all = le(first?.[1] ?? null, a, firstStrict) && le(b, second?.[0] ?? null, secondStrict);
        const none = (first !== null && !le(first[0], b, firstStrict)) || (second !== null && !le(a, second[1], secondStrict));
        return all ? "truth" : none ? "false" : "undecided";
    };
    const up = holds(lo, chain.loStrict, hi, chain.hiStrict);
    if (chain.oneSided || lo === null || hi === null) return up;
    const down = holds(hi, chain.hiStrict, lo, chain.loStrict);
    if (up === "truth" || down === "truth") return "truth";
    if (up === "false" && down === "false") return "false";
    return "undecided";
}

function alternativeState(alt, context, evaluate) {
    let state = "truth";
    for (const { node, chain } of alt.conjuncts) {
        const s = chain ? chainState(chain, context, evaluate) : decisionState(evaluate(node));
        if (s === "false" || s === "null") return "false";
        if (s === "undecided") state = "undecided";
    }
    return state;
}

function* combinations(lists, index = 0, prefix = []) {
    if (index === lists.length) {
        yield prefix;
        return;
    }
    for (const item of lists[index]) yield* combinations(lists, index + 1, [...prefix, item]);
}

/**
 * The first arm that holds at the current variable values:
 * { arm, bindings } | { undecided: true } | null.
 */
function locate(spec, context, evaluate) {
    for (const arm of spec.arms) {
        if (arm.isDefault) return { arm, bindings: new Map() };
        for (const alt of arm.alternatives) {
            if (alt.roots.length === 0) {
                const state = alternativeState(alt, context, evaluate);
                if (state === "truth") return { arm, bindings: new Map() };
                if (state === "undecided") return { undecided: true };
                continue;
            }
            const lists = alt.roots.map((root) => {
                const chain = alt.pins.get(root);
                const x = evaluate({ fn: "RETRIEVE", args: [chain.variable] });
                const box = enclosure(x);
                if (!box) throw new Error(`Piecewise needs a rational, interval, or certified value for ${chain.variable}`);
                return solveRoot(spec, alt, root, box[0], box[1], context, evaluate);
            });
            let undecided = false;
            let count = 0;
            for (const combo of combinations(lists)) {
                if (++count > PIECE_BUDGET) throw new Error(`More than ${PIECE_BUDGET} integer combinations to try in ${arm.regionText}`);
                const values = completeBindings(spec, new Map(alt.roots.map((root, i) => [root, combo[i]])), alt.neighbors);
                if (values === null) continue;
                const bindings = asIntegerBindings(values);
                const state = withBindings(context, bindings, () => alternativeState(alt, context, evaluate));
                if (state === "truth") return { arm, bindings };
                if (state === "undecided") undecided = true;
            }
            if (undecided) return { undecided: true };
        }
    }
    return null;
}

function evaluatePoint(spec, context, evaluate) {
    if (spec.derivativeOf) return derivativePoint(spec, context, evaluate);
    const found = locate(spec, context, evaluate);
    if (found === null) return null;
    if (found.undecided) return UNDECIDED;
    return withBindings(context, found.bindings, () => evaluate(found.arm.rule));
}

// ---- derivatives -------------------------------------------------------------------

/**
 * The derivative spec of a one-variable spec: same regions, each rule
 * differentiated. At a breakpoint the value comes from derivativePoint.
 */
function derivativeSpec(spec, variable) {
    if (spec.variables.length !== 1) throw new Error("F' supports one-variable piecewise functions for now");
    for (const arm of spec.arms) {
        if (arm.isDefault) continue;
        for (const alt of arm.alternatives) {
            for (const { node, chain } of alt.conjuncts) {
                if (!chain && namesIn(node).has(variable)) {
                    throw new Error(`F' needs region arms; ${regionText(node)} tests ${variable} directly, so its breakpoints are unknown`);
                }
            }
        }
    }
    const arms = spec.arms.map((arm) => {
        let rule;
        try {
            rule = derivative(arm.rule, variable);
        } catch (error) {
            throw new Error(`F': cannot differentiate the rule ${arm.ruleText}: ${error.message}`);
        }
        return { ...arm, rule, ruleText: regionText(rule) };
    });
    const header = [...spec.integers.values()].map((info) => {
        const neighbor = info.neighbor ? ` ${info.neighbor.relation} ${info.neighbor.of}` : "";
        return `${info.name}${info.typeText}${neighbor}`;
    });
    const body = arms.map((arm) => (arm.isDefault ? arm.ruleText : `${arm.regionText} ? ${arm.ruleText}`)).join("; ");
    const source = `{?: /${spec.variables.join(", ")}${header.length ? `; ${header.join(", ")}` : ""}/ ${body} }`;
    return { ...spec, arms, derivativeOf: spec, name: null, source };
}

const ruleAt = (arm, bindings, context, evaluate) => {
    try {
        return withBindings(context, bindings, () => evaluate(arm.rule));
    } catch {
        return null;
    }
};

/**
 * A derivative at a point. Away from breakpoints it is the differentiated
 * rule. At a breakpoint b it exists only when the function below is defined
 * at b, both neighboring rules of that function meet its value there, and the
 * two differentiated rules agree; otherwise `_`.
 */
function derivativePoint(spec, context, evaluate) {
    const variable = spec.variables[0];
    const box = enclosure(evaluate({ fn: "RETRIEVE", args: [variable] }));
    if (!box) throw new Error(`Piecewise needs a rational, interval, or certified value for ${variable}`);
    const [lo, hi] = box;
    const cuts = breakpoints(spec, variable, lo, hi, context, evaluate);
    if (cuts.length === 0) {
        const found = locate(spec, context, evaluate);
        if (found === null) return null;
        if (found.undecided) return UNDECIDED;
        return withBindings(context, found.bindings, () => evaluate(found.arm.rule));
    }
    if (!lo.equals(hi)) return UNDECIDED;
    const b = lo;
    const ONE = new Rational(1n, 1n);
    const near = breakpoints(spec, variable, b.subtract(ONE), b.add(ONE), context, evaluate);
    const below = near.filter((q) => cmp(q, b) < 0).at(-1) ?? b.subtract(ONE);
    const above = near.find((q) => cmp(q, b) > 0) ?? b.add(ONE);
    const side = (q) => withBindings(context, new Map([[variable, q.add(b).divide(TWO)]]), () => locate(spec, context, evaluate));
    const left = side(below);
    const right = side(above);
    if (left === null || right === null) return null;
    if (left.undecided || right.undecided) return UNDECIDED;
    const source = spec.derivativeOf;
    const value = toQ(evaluatePoint(source, context, evaluate));
    if (value === null) return null;
    const same = (a, c) => a !== null && c !== null && cmp(a, c) === 0;
    const sourceLeft = toQ(ruleAt(source.arms[left.arm.index], left.bindings, context, evaluate));
    const sourceRight = toQ(ruleAt(source.arms[right.arm.index], right.bindings, context, evaluate));
    if (!same(sourceLeft, value) || !same(sourceRight, value)) return null;
    const slopeLeft = toQ(ruleAt(spec.arms[left.arm.index], left.bindings, context, evaluate));
    const slopeRight = toQ(ruleAt(spec.arms[right.arm.index], right.bindings, context, evaluate));
    return same(slopeLeft, slopeRight) ? fromQ(slopeLeft) : null;
}

/** Every finite region endpoint in [a, b] for `variable`, sorted, as Rationals. */
function breakpoints(spec, variable, a, b, context, evaluate) {
    const points = new Map();
    const uncertain = new Map();
    const put = (q) => {
        if (cmp(q, a) < 0 || cmp(q, b) > 0) return;
        points.set(q.toString(), q);
        if (points.size > PIECE_BUDGET) throw new Error(`More than ${PIECE_BUDGET} breakpoints in ${a}:${b}; narrow the interval`);
    };
    // An enclosure bound contributes both edges, and is remembered as uncertain.
    const add = (box) => {
        if (box === null) return;
        const [p, q] = box;
        if (p.equals(q)) return put(p);
        if (cmp(q, a) < 0 || cmp(p, b) > 0) return;
        uncertain.set(`${p}:${q}`, [p, q]);
        put(p);
        put(q);
    };
    for (const arm of spec.arms) {
        if (arm.isDefault) continue;
        for (const alt of arm.alternatives) {
            for (const { node, chain } of alt.conjuncts) {
                if (!chain) {
                    if (namesIn(node).has(variable)) {
                        throw new Error(`Interval input needs region arms; ${regionText(node)} tests ${variable} directly`);
                    }
                    continue;
                }
                if (chain.variable !== variable) continue;
                const chainRoots = alt.roots.filter((root) => alt.pins.get(root) === chain);
                const others = alt.roots.filter((root) => alt.pins.get(root) !== chain);
                if (others.length) {
                    throw new Error(`Interval input on ${variable} is not supported when ${regionText(chain.node)} shares integers with other chains`);
                }
                if (chainRoots.length === 0) {
                    add(evaluateBound(chain.lo, null, context, evaluate));
                    add(evaluateBound(chain.hi, null, context, evaluate));
                    continue;
                }
                const root = chainRoots[0];
                for (const k of solveRoot(spec, alt, root, a, b, context, evaluate)) {
                    const values = completeBindings(spec, new Map([[root, k]]), alt.neighbors);
                    if (values === null) continue;
                    const bindings = asIntegerBindings(values);
                    add(evaluateBound(chain.lo, bindings, context, evaluate));
                    add(evaluateBound(chain.hi, bindings, context, evaluate));
                }
            }
        }
    }
    const sorted = [...points.values()].sort(cmp);
    sorted.uncertain = [...uncertain.values()];
    return sorted;
}

function hullOf(values) {
    let low = null;
    let high = null;
    for (const value of values) {
        const box = value instanceof RationalInterval ? [value.low, value.high] : toQ(value) ? [toQ(value), toQ(value)] : null;
        if (!box) throw new Error(`Interval input needs numeric rules; a piece gave ${value?.toString?.() ?? String(value)}`);
        if (low === null || cmp(box[0], low) < 0) low = box[0];
        if (high === null || cmp(box[1], high) > 0) high = box[1];
    }
    if (low.equals(high)) return fromQ(low);
    return new RationalInterval(low, high);
}

function evaluateInterval(spec, variable, interval, context, evaluate) {
    const a = interval.low;
    const b = interval.high;
    if (a.equals(b)) return withBindings(context, new Map([[variable, fromQ(a)]]), () => evaluatePoint(spec, context, evaluate));
    const cuts = breakpoints(spec, variable, a, b, context, evaluate).filter((q) => cmp(q, a) > 0 && cmp(q, b) < 0);
    const nodes = [a, ...cuts, b];
    const results = [];
    for (const point of nodes) {
        const value = withBindings(context, new Map([[variable, fromQ(point)]]), () => evaluatePoint(spec, context, evaluate));
        if (value === null || isUndecided(value)) return value;
        results.push(value);
    }
    for (let i = 0; i + 1 < nodes.length; i++) {
        const left = nodes[i];
        const right = nodes[i + 1];
        const mid = left.add(right).divide(TWO);
        const found = withBindings(context, new Map([[variable, mid]]), () => locate(spec, context, evaluate));
        if (found === null) return null;
        if (found.undecided) return UNDECIDED;
        const piece = new RationalInterval(left, right);
        const bindings = new Map([...found.bindings, [variable, piece]]);
        const value = withBindings(context, bindings, () => evaluate(found.arm.rule));
        if (value === null || isUndecided(value)) return value;
        results.push(value);
    }
    return hullOf(results);
}

function evaluateCall(spec, context, evaluate) {
    const intervalVars = [];
    for (const name of spec.variables) {
        const value = evaluate({ fn: "RETRIEVE", args: [name] });
        if (value instanceof RationalInterval && !value.low.equals(value.high)) intervalVars.push([name, value]);
    }
    if (intervalVars.length > 1) {
        throw new Error("Interval input on more than one piecewise variable is not supported yet");
    }
    if (intervalVars.length === 1) {
        return evaluateInterval(spec, intervalVars[0][0], intervalVars[0][1], context, evaluate);
    }
    return evaluatePoint(spec, context, evaluate);
}

// ---- values ----------------------------------------------------------------------

export function isPiecewise(value) {
    return Boolean(value?.__piecewise);
}

function piecewiseOf(value, who) {
    if (!isPiecewise(value)) throw new Error(`${who} expects a piecewise function made with {?: ... }`);
    return value.__piecewise;
}

function asInterval(value, who) {
    if (value instanceof RationalInterval) return value;
    const q = toQ(value);
    if (q) return new RationalInterval(q, q);
    throw new Error(`${who} expects an interval such as 0:10`);
}

function piecewiseValue(spec, closureScopes) {
    const value = {
        type: "lambda",
        params: {
            positional: spec.variables.map((name) => ({ name, holeDefault: null })),
            keyword: [],
            conditionals: [],
            prep: [],
            prepStrict: false,
            prepUndecided: "stop",
            metadata: {},
        },
        body: { fn: "PIECEWISE_EVAL", args: [spec] },
        __closureScopes: closureScopes,
        ...(spec.name ? { __name: spec.name } : {}),
    };
    Object.defineProperty(value, "__piecewise", { value: spec, enumerable: false, configurable: true });
    Object.defineProperty(value, "__derive", {
        value: (variable) => {
            const name = variable ?? spec.variables[0];
            if (!spec.variables.includes(name)) throw new Error(`F': ${name} is not a variable of this piecewise function`);
            return piecewiseValue(derivativeSpec(spec, name), closureScopes);
        },
        enumerable: false,
        configurable: true,
    });
    return value;
}

export const piecewiseFunctions = {
    PIECEWISE: {
        lazy: true,
        impl(args, context, evaluate) {
            const meta = args[0];
            const spec = buildSpec(meta, args.slice(1), context, evaluate);
            return piecewiseValue(spec, context.captureClosureScopes());
        },
        doc: "Build a piecewise function from {?: /variables; integers/ region ? rule; ...; default }",
    },

    PIECEWISE_EVAL: {
        lazy: true,
        impl(args, context, evaluate) {
            return evaluateCall(args[0], context, evaluate);
        },
        doc: "Evaluate a piecewise function body at the bound variables",
    },

    PIECES: {
        impl(args) {
            const spec = piecewiseOf(args[0], ".Pieces");
            return seq(spec.arms.map((arm) => {
                const usedInts = arm.isDefault ? [] : [...new Set(arm.alternatives.flatMap((alt) => [...alt.roots, ...alt.neighbors]))];
                return rixMap([
                    ["region", arm.isDefault ? null : stringObj(arm.regionText)],
                    ["integers", seq(usedInts.map((name) => {
                        const info = spec.integers.get(name);
                        const neighbor = info.neighbor ? ` ${info.neighbor.relation} ${info.neighbor.of}` : "";
                        return stringObj(`${name}${info.typeText}${neighbor}`);
                    }))],
                    ["rule", stringObj(arm.ruleText)],
                    ["default", arm.isDefault ? new Integer(1n) : null],
                ]);
            }));
        },
        doc: "List a piecewise function's arms as maps with region, integers, rule, and default",
    },

    BREAKS: {
        lazy: true,
        impl(args, context, evaluate) {
            const fnValue = evaluate(args[0]);
            const spec = piecewiseOf(fnValue, ".Breaks");
            const range = asInterval(evaluate(args[1]), ".Breaks");
            const variable = args.length > 2 ? String(evaluate(args[2])?.value ?? spec.variables[0]) : spec.variables[0];
            if (!spec.variables.includes(variable)) throw new Error(`.Breaks: ${variable} is not a variable of this piecewise function`);
            if (spec.variables.length > 1) throw new Error(".Breaks supports one-variable piecewise functions for now");
            const closures = Array.isArray(fnValue.__closureScopes) ? fnValue.__closureScopes : [];
            let pushed = 0;
            try {
                for (const closure of closures) {
                    context.push(closure instanceof Map ? closure : closure.bindings, {
                        scopedEnv: closure.scopedEnv,
                        isolated: closure.isolated === true,
                        readThrough: closure.readThrough === true,
                        callableBoundary: closure.callableBoundary === true,
                    });
                    pushed++;
                }
                context.push(new Map([[variable, fromQ(range.low)]]));
                pushed++;
                const points = breakpoints(spec, variable, range.low, range.high, context, evaluate);
                const inside = (q) => points.uncertain.some(([p, r]) => cmp(p, q) <= 0 && cmp(q, r) <= 0);
                const items = [
                    ...points.filter((q) => !inside(q)).map((q) => [q, fromQ(q)]),
                    ...points.uncertain.map(([p, r]) => [p, new RationalInterval(p, r)]),
                ].sort((x, y) => cmp(x[0], y[0]));
                return seq(items.map(([, value]) => value));
            } finally {
                for (let i = 0; i < pushed; i++) context.pop();
            }
        },
        doc: "Sorted region endpoints of a one-variable piecewise function inside an interval",
    },

    INTEGER_TYPE: {
        impl(args, context) {
            if (args.length < 2) throw new Error(".IntegerType(:Name, {= mod=..., residues=[...], min=..., max=... })");
            registerIntegerTypeFromRix(args[0], args[1], context);
            return args[0];
        },
        doc: "Register an integer subtype from a shape {= mod, residues, min, max }",
    },
};

// Exposed for tests.
export const __piecewiseInternals = { regionText, chainInfo, PIECE_BUDGET };
