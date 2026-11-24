import { describe, expect, test } from "bun:test";
import { parseAndEvaluate, parseAndEvaluateAsync } from "../../src/eval/evaluator.js";
import { formatValue } from "../../src/eval/format.js";
import { parse } from "../../src/parser/parser.js";
import { tokenize } from "../../src/parser/tokenizer.js";
import { lower } from "../../src/eval/lower.js";
import { formatRix } from "../../src/tools/language-service/formatter.js";

const text = (code) => formatValue(parseAndEvaluate(code));
const fails = (code) => {
    try {
        parseAndEvaluate(code);
    } catch (error) {
        return error.message;
    }
    throw new Error(`expected an error from: ${code}`);
};

const WAVES = `
Saw    := {?: /x; n/ n:x:!n+1 ? x - n };
Square := {?: /x; n/ 2n:x:!2n+1 ? 1; -1 };
Tri    := {?: /x; n/ 2n:x:!2n+1 ? x - 2n; 2n+1:x:!2n+2 ? 2n+2 - x };
Floor  := {?: /x; n/ n:x:!n+1 ? n };
`;

describe("piecewise syntax", () => {
    test("{?: is one token and needs a space or header after it", () => {
        const values = tokenize("{?: /x/ 1 }").filter((t) => t.type !== "End").map((t) => t.value);
        expect(values[0]).toBe("{?:");
        expect(() => tokenize("{?:x 1 }")).toThrow("Piecewise opener");
    });

    test("the header declares variables, typed integers, neighbors, a name and traits", () => {
        const [node] = parse("{?: /x, y; n::Natural::!Even, m::Odd > n #Tiles :periodic/ n:x:!m ? 1; 0 }");
        expect(node.type).toBe("PiecewiseContainer");
        expect(node.header).toMatchObject({
            variables: ["x", "y"],
            integers: [
                { name: "n", types: [{ name: "Natural", exclude: false }, { name: "Even", exclude: true }] },
                { name: "m", types: [{ name: "Odd", exclude: false }], neighbor: { relation: ">", of: "n" } },
            ],
            name: "Tiles",
            traits: ["periodic"],
        });
        expect(node.sourceText).toBe("{?: /x, y; n::Natural::!Even, m::Odd > n #Tiles :periodic/ n:x:!m ? 1; 0 }");
    });

    test("the header is required and names start lowercase", () => {
        expect(() => parse("{?: x ? 1 }")).toThrow("/variables; integers/ header");
        expect(() => parse("{?: /X/ 1 }")).toThrow("lowercase letter");
        expect(() => parse("{?: /x; n #a #b/ 1 }")).toThrow("only specify one name");
    });

    test("a union arm keeps the whole union as its region", () => {
        const [ir] = lower(parse("{?: /x/ _:x:!-1 || 1:!x:_ ? 1; 0 }"));
        expect(ir.fn).toBe("PIECEWISE");
        expect(ir.args[1].args[0].fn).toBe("CONDITION");
        expect(ir.args[1].args[0].args[0].fn).toBe("OR");
    });

    test("a rule that starts with a parenthesis is still the rule", () => {
        expect(text("Alt := {?: /x; n/ n:x:!n+1 ? (-1)^n (x - n) }; [Alt(3/2), Alt(5/2)]")).toBe("[-1/2, 1/2]");
        expect(text("F := {?: /x/ _:x:!0 || 3:x:_ ? (x); 0 }; [F(-1), F(1), F(4)]")).toBe("[-1, 0, 4]");
    });

    test("rix format leaves a piecewise literal as written and is stable", () => {
        const source = "Square := {?: /x; n::Natural/ 2n:x:!2n+1 ? 1; -1 };\n";
        const once = formatRix(source);
        expect(once).toContain("{?: /x; n::Natural/ 2n:x:!2n+1 ? 1");
        expect(formatRix(once)).toBe(once);
    });
});

describe("piecewise evaluation", () => {
    test("plain pieces, first match wins, default last", () => {
        expect(text("Ramp := {?: /x/ _:x:!0 ? 0; 0:x:!1 ? x; 1 }; [Ramp(-3), Ramp(0), Ramp(1/2), Ramp(1), Ramp(9)]"))
            .toBe("[0, 0, 1/2, 1, 1]");
        expect(text("F := {?: /x/ 0:x:2 ? 1; 1:x:3 ? 2; 3 }; [F(1), F(5/2), F(4)]")).toBe("[1, 2, 3]");
    });

    test("integer binders are solved: sawtooth, square, triangle, floor", () => {
        expect(text(`${WAVES} [Saw(7/2), Saw(-1/3), Saw(0), Square(5/2), Square(3/2), Square(-1/2)]`))
            .toBe("[1/2, 2/3, 0, 1, -1, -1]");
        expect(text(`${WAVES} [Tri(1/2), Tri(3/2), Tri(-1/2), Tri(2), Floor(-7/3), Floor(5), Floor(10^30 + 1/2)]`))
            .toBe("[1/2, 1/2, 1/2, 0, -3, 5, 1000000000000000000000000000000]");
    });

    test("overlapping copies pick the smallest integer", () => {
        expect(text("F := {?: /x; n/ n:x:n+2 ? n }; [F(5/2), F(3)]")).toBe("[1, 1]");
    });

    test("a gap gives _", () => {
        expect(text("Half := {?: /x/ 0:x:1 ? x }; [Half(2), Half(-1), Half(1)]")).toBe("[_, _, 1]");
        expect(text("SawPos := {?: /x; n::Natural/ n:x:!n+1 ? x - n }; [SawPos(-1/2), SawPos(5/2)]")).toBe("[_, 1/2]");
    });

    test("unions with ||, descending chains, and strict links", () => {
        expect(text("Out := {?: /x/ _:x:!-1 || 1:!x:_ ? 1; 0 }; [Out(-2), Out(-1), Out(0), Out(1), Out(2)]"))
            .toBe("[1, 0, 0, 0, 1]");
        expect(text("D := {?: /x/ 3:x:!1 ? 1; 0 }; [D(3), D(2), D(1)]")).toBe("[1, 1, 0]");
    });

    test("outer names in bounds and rules are read at each call", () => {
        expect(text("a := 2; Bump := {?: /x/ -a:x:a ? a^2 - x^2; 0 }; b := Bump(1); a ~= 1; [b, Bump(1), Bump(1/2)]"))
            .toBe("[3, 0, 3/4]");
        expect(text("p := 3; Pulse := {?: /x; n/ (n p):x:!(n p + 1) ? 1; 0 }; [Pulse(31/10), Pulse(5/2), Pulse(-29/10)]"))
            .toBe("[1, 0, 1]");
    });

    test("predicate arms work at points", () => {
        expect(text("In2 := {?: /x/ x^2 < 2 ? 1; 0 }; [In2(7/5), In2(3/2)]")).toBe("[1, 0]");
    });

    test("a region conjunct may test the integer too", () => {
        expect(text("F := {?: /x; n/ n:x:!n+1 && n % 3 == 0 ? n; _ }; [F(1/2), F(3/2), F(7/2)]")).toBe("[0, _, 3]");
    });

    test("the value is callable everywhere a lambda is", () => {
        expect(text(`${WAVES} [1/2, 3/2, 5/2] |>> Square`)).toBe("[1, -1, 1]");
        expect(text(`${WAVES} G := (x) -> Saw(x) + Floor(x); G(7/2)`)).toBe("3..1/2");
    });

    test("display shows the source", () => {
        expect(text("{?: /x; n/ n:x:!n+1 ? x - n }")).toBe("[Piecewise: {?: /x; n/ n:x:!n+1 ? x - n }]");
    });

    test("async evaluation gives the same values", async () => {
        const value = await parseAndEvaluateAsync(`${WAVES} [Saw(7/2), Square(3/2), Tri(0:3)]`);
        expect(formatValue(value)).toBe("[1/2, -1, 0:1]");
    });
});

describe("piecewise integer types and neighbors", () => {
    test("typed integers restrict the solved integer", () => {
        expect(text("F := {?: /x; n::Positive::!Even/ n:x:!n+1 ? n }; [F(7/2), F(5/2), F(-1/2)]")).toBe("[3, _, _]");
        expect(text("F := {?: /x; n::Negative/ n:x:!n+1 ? n }; [F(-1/2), F(1/2)]")).toBe("[-1, _]");
        expect(text(".IntegerType(:ThreeMod4, {= mod=4, residues=[3], min=0 }); T := {?: /x; n::ThreeMod4/ n:x:!n+1 ? n }; [T(7/2), T(15/2), T(8), T(-1/2)]"))
            .toBe("[3, 7, _, _]");
    });

    test("neighbor binders pick the nearest member above or below", () => {
        expect(text("Step := {?: /x; n::Even, m::Odd > n/ n:x:!m ? 1; 0 }; [Step(1/2), Step(3/2), Step(-2)]")).toBe("[1, 0, 1]");
        expect(text("Back := {?: /x; n::Even, m::Odd < n/ m:!x:n ? 1; 0 }; [Back(3/2), Back(1/2), Back(2)]")).toBe("[1, 0, 1]");
        expect(text("F := {?: /x; n::Even, m::Even >= n/ n:x:!m+1 ? m - n }; F(1/2)")).toBe("0");
    });

    test("types without a shape use validate, and a bound keeps the search finite", () => {
        const setup = `
            IsPrime := (n) -> n >= 2 && {@ d := 2; d*d <= @n && @n % d != 0; ; d += 1; d*d > @n };
            .TypeRegister({= name=:Prime, nativeType=:integer, validate=IsPrime });
            Gap := {?: /x; p::Natural::Prime, q::Prime > p/ p:x:!q ? x - p };
        `;
        expect(text(`${setup} [Gap(5), Gap(6), Gap(8), Gap(25/2), Gap(1)]`)).toBe("[0, 1, 1, 1..1/2, _]");
        expect(text(`${setup} .Breaks(Gap, 0:12)`)).toBe("[2, 3, 5, 7, 11]");
        expect(text(`${setup} Gap(6:12)`)).toBe("0:4");
    });
});

describe("piecewise inputs that are not single rationals", () => {
    test("interval input returns the hull over the pieces", () => {
        expect(text("Ramp := {?: /x/ _:x:!0 ? 0; 0:x:!1 ? x; 1 }; [Ramp(1/4:3/2), Ramp(-2:-1), Ramp(2:2)]")).toBe("[1/4:1, 0, 1]");
        expect(text(`${WAVES} [Saw(1/2:3/2), Square(0:3), Tri(1/4:1/2)]`)).toBe("[0:1, -1:1, 1/4:1/2]");
    });

    test("interval input over a gap gives _", () => {
        expect(text("Half := {?: /x/ 0:x:1 ? x }; Half(1/2:2)")).toBe("_");
    });

    test("interval input needs region arms", () => {
        expect(fails("In2 := {?: /x/ x^2 < 2 ? 1; 0 }; In2(0:2)")).toContain("Interval input needs region arms");
    });

    test("a certified value straddling a breakpoint gives ?", () => {
        expect(text(`${WAVES} [Saw(2.9?), Square(0.99?)]`)).toBe("[?, ?]");
        expect(text("S := {?: /x/ 0:x:!1 ? 1; 0 }; [S(1.0?), S(0.5?)]")).toBe("[0, 1]");
    });
});

describe("several variables", () => {
    test("separable, coupled and predicate regions evaluate at points", () => {
        expect(text("C := {?: /x, y; n, m/ n:x:!n+1 && m:y:!m+1 ? (-1)^(n+m) }; [C(1/2, 3/2), C(5/2, 7/2), C(1/2, 1/2)]"))
            .toBe("[-1, -1, 1]");
        expect(text("U := {?: /x, y/ 0:x:1 && 0:y:x ? 1; 0 }; [U(1/2, 1/4), U(1/2, 3/4), U(1/2, 1/4:3/4)]")).toBe("[1, 0, 0:1]");
        expect(text("D := {?: /x, y/ x^2 + y^2 < 1 ? 1; 0 }; [D(1/2, 1/2), D(1, 0)]")).toBe("[1, 0]");
    });

    test("interval input on two variables at once is not supported yet", () => {
        expect(fails("U := {?: /x, y/ 0:x:1 && 0:y:x ? 1; 0 }; U(0:1, 0:1)")).toContain("more than one piecewise variable");
    });
});

describe("introspection", () => {
    test(".Breaks lists region endpoints inside an interval", () => {
        expect(text(`${WAVES} [.Breaks(Square, 0:3), .Breaks(Saw, -1/2:1/2)]`)).toBe("[[0, 1, 2, 3], [0]]");
    });

    test(".Pieces lists region text, integers and rules", () => {
        expect(text("F := {?: /x; n::Natural/ n:x:!n+1 ? x - n; 0 }; .Pieces(F)"))
            .toBe("[{= region=n:x:!n+1, integers=[n::Natural], rule=x-n, default=_ }, {= region=_, integers=[], rule=0, default=1 }]");
    });
});

describe("piecewise construction errors", () => {
    test("the default must be last and may not use an integer", () => {
        expect(fails("{?: /x/ 1; 0:x:1 ? 2 }")).toContain("must be the last arm");
        expect(fails("{?: /x; n/ n:x:!n+1 ? 1; n }")).toContain("default arm uses n");
    });

    test("every integer an arm uses must be fixed by one of its chains", () => {
        expect(fails("{?: /x; n/ 0:x:1 ? n }")).toContain("the rule uses n");
        expect(fails("{?: /x; n, m/ n:x:!n+m ? 1 }")).toContain("nothing fixes");
    });

    test("unknown types and neighbors are reported", () => {
        expect(fails("{?: /x; n::Nope/ n:x:!n+1 ? 1 }")).toContain("Unknown semantic type: Nope");
        expect(fails("{?: /x; m::Odd > k/ m:x:!m+1 ? 1 }")).toContain("k is not an integer declared");
        expect(fails("{?: /x; n, n/ n:x:!n+1 ? 1 }")).toContain("declares n twice");
    });

    test("an unbounded family of integers is refused at call time", () => {
        expect(fails("F := {?: /x; n/ n:x:_ ? n }; F(1)")).toContain("Infinitely many values of n");
        expect(text("F := {?: /x; n::Natural/ n:x:_ ? n }; F(5/2)")).toBe("0");
    });
});
