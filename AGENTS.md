# AGENTS.md

Guidance for coding agents working in this repository. `README.md` explains what the tool does and why it is built the way it is; read "How it works", "Limits" and "Measured and dropped" before changing behaviour.

## What this is

vitant is a mutation testing tool for projects that use Vitest, run as a standalone CLI. It has one job: to say for every mutant what the project's own test suite would say if the mutant were in the source for real.

## Priorities

1. **Verdicts are correct.** A verdict (Killed, Timeout, Survived) must equal what the plain suite does with the mutant written into the source. There is no faster, less careful mode, and no change is worth a verdict that may be wrong.
2. **Then speed.** The yardstick is StrykerJS on the benchmark targets.
3. **No tuning to the benchmark.** A rule that only helps the projects under `bench/` is not an improvement.

When a shortcut looks safe, assume it is not until it has been checked against ground truth. Every shortcut that was trusted without that check turned out wrong on some real project; the README lists them.

## Language

Everything in the repository is in English: code, comments, identifiers, error messages, CLI output, tests, documentation, commit messages and pull request text. This holds whatever language the conversation is in.

## Commands

Node 24 runs the TypeScript sources directly; only the package that would be published is built, to JavaScript in `dist/`.

```sh
pnpm install
pnpm build:native    # the addon that copies a worker process; needs Rust 1.85+
pnpm test            # unit tests and an end-to-end run against fixtures/basic
pnpm test:truth      # every verdict on fixtures/basic against the suite with the mutant written in
pnpm test:packed     # the tool packed (pnpm build first, by itself), installed and run, against a run from the sources
pnpm typecheck

node src/cli.ts --root <project> --mutate 'src/**/*.ts' --report report.json
```

Benchmarks clone third-party projects into `bench/.work/` and take minutes to hours:

```sh
node bench/setup.ts <target>
node bench/run.ts <target> <scope> [--tool stryker,vitant,vitant-no-clone]   # also checks against bench/truth/
node bench/truth.ts make --root <project> --report <report.json> --out <truth.json> [--related]
node bench/conformance.ts bench/.work/test262   # instrumented code against test262
```

## Layout

| Path | Contents |
|---|---|
| `src/cli.ts` | Argument parsing and the report printed at the end |
| `src/run.ts` | Main process: starts Vitest, plans rounds, aggregates results |
| `src/runtime/runner.ts` | Runs inside Vitest's workers; must not import `vitest` |
| `src/mutate/` | Mutators, placement of the runtime switches, probes |
| `src/session.ts` | What the main process and the workers exchange, through files |
| `src/platform.ts` | Which build of the addon fits the running platform |
| `native/` | The addon in Rust (`fork()`, supervision of copies) and its build script |
| `npm/` | One package per platform for the built addon |
| `fixtures/basic/` | A small project whose tests each pin down one way a verdict can go wrong |
| `test/` | Tests of the instrumenter and the end-to-end run |
| `bench/` | Benchmark targets, runner, comparison with StrykerJS, test262 conformance |

## Verifying a change

- Run `pnpm typecheck` and `pnpm test`.
- For anything that touches instrumentation, planning, the runner or the addon, also run at least two benchmark targets and compare every mutant's verdict with a report made before the change. A changed verdict is a defect until explained; Killed and Timeout swapping for a mutant that both fails a test and loops is the one known benign difference. `bench/run.ts` prints every mutant that is not as the last run of the scope on this machine had it. That holds between two runs of unchanged code as well: one of the two is wrong, so write the mutant into the source and run the suite before anything else.
- Run each benchmark on a quiet machine. Times vary by about a tenth between identical runs, so one run does not show a small gain.
- A trap that produced a wrong verdict gets a minimal reproduction in `fixtures/basic/`. `pnpm test:truth` must agree on every mutant there; it finds what nobody thought to assert.
- Ground truth is the suite itself: `bench/truth.ts` writes each mutant into the source and runs Vitest. `bench/truth/` holds what that gave for the benchmark scopes, and `bench/run.ts` fails on a verdict that disagrees. An entry is changed only after running the suite by hand, never to match a report.
- Say what was run and what was not. Do not report a platform, a target or a path as working without having run it.

## Conventions

- Comments explain why the obvious alternative was rejected or why the natural approach is a trap. No history ("now", "previously", "as requested"), no restating what the code does.
- No compatibility shims or fallback paths unless they are free. An experiment that does not pay off is removed and recorded under "Measured and dropped" in the README with its numbers.
- The runner works with whichever Vitest the target project resolves (3.0 or later). Do not add a dependency on a Vitest version or internal to `src/runtime/`.
- Pin GitHub Actions to full commit SHAs.
- Do not commit, push or publish unless asked.
