// RiX unit and quantity values on top of @ratmath/core/units.
//
// Core owns the mathematics: the unit catalogue, dimensions, exact conversion
// factors (a rational times a power of pi), affine temperatures, SI and binary
// prefixes and unit-expression parsing. This file only gives Core's Unit and
// Quantity a RiX shape:
//
//   unit      { type: "unit", name, symbol, dimensions, core, _ext }   a named unit
//   unit_expr { type: "unit_expr", name, dimensions, core }            a product or power
//   quantity  { type: "quantity", core, displayUnit, dimensions, affinePoint, baseMagnitude }
//
// Magnitudes go through RiX's own scalar arithmetic (exact generators such as
// pi, algebraic numbers, intervals), so 180~[deg] converts to exactly 1~{pi}~[rad].
// The .Units collection stays an ordinary RiX map; parsing a unit expression
// looks names up in the active collection, with SI prefixes on the units that
// take them.

import { Integer, RationalInterval, Relation, TypePromotion, possibleRelations } from "@ratmath/core";
import {
    Quantity as CoreQuantity,
    Unit as CoreUnit,
    UnitSystem,
    coreScalars,
    dimensionsEqual as coreDimensionsEqual,
    units as coreUnits,
} from "@ratmath/core/units";
import {
    addScalars,
    createDefaultExactCollection,
    divideScalars,
    equalScalars,
    isExactValue,
    isRationalScalar,
    multiplyScalars,
    negateScalar,
    powScalar,
    subtractScalars,
} from "./exact-values.js";
import { UNDECIDED } from "./decision.js";

function int(value) {
    return new Integer(BigInt(value));
}

function stringValue(value, label = "name") {
    if (typeof value === "string") return value;
    if (value?.type === "string") return value.value;
    throw new Error(`${label} must be a string or colon string`);
}

export function isScalar(value) {
    return isRationalScalar(value) || value instanceof RationalInterval || isExactValue(value);
}

// ---------------------------------------------------------------------------
// RiX scalar arithmetic for Core's UnitSystem

const isInterval = (value) => value instanceof RationalInterval;

class ExactOrderError extends Error {}

function integerExponent(value) {
    if (value instanceof Integer) return Number(value.value);
    if (typeof value === "number" && Number.isInteger(value)) return value;
    throw new Error("Unit exponent must be an integer");
}

const defaultPi = createDefaultExactCollection()?.entries?.get("pi") ?? null;

const rixScalars = Object.freeze({
    isScalar,
    from(value) {
        if (isScalar(value)) return value;
        throw new Error("A unit must be applied to an exact scalar value");
    },
    add: (a, b) => (isInterval(a) || isInterval(b) ? TypePromotion.add(a, b) : addScalars(a, b)),
    subtract: (a, b) => (isInterval(a) || isInterval(b) ? TypePromotion.subtract(a, b) : subtractScalars(a, b)),
    multiply: (a, b) => (isInterval(a) || isInterval(b) ? TypePromotion.multiply(a, b) : multiplyScalars(a, b)),
    divide: (a, b) => (isInterval(a) || isInterval(b) ? TypePromotion.divide(a, b) : divideScalars(a, b)),
    negate: (a) => (isInterval(a) ? TypePromotion.negate(a) : negateScalar(a)),
    pow: (a, n) => (isInterval(a) ? a.pow(n) : powScalar(a, int(n))),
    relation(a, b) {
        if (isExactValue(a) || isExactValue(b)) {
            if (equalScalars(a, b)) return Relation.EQUAL;
            throw new ExactOrderError("Exact symbolic quantity expressions are not ordered");
        }
        return possibleRelations(a, b);
    },
    pi: (k) => (defaultPi ? powScalar(defaultPi, int(k)) : coreScalars.pi(k)),
});

// Every RiX quantity lives in this system: Core's catalogue with RiX scalars.
const RIX_SYSTEM = coreUnits.extend({ scalars: rixScalars });

// ---------------------------------------------------------------------------
// Units

const unitWrappers = new WeakMap();

function unitExt(name) {
    return new Map([["key", { type: "string", value: name }], ["immutable", int(1)]]);
}

function wrapUnit(core) {
    let value = unitWrappers.get(core);
    if (value) return value;
    value = core.isNamed
        ? Object.freeze({
            type: "unit",
            name: core.name,
            symbol: core.name,
            dimensions: core.dimensions,
            core,
            _ext: unitExt(core.name),
        })
        : Object.freeze({
            type: "unit_expr",
            name: core.toString(),
            dimensions: core.dimensions,
            core,
        });
    unitWrappers.set(core, value);
    return value;
}

function coreUnit(value) {
    if (!isUnitValue(value)) throw new Error("Expected a Unit or UnitExpr");
    return value.core;
}

/**
 * A RiX unit value. Options: dimensions, scale (exact rational), offset,
 * affine, difference, differenceUnit (a RiX unit), piPower, prefixes.
 */
export function createUnit(name, options = {}) {
    return wrapUnit(new CoreUnit(name, {
        dimensions: options.dimensions,
        scale: options.scale,
        piPower: options.piPower,
        offset: options.affine ? options.offset : undefined,
        kind: options.affine ? "affine" : options.difference ? "difference" : "linear",
        differenceUnit: options.differenceUnit ? coreUnit(options.differenceUnit) : null,
        prefixes: options.prefixes,
    }));
}

export function isUnitValue(value) {
    return (value?.type === "unit" || value?.type === "unit_expr") && value.core instanceof CoreUnit;
}

export function multiplyUnits(left, right) {
    return wrapUnit(coreUnit(left).multiply(coreUnit(right)));
}

export function divideUnits(left, right) {
    return wrapUnit(coreUnit(left).divide(coreUnit(right)));
}

export function invertUnit(unit) {
    return wrapUnit(coreUnit(unit).inverse());
}

export function powUnit(unit, exponentValue) {
    return wrapUnit(coreUnit(unit).pow(integerExponent(exponentValue)));
}

export function unitsEquivalent(left, right) {
    return coreUnit(left).equals(coreUnit(right));
}

export function formatUnit(unit) {
    return coreUnit(unit).toString();
}

// ---------------------------------------------------------------------------
// Quantities

function wrapQuantity(core) {
    let base;
    return {
        type: "quantity",
        core,
        displayUnit: wrapUnit(core.unit),
        dimensions: core.dimensions,
        affinePoint: core.point,
        // The magnitude in coherent SI base units (offsets applied for points).
        get baseMagnitude() {
            if (base === undefined) base = core.toBase().value;
            return base;
        },
    };
}

// A plain scalar or a wrapped quantity from a Core result.
function fromCore(result) {
    return result instanceof CoreQuantity ? wrapQuantity(result) : result;
}

export function isQuantity(value) {
    return value?.type === "quantity" && value.core instanceof CoreQuantity;
}

function coreQuantity(value) {
    if (!isQuantity(value)) throw new Error("Expected a quantity");
    return value.core;
}

export function constructQuantity(magnitude, unit) {
    if (!isScalar(magnitude)) throw new Error("A unit must be applied to an exact scalar value");
    if (!isUnitValue(unit)) throw new Error("Quantity construction requires a Unit or UnitExpr");
    return wrapQuantity(new CoreQuantity(magnitude, unit.core, { system: RIX_SYSTEM }));
}

/** The magnitude in the quantity's own display unit. */
export function displayMagnitude(quantity) {
    return coreQuantity(quantity).value;
}

export function convertQuantity(quantity, target) {
    if (!isQuantity(quantity)) throw new Error("ConvertUnit expects a quantity");
    if (!isUnitValue(target)) throw new Error("ConvertUnit target must be a Unit or UnitExpr");
    return wrapQuantity(quantity.core.to(target.core));
}

export function addQuantities(left, right) {
    return wrapQuantity(coreQuantity(left).add(coreQuantity(right)));
}

export function subtractQuantities(left, right) {
    return wrapQuantity(coreQuantity(left).subtract(coreQuantity(right)));
}

export function negateQuantity(quantity) {
    return wrapQuantity(coreQuantity(quantity).negate());
}

export function multiplyQuantityValues(left, right) {
    if (isQuantity(left)) return fromCore(left.core.multiply(isQuantity(right) ? right.core : right));
    if (!isQuantity(right)) throw new Error("Quantity multiplication requires a scalar or quantity");
    if (!isScalar(left)) throw new Error("Quantity multiplication requires a scalar or quantity");
    return fromCore(right.core.multiply(left));
}

export function divideQuantityValues(left, right) {
    if (isQuantity(left)) {
        if (!isQuantity(right) && !isScalar(right)) throw new Error("Unsupported quantity division");
        return fromCore(left.core.divide(isQuantity(right) ? right.core : right));
    }
    if (isScalar(left) && isQuantity(right)) return fromCore(right.core.inverse().multiply(left));
    throw new Error("Unsupported quantity division");
}

export function powQuantity(quantity, exponentValue) {
    return fromCore(coreQuantity(quantity).pow(integerExponent(exponentValue)));
}

function relationMask(left, right) {
    return coreQuantity(left).relation(coreQuantity(right));
}

export function quantitiesEqual(left, right) {
    if (!coreDimensionsEqual(left.dimensions, right.dimensions)) return false;
    try {
        return relationMask(left, right) === Relation.EQUAL;
    } catch (error) {
        if (error instanceof ExactOrderError) return false;
        throw error;
    }
}

export function quantityRelation(left, right, operation) {
    if (!coreDimensionsEqual(left.dimensions, right.dimensions)) {
        if (operation === "eq") return false;
        if (operation === "neq") return true;
    }
    let mask;
    try {
        mask = relationMask(left, right);
    } catch (error) {
        if (!(error instanceof ExactOrderError)) throw error;
        if (operation === "eq") return false;
        if (operation === "neq") return true;
        throw error;
    }
    switch (operation) {
    case "eq": return mask === Relation.EQUAL ? true : (mask & Relation.EQUAL) === 0 ? false : UNDECIDED;
    case "neq": return mask === Relation.EQUAL ? false : (mask & Relation.EQUAL) === 0 ? true : UNDECIDED;
    case "lt": return mask === Relation.LESS ? true : (mask & Relation.LESS) === 0 ? false : UNDECIDED;
    case "gt": return mask === Relation.GREATER ? true : (mask & Relation.GREATER) === 0 ? false : UNDECIDED;
    case "lte": return (mask & Relation.GREATER) === 0 ? true : mask === Relation.GREATER ? false : UNDECIDED;
    case "gte": return (mask & Relation.LESS) === 0 ? true : mask === Relation.LESS ? false : UNDECIDED;
    default: throw new Error(`Unknown quantity relation '${operation}'`);
    }
}

export function compareQuantities(left, right) {
    return coreQuantity(left).compare(coreQuantity(right));
}

export function dimensionsEqual(left, right) {
    return coreDimensionsEqual(left, right);
}

// A unit written directly after a fraction binds to its denominator, so a
// fractional magnitude is printed with a space: `1/2 ~[m]` reads back as half
// a metre.
export function formatQuantity(quantity, formatScalar) {
    const magnitude = formatScalar(displayMagnitude(quantity));
    const separator = /^-?\d+\/\d+$/.test(magnitude) ? " " : "";
    return `${magnitude}${separator}~[${formatUnit(quantity.displayUnit)}]`;
}

// ---------------------------------------------------------------------------
// The .Units collection

const collectionSystems = new WeakMap();

function checkCollection(collection) {
    if (!collection || collection.type !== "map" || !(collection.entries instanceof Map)) {
        throw new Error("Active Units value must be a RiX map collection");
    }
}

// A Core UnitSystem holding exactly the units in a RiX collection, so lookups
// (and SI prefixes) see only what the collection offers.
function systemFor(collection) {
    checkCollection(collection);
    const cached = collectionSystems.get(collection.entries);
    if (cached && cached.size === collection.entries.size) return cached.system;
    const system = new UnitSystem({ scalars: rixScalars });
    for (const [key, value] of collection.entries) {
        if (!isUnitValue(value)) continue;
        // Lower-cased copies (hz, degc) are there for RiX's case-folded
        // :name lookups; they resolve, but take no prefixes.
        const folded = key !== value.core.name && !CORE_KEYS.has(key);
        system.register(String(key), value.core, { replace: true, prefixes: !folded });
    }
    collectionSystems.set(collection.entries, { system, size: collection.entries.size });
    return system;
}

export function parseUnitExpression(source, collection) {
    return wrapUnit(systemFor(collection).parse(String(source)));
}

export function defineUnitFromValue(nameValue, definition) {
    const name = stringValue(nameValue, "Unit name");
    const scratch = new UnitSystem({ scalars: rixScalars });
    if (isUnitValue(definition)) {
        if (definition.core.kind === "affine") throw new Error("DefineUnit expects a linear Unit or Quantity definition");
        return wrapUnit(scratch.define(name, definition.core));
    }
    if (!isQuantity(definition) || definition.affinePoint) {
        throw new Error("DefineUnit expects a linear Unit or Quantity definition");
    }
    return wrapUnit(scratch.define(name, definition.core));
}

const CORE_KEYS = new Set(coreUnits.names());

/**
 * The default .Units collection: Core's catalogue under every name and alias,
 * plus lower-cased copies (hz, degc) for RiX's case-folded :name lookups.
 */
export function createDefaultUnitCollection() {
    const entries = new Map();
    for (const name of CORE_KEYS) entries.set(name, wrapUnit(coreUnits.get(name)));
    for (const name of CORE_KEYS) {
        const lower = name.toLowerCase();
        if (!entries.has(lower)) entries.set(lower, entries.get(name));
    }
    return {
        type: "map",
        entries,
        _ext: new Map([["immutable", int(1)]]),
    };
}

export function unitName(value) {
    return stringValue(value, "Unit name");
}
