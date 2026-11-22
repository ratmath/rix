import { describe, expect, test } from "bun:test";
import { parseAndEvaluate } from "../../src/eval/evaluator.js";
import { formatValue } from "../../src/eval/format.js";
import { parse } from "../../src/parser/parser.js";
import { tokenize } from "../../src/parser/tokenizer.js";
import { formatRix } from "../../src/tools/language-service/formatter.js";
import { renderSymbolicIr } from "../../src/eval/functions/symbolic.js";
import { lower } from "../../src/eval/lower.js";

const text = (code) => formatValue(parseAndEvaluate(code));
const values = (code) => tokenize(code).filter((t) => t.type !== "End").map((t) => t.value);

describe("chain links are two-character tokens", () => {
    test(":!, _: and :_ lex as one token each", () => {
        expect(values("_:x:!8")).toEqual(["_:", "x", ":!", "8"]);
        expect(values("2:!x:_")).toEqual(["2", ":!", "x", ":_"]);
    });

    test("longer operators and names keep their reading", () => {
        expect(values("a:!=b")).toEqual(["a", ":", "!=", "b"]);
        expect(values("_:=3")).toEqual(["_", ":=", "3"]);
        expect(values("a:_b")).toEqual(["a", ":", "_b"]);
        expect(values("3!:4")).toEqual(["3", "!", ":", "4"]);
        expect(values("x:_>2")).toEqual(["x", ":", "_>", "2"]);
    });

    test("the parser marks strict links and unbounded ends", () => {
        const [node] = parse("_:x:!8");
        expect(node.strict).toBe(true);
        expect(node.left.left).toMatchObject({ type: "NULL", unbounded: true });
        expect(parse("_")[0].unbounded).toBeUndefined();
        expect(parse("2:x:8")[0].strict).toBeUndefined();
    });
});

describe("betweenness with strict links and unbounded ends", () => {
    test(":! forbids a tie across that link", () => {
        expect(text("x := 2; [2:x:8, 2:!x:8, 2:x:!8, 1:!x:!3]")).toBe("[1, _, 1, 1]");
        expect(text("x := 2; [8:x:!1, 8:x:!2]")).toBe("[1, _]");
        expect(text("x := 3; n := 1; 2n :x:! 2n+1")).toBe("_");
        expect(text("x := 5/2; n := 1; 2n:x:!2n+1")).toBe("1");
    });

    test("_ beside a colon is an unbounded end, and the chain reads ascending", () => {
        expect(text("x := 2; [_:x:2, _:x:!2, 3:x:_, 1:x:_, 8:x:_, _:x:_]")).toBe("[1, _, _, 1, _, 1]");
        expect(text("x := 2; _: x+1 :3")).toBe("1");
    });

    test("|| joins chains", () => {
        expect(text("x := 0; _:x:!-1 || 1:!x:_")).toBe("_");
        expect(text("x := 3/2; _:x:!-1 || 1:!x:_")).toBe("1");
    });

    test("a null value is not an unbounded end", () => {
        expect(text("y := _; x := 1; 0:x:y")).toBe("_");
    });

    test("misplaced links throw", () => {
        expect(() => parseAndEvaluate("_:5")).toThrow("betweenness chain");
        expect(() => parseAndEvaluate("2:!5")).toThrow("betweenness chain");
        expect(() => parseAndEvaluate("1:_:3")).toThrow("either end");
    });

    test("plain intervals are unchanged", () => {
        expect(text("1:2 + 3:4")).toBe("4:6");
        expect(text("3!:7")).toBe("6:7");
    });
});

describe("formatting and rendering keep the links", () => {
    test("rix format keeps :!, _: and :_", () => {
        expect(formatRix("z:=2   :x:!   3;")).toBe("z := 2 :x:! 3;\n");
        expect(formatRix("v:= 2:!x:8+1;")).toBe("v := 2:!x:8+1;\n");
        expect(formatRix("u := _:x:!8;")).toBe("u := _:x:!8;\n");
        expect(formatRix("t := 2:!x:_;")).toBe("t := 2:!x:_;\n");
    });

    test("symbolic rendering spells the chain", () => {
        const [ir] = lower(parse("_:x:!8"));
        expect(renderSymbolicIr(ir)).toBe("_:x:!8");
    });
});
