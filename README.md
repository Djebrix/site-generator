# Fast makefun-site drop-in

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Djebrix/site-generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Djebrix/site-generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A faster drop-in for makefun-site 1.0.0, entered in [Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122).

## What it does

`solve.js` exports `run(input)`, a dependency-free ES module that returns
byte-for-byte what makefun-site 1.0.0's `build` returns for the same input:
every page's `index.html`, the index and tag pages, `build-report.txt`, and
each static file. `main.ts` is the harness driver: it reads every case from
`/input/cases.json` (or `MAKEFUN_INPUT_DIR`), answers each with `run()`, and
writes `/output/answers.json`.

It reproduces the reference exactly, including its front matter grammar and
refusal reasons, its template dialect (variables, `for`, `if`, includes to
depth 8, standalone-tag lines), its Markdown subset (fences, ATX headings
with unique ids, blockquotes, flat lists, inline code/strong/emphasis/links
and backslash escapes), slug Unicode normalisation, permalink uniqueness,
tag grouping and ordering, and the sorted build report.

## How it is faster

Same pipeline order, same answers, less work:

- **Inline Markdown scans plain runs in bulk** instead of escaping one
  character at a time (the reference spends about a third of its CPU in its
  per-character escape call).
- **The Markdown lexer and renderer are fused** into one pass over the
  body's lines, with hand-rolled character checks instead of a regex per
  line per block kind, and no intermediate token objects.
- **`slugify` takes an ASCII fast path** (no NFKD normalisation, no mark
  stripping) and memoises repeated strings (tag names, headings) per case.
- **Word counting scans code units** instead of building a match array, and
  each source's reading time is computed once, not once per card.
- **Template rendering appends to one array and joins once**, reuses one
  scope frame per loop instead of one per item, and slugifies each tag name
  once instead of two or three times.

No state is kept between cases: every `run()` builds its own caches, so the
two graded executions are byte-identical.

## Practice result

On the kit practice set (3 cases, 250–480 Markdown sources each):

- **3/3 cases identical** to the reference (`grade-local --driver process`:
  `passed: 1`, `cases_passed: 3`, L1 regrade reproduced byte for byte).
- **Determinism:** two runs produce byte-identical `answers.json`.
- **Speed (this machine, build only, CPU time, median of 7 rounds):**
  196 ms vs the house baseline's 621 ms — **3.17× faster**.
  Whole `main.ts` run: ~0.60 s wall vs ~0.97 s for the baseline.
- **Differential fuzzing:** 7,100 random edge-case sites (weird front
  matter, Unicode titles, broken links, malformed templates, deep includes)
  all match the reference exactly.

## Layout

- `solve.js` — the fast implementation (the only file that matters for speed).
- `main.ts` — the harness driver.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the claim file for this entry.
