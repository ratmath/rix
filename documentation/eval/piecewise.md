# Piecewise functions

A piecewise literal builds a function from regions and rules:

```rix
Saw    := {?: /x; n/ n:x:!n+1 ? x - n }
Square := {?: /x; n/ 2n:x:!2n+1 ? 1; -1 }
```

The `/.../` header names the variables and, after `;`, the integers the
regions solve for. Each arm reads `region ? rule`; a bare last arm is the
default. The arms are tried in order and the first region that holds supplies
the value. The result is an ordinary callable: call it, pipe into it, or pass
it where a lambda is expected.

## Reading the header

```text
{?: /x/ arm; arm; ...; default }
{?: /x; n/ arm; ...; default }               n is an Integer
{?: /x; n::Natural, m/ arm; ... }            a type restricts n
{?: /x; n::Positive::Even/ arm; ... }        types chain: n passes every one
{?: /x; n::!Even/ arm; ... }                 ::! excludes: same as n::Odd
{?: /x; n::Even, m::Odd > n/ arm; ... }      m is the least Odd above n
{?: /x, y; n, m #Tiles :periodic/ arm; ... } several variables, a name and a trait

header  := vars [ ";" ints ] directives*
vars    := name ("," name)*
ints    := int ("," int)*
int     := name ( "::" Type | "::!" Type )* [ (">" | ">=" | "<" | "<=") name ]
```

Variable and integer names start with a lowercase letter. After the binders
the usual header directives apply: `#Name` names the value and `:trait` tags
it.

## Regions and rules

A region is a betweenness chain with a header variable in the middle, written
exactly as in Core's `R.region` and in `@ratmath/analytic`: `:!` is a strict
link, `_:` and `:_` are unbounded ends, and `||` joins chains. `&&` combines
chains on different variables or adds a test. Inside a piecewise literal the
whole union is the region, so `_:x:!-1 || 1:!x:_ ? 1` needs no parentheses.

```{.rix exec=true id=piecewise-basics session=piecewise}
Ramp   := {?: /x/ _:x:!0 ? 0; 0:x:!1 ? x; 1 };
Saw    := {?: /x; n/ n:x:!n+1 ? x - n };
Square := {?: /x; n/ 2n:x:!2n+1 ? 1; -1 };
Tri    := {?: /x; n/ 2n:x:!2n+1 ? x - 2n; 2n+1:x:!2n+2 ? 2n+2 - x };
[Ramp(-3), Ramp(1/2), Ramp(1)] ##@ == [0, 1/2, 1];
[Saw(7/2), Saw(-1/3), Square(5/2), Square(3/2)] ##@ == [1/2, 2/3, 1, -1];
[Tri(1/2), Tri(3/2)] ##@ == [1/2, 1/2]
```

A rule may use the integer freely, including non-affine uses such as
`(-1)^n`. A default may not use an integer, because only a region fixes one;
the triangle wave above therefore spells out both of its arms.

Any other condition, such as `x^2 < 2`, is a predicate arm. It is tested at
points; interval input and `.Breaks` refuse it.

## What a call returns

| Input or situation | Result |
|---|---|
| Overlapping arms | The first arm that holds wins |
| No arm holds and there is no default | `_` |
| A rational | The exact rule value |
| A `RationalInterval` | The hull of the rule over each piece the interval meets |
| A certified value whose enclosure straddles a breakpoint | `?`; refining the input settles it |
| Overlapping copies of a periodic arm (`n:x:n+2`) | The smallest integer that fits |

```{.rix exec=true id=piecewise-inputs session=piecewise}
Half := {?: /x/ 0:x:1 ? x };
[Half(2), Ramp(1/4:3/2), Square(0:3)] ##@ == [_, 1/4:1, -1:1];
[Saw(2.9?), Saw(2.5?) ? :CertifiedApproximation] ##@ == [?, 1]
```

Bounds and rules read outer names when the function is called, like any
closure. Parenthesize products in bounds: an unspaced colon groups with the
unspaced text around it, so `n p:x` would read as `n (p:x)`.

```{.rix exec=true id=piecewise-live session=piecewise}
p := 3;
Pulse := {?: /x; n/ (n p):x:!(n p + 1) ? 1; 0 };
[Pulse(31/10), Pulse(5/2)] ##@ == [1, 0];
p ~= 2;
Pulse(5/2) ##@ == 1
```

## Integer types

An integer binder is an `Integer` unless it carries types. `Natural` (n ≥ 0),
`Positive` (n ≥ 1), `Negative` (n ≤ -1), `Even` and `Odd` are built in. Types
chain left to right and every link must hold; `::!` excludes a type. The same
chains work in ordinary type checks.

```{.rix exec=true id=piecewise-types session=piecewise}
SawPos := {?: /x; n::Natural/ n:x:!n+1 ? x - n };
PosOdd := {?: /x; n::Positive::!Even/ n:x:!n+1 ? n };
[SawPos(-1/2), SawPos(5/2), PosOdd(7/2), PosOdd(5/2)] ##@ == [_, 1/2, 3, _];
[3 ? :Positive::!Even, 4 ? :Positive::!Even] ##@ == [1, _]
```

A type can declare its *shape*: allowed residues modulo some number, plus
optional bounds. `.IntegerType` builds the whole type from a shape, and
`.TypeRegister` accepts `shape` too. RiX derives membership, next and previous
from the shape, so they cannot disagree.

```{.rix exec=true id=piecewise-integer-type session=piecewise}
.IntegerType(:ThreeMod4, {= mod=4, residues=[3], min=0 });
T := {?: /x; n::ThreeMod4/ n:x:!n+1 ? n };
[T(7/2), T(15/2), T(8), 11 ? :ThreeMod4] ##@ == [3, 7, _, 1]
```

Shapes combine: chained shapes intersect (by the Chinese remainder theorem),
and `::!` of a residue class or of a one-sided bound is again a shape. An arm
whose integers all have shapes, and whose bounds are affine in them, is solved
in closed form. A type with only a `validate` hook still works: RiX steps
through integers and tests each one, so give it a bound such as `::Natural`
to keep the search finite.

## Neighbor binders

`m::Odd > n` makes `m` the least `Odd` above `n`; `>=`, `<` and `<=` pick the
nearest member at or above, below, or at or below. The neighbor is computed
from its anchor rather than solved for.

```{.rix exec=true id=piecewise-neighbors session=piecewise}
Step := {?: /x; n::Even, m::Odd > n/ n:x:!m ? 1; 0 };
IsPrime := (n) -> n >= 2 && {@ d := 2; d*d <= @n && @n % d != 0; ; d += 1; d*d > @n };
.TypeRegister({= name=:Prime, nativeType=:integer, validate=IsPrime });
Gap := {?: /x; p::Natural::Prime, q::Prime > p/ p:x:!q ? x - p };
[Step(1/2), Step(3/2)] ##@ == [1, 0];
[Gap(6), Gap(8), Gap(1)] ##@ == [1, 1, _]
```

## Several variables

`/x, y; n, m/` declares a function of two arguments. Point evaluation works
for every region shape; interval input on more than one variable at once is
not supported yet.

```{.rix exec=true id=piecewise-two-variables session=piecewise}
Checker := {?: /x, y; n, m/ n:x:!n+1 && m:y:!m+1 ? (-1)^(n+m) };
Under   := {?: /x, y/ 0:x:1 && 0:y:x ? 1; 0 };
[Checker(1/2, 3/2), Under(1/2, 1/4), Under(1/2, 3/4)] ##@ == [-1, 1, 0]
```

## Introspection

`.Breaks(F, a:b)` lists the region endpoints of a one-variable piecewise
function inside `a:b`. `.Pieces(F)` lists each arm's region text, integers and
rule, in the chain spelling that `@ratmath/analytic`'s `piecewise` reads.

```{.rix exec=true id=piecewise-introspection session=piecewise}
.Breaks(Square, 0:3) ##@ == [0, 1, 2, 3];
.Breaks(Gap, 0:12) ##@ == [2, 3, 5, 7, 11];
(.Pieces(Saw))[1][:region] ##@ == "n:x:!n+1"
```

## How integers are solved

Each arm's integers must be fixed by its own chains: some chain on a header
variable must have bounds that use that integer (or neighbors built on it)
and no other free integer. RiX reports an arm that breaks this rule when the
literal is built.

| Tier | Region shape | Example | Point value | Breakpoints and interval input |
|---|---|---|---|---|
| Affine | One variable; bounds affine in the integer within each residue class of its type | `2n:x:!2n+1` | Exact, closed form | Exact |
| Typed | As above with `::T` | `/x; n::Natural/` | Exact | Exact |
| Searched | Bounds not affine, or a type without a shape | `p:x:!q`, `q::Prime > p` | Exact; assumes bounds increase with the integer, within a budget | Exact |
| Separable | Several variables, each chain pinning its own integer | `n:x:!n+1 && m:y:!m+1` | Exact | Not yet |
| Coupled | Bounds use another variable | `0:x:1 && 0:y:x` | Exact | Not yet, beyond one interval variable |
| Predicate | Any other condition | `x^2 + y^2 < 1` | Exact if decidable, else `?` | Refused |

An integer that no chain pins, as in `n:x:!n+m` with `m` free, is an error
rather than an endless search. A region that infinitely many integers satisfy,
such as `n:x:_`, needs a type with a lower bound.

## Not implemented yet

- **Multivariable analysis.** Breakpoints, `.Breaks` and interval input work
  for one variable at a time. Box decomposition for separable regions and
  cylindrical decomposition (in header order) for coupled regions are future
  work; they would need a multivariable `Region` in Core first.
- **Calculus.** `F'` and `'F` do not yet understand piecewise functions. The
  plan: differentiate each rule on its own region, giving `_` at a breakpoint
  unless both sides agree exactly in value and derivative.
- **Analytic handoff.** `.Pieces` gives the shared chain text, but there is
  no one-call export to an `@ratmath/analytic` `PiecewiseFunction` yet.
- **Shadowed-arm lint.** A lint rule for an arm that earlier arms already
  cover is planned.
- **Interval input with `pi` or `e` in bounds** is untested; bounds should be
  rational.

See the [design rationale](../rix-rationales.md#piecewise-literals-2026-11-24)
for why the literal looks the way it does.
