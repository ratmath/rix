# Changelog

## Unreleased

### Added

- Units now come from Core (`@ratmath/core/units`), shared with the RatMath
  calculator and the Shelf libraries. The catalogue grows to Core's: SI
  prefixes on the units that take them (`2~[kHz]`, `1~[mAh]`), binary
  prefixes on bits and bytes (`1~[MiB]`), grams, litres, US customary
  lengths, masses and volumes, pressure (`bar`, `atm`, `psi`), energy
  (`eV`, `cal`, `kWh`), electricity (`V`, `Ω`, `C`, `F`, ...), `gon`,
  `arcmin` and `arcsec`. Radians to degrees is exact through `.Exact[:pi]`:
  `.ConvertUnit(1~[rad], "deg")` is `180~{pi^-1}~[deg]`.

### Changed

- `K` is an absolute temperature: `.ConvertUnit(300~[K], "degC")` now gives
  `26..17/20~[degC]` instead of an error, and `300~[K] - 20~[degC]` is a
  difference in K.
- Compound units print factors in the order they were written
  (`m*kg/s^2`, not alphabetically) and parenthesise a denominator with more
  than one factor (`m/(s*kg)`); the old `m/s*kg` read back as m·kg/s.
- Error messages for unit misuse come from Core: comparing different
  dimensions says "Incompatible dimensions for comparison", adding two
  temperature points says "Cannot add two temperature points".
- `.DefineUnit` needs a unit size that is a rational times a power of pi.
- Quantities keep their magnitude in their display unit; `baseMagnitude` is
  still available and is computed on demand.
- Requires `@ratmath/core` ^0.11.1 (for `@ratmath/core/units`).

- Piecewise functions: `{?: /x; n/ region ? rule; ...; default }` builds a
  callable. The `/.../` header declares variables and, after `;`, integers
  that each region solves for (`Saw := {?: /x; n/ n:x:!n+1 ? x - n }`).
  Integers take chained types (`n::Positive::!Even`) and neighbor relations
  (`m::Odd > n`, the least odd above n). First match wins, no match gives
  `_`, interval input gives the hull, and a certified value straddling a
  breakpoint gives `?`. `.Breaks(F, a:b)` and `.Pieces(F)` inspect the
  regions. Several variables (`/x, y; n, m/`) evaluate at points;
  multivariable breakpoints, integration, and an analytic export are not
  implemented yet. See `documentation/eval/piecewise.md`.
- `F'` on a one-variable piecewise function differentiates each rule on its
  region; at a breakpoint it is `_` unless value and slope match from both
  sides. Symbolic `Deriv` also handles a constant exponent such as `x^n`.
- Piecewise bounds may be enclosures (`RationalInterval`,
  `CertifiedApproximation`, or a `.numerics.Refine` result), so regions can
  use pi or e; undecided comparisons give `?`.
- Lint rule `RX1807` warns about a piecewise arm that earlier arms cover.
- `rix --ratmath` loads `@ratmath/rix-bridge`, which adds the ratmath
  JavaScript libraries as `.analytic`, `.matrix` (linalg), `.algebraic` and
  `.graphics`. RiX does not depend on them: the bridge is found from the
  working directory or next to the RiX install, or at `--ratmath=PATH`, and
  is imported only when the flag is given.
- Integer subtypes `Natural` (n >= 0), `Positive`, `Negative`, `Even` and
  `Odd`, and `.IntegerType(:Name, {= mod, residues, min, max })` for user
  subtypes; `.TypeRegister` also accepts `shape`, `next` and `prev`. Type
  checks chain: `x ? :Positive::Even`, and `::!` negates a link.

- Betweenness chains take strict links and unbounded ends, as two-character
  tokens: `:!` is strict (`2:!x:8` is 2 < x ≤ 8, `2:x:!8` is 2 ≤ x < 8), and
  `_:` / `:_` are unbounded ends (`_:x:8` is x ≤ 8, `2:x:_` is x ≥ 2; a chain
  with one reads ascending). `||` joins chains as usual. The same spelling is
  read by Core's `R` and `R.region` (0.9.0) and by `@ratmath/analytic`.
  These forms lower to the new `BETWEEN` IR operation; plain chains still use
  `INTERVAL`. `_:5`, `2:!5` and `1:_:3` throw.

### Changed

- `@ratmath/core` is now `^0.9.0`, so RiX and the ratmath libraries can share
  one Core instance.
- `a:!b` used to read as `a:(NOT b)`, which always gave `_`; it is now a
  strict link. `_` touching a colon is now an unbounded end rather than a
  null endpoint; a variable holding `_` is still null.

- Interval colons are spacing-aware. An unspaced colon groups with the
  unspaced text around it before any spaced operator, so `1:2 + 3:4` is `4:6`
  and `1:2 * 2` is `2:4` (previously `1:5:4` and `1:4`). Unspaced endpoint
  arithmetic (`1:n+1`, `xs[1:n+1]`), fraction endpoints (`1/2:3/4`) and spaced
  colons (`1: 2+3 :4`) are unchanged. `+`, `-` or `*` between two unspaced
  intervals, as in `1:2+3:4`, now combines them and is reported by the new lint
  rule RX1710. `rix format` preserves the spacing these forms depend on.
- Depends on `@ratmath/core` ^0.8.0, whose `R` reads the interval colon by
  spacing as RiX does.
- `0^0` now throws "Zero cannot be raised to the power of zero", matching
  Core's `Integer.pow`, `Rational.pow` and the `R` tag. It previously returned `1`.

### Fixed

- `_^` after a lowercase or `0z[n]` base prefix (`0xff_^1`, `0t1_^10`) was a
  parse error. It now shifts by that base, with the exponent written in that
  base (`0t1_^10` is 27, `0xff_^1` is 4080), as uppercase custom prefixes and
  Core's `R` already did. Signed-radix systems shift by their radix.

- `rix format` no longer changes what code means. Across the repository's RiX
  sources it changed 464 of 3,738 formattings: it split fused products
  (`1/2x` became `1/2 x`), joined lines after postfix checks (`##@ ...`),
  dropped quotes from strings that spell operators (`":="`), broke empty sigil
  braces (`{; }`), unit text (`3~[m*s]`), `{#x}`, `::x`, `@"..."` and
  `10^-20`, and spread postfix-check predicates over several lines. Spacing
  between adjacent operands is now kept as written, and every result is parsed
  again: a top-level statement whose meaning would change is left exactly as
  written.
- `rix format` is stable: formatting its own output changes nothing. The
  readable profile measured line width from the source's spacing, so 47
  repository files reflowed on a second run; it now measures the tokens laid
  flat. A suite-only test formats every plugin and example twice.

### Performance

- Cache immutable plugin operator declarations across fresh sessions. The bounded
  process-local cache preserves fresh catalog state and declaration containers,
  source/owner-specific diagnostics, and normal plugin validation and activation.
  First-use parsing remains unchanged.


## 0.1.0 — 2026-09-21

Initial public alpha of `@ratmath/rix`, the Rational Interval Expression Language.
The 0.1 line makes no source- or API-compatibility commitment.

### Language and mathematics

- Exact integers, rational numbers, rational intervals, and interval sets,
  with certified approximation and exact numeral-system support from Core 0.6.
- Parser, evaluator, configurable capability groups, collections, functions,
  reactive values, mathematical tensors, and asynchronous execution with
  cancellation and bounded concurrency.
- Optional first-party plugins for algebra, symbolic calculations, validated
  numerics, calculus, ODEs, plotting, geometry, statistics, and data operations.
  Individual plugins document their supported domains and limits.

### Hosts and tools

- Shared JavaScript module API and CLI for Node.js 22+ and Bun 1.4+.
  Installed commands use Node; explicit Bun invocation remains supported.
- Interactive REPL defaults to the curated `full` plugin set. `--plugins=...`
  replaces the default or saved selection, `--plugins=none` suppresses implicit
  preloads, and repeatable `--plugin=ID` flags add plugins. Scripts and embedded
  evaluators remain bare unless plugins are requested.
- Parser/IR utilities, formatting and verification commands, a language server,
  editor execution workers, and portable browser entry points.
- Bundled plugin source and live-page assets are prepared at package-build time;
  installed Node users do not need Bun's text loader or bundler.

### Documents and distribution

- Structured mathematical output, SVG and other graphics formats, HTML,
  Markdown, Quarto, LaTeX, and PDF workflows, plus offline live HTML output.
  Binary formats require the external tools listed in the renderer guide.
- Runnable examples, tutorials, API references, and package installation and
  embedding instructions in the README.
- Requires `@ratmath/core` ^0.6.0. Plugin sources, schemas, styles, examples, and
  prebuilt live assets are included in the npm package. Browser applications,
  native Notebook installers, and the VS Code extension are distributed separately.

### Verification

- Node 22/24/26 and Bun compatibility checks, isolated npm consumer checks,
  browser acceptance checks, and explicit generated-asset freshness checks.
- The release gate runs the complete coverage suite, native RiX tests,
  documentation checks, editor policy validation, and package verification.
  Aggregate tutorial tests use the same two-minute budget locally and in CI.

- Full release verification is independent of `npm publish`. Publishing checks a
  local receipt for unchanged source, package contents, dependencies, and runtime
  versions; packing only checks generated assets without rebuilding them.
- Exact tensor coordinate/symmetry tests allow a one-minute coverage budget.
