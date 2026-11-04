# AGENTS.md

Guidance for coding agents working in this repository. `README.md` is for users. The record of why the tool is built the way it is lives under `docs/`; read `docs/design.md`, `docs/limits.md` and `docs/decisions.md` before changing behaviour.

## What this is

vitant is a mutation testing tool for projects that use Vitest, run as a standalone CLI. Built for Vitest alone, it is to be faster than StrykerJS and at least as accurate: for every mutant it says what the project's own test suite would say if the mutant were in the source for real. The default is for bringing it into a project as it is, fast enough to run all the time; `--strict` is for holding a project to the plain suite's word on every detection, as a new project can be held to TypeScript's `strict` from the start.

## Priorities

1. **Verdicts are correct, and never less so than StrykerJS's.** A verdict (Killed, Timeout, Survived) must equal what the plain suite does with the mutant written into the source. Survived always rests on every test file the mutant can change passing with it. A detection rests on two failures, one of them in a run that confirms it; by default that run may go beside other test files' runs, one run of its own file at a time, which leaves a chance that two files that never meet in the suite fail each other there, and `--strict` makes it alone on the machine. Nothing else may let a verdict differ from the plain suite: no other change is worth a verdict that may be wrong. An option may leave work out for time, as `--confirm` does, only if it is off by default, concludes nothing from the runs it did not make, and reports every mutant it left open under a status of its own; where it stops must not depend on how long anything took.
2. **Then speed: faster than StrykerJS on every benchmark target, in the default mode.**
3. **No tuning to the benchmark.** A rule that only helps the projects under `bench/` is not an improvement.

When a shortcut looks safe, assume it is not until it has been checked against ground truth. Every shortcut that was trusted without that check turned out wrong on some real project; [Deciding](docs/design.md#deciding) lists them.

## Language

Everything in the repository is in English: code, comments, identifiers, error messages, CLI output, tests, documentation, commit messages and pull request text. This holds whatever language the conversation is in.

## Commands

Node 24 runs the TypeScript sources directly; only the package that would be published is built, to JavaScript in `dist/`.

```sh
pnpm install
pnpm build:native    # the addon that copies a worker process; needs Rust 1.85+
pnpm check:quick     # typecheck and unit tests for the editing loop
pnpm test:smoke      # native supervision and small CLI fixtures
pnpm test:e2e test/e2e/cache.test.ts  # one independent e2e group; no separating --
pnpm test            # all unit, smoke and e2e tests
pnpm test:truth      # full basic/default, basic/static, stuck, clash and walk truth checks
pnpm test:packed     # the tool packed (pnpm build first, by itself), installed and run, against a run from the sources
pnpm typecheck

node src/cli.ts --root <project> --mutate 'src/**/*.ts' --report report.json
```

Benchmarks clone third-party projects into `bench/.work/` and take minutes to hours:

```sh
node bench/setup.ts <target>
node bench/tier.ts                    # six short scopes in about five minutes: what each run spent, and whether every verdict held
node bench/tier.ts apps               # a file or two each of three applications, in about four minutes
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
| `src/cache.ts` | What a run stores for `--incremental` and when it still holds |
| `src/platform.ts` | Which build of the addon fits the running platform |
| `native/` | The addon in Rust (`fork()`, supervision of copies) and its build script |
| `npm/` | One package per platform for the built addon |
| `fixtures/basic/` | A small project whose tests each pin down one way a verdict can go wrong |
| `test/` | Tests of the instrumenter and the end-to-end run |
| `bench/` | Benchmark targets, runner, comparison with StrykerJS, test262 conformance |
| `docs/` | The record: `design.md` (how a verdict is reached and what each rule cost), `benchmark.md` (targets, times, how the verdicts are checked), `decisions.md` (ideas measured and dropped), `limits.md` (what cannot be judged) |

## Verifying a change

- Run `pnpm typecheck` and `pnpm test`.
- Use `pnpm check:quick` and a selected e2e group while iterating; neither replaces the complete checks before finishing. Preserve the original test inventory and assertions when reorganizing tests.
- Do not run `test`, `test:truth` or `test:packed` together in one checkout, or two vitant runs on one project root. Truth changes tracked files, and each vitant run replaces its root's session. CI parallelizes these operations only in separate jobs and checkouts. Do not edit tracked files while a test or benchmark uses them.
- For anything that touches instrumentation, planning, the runner or the addon, also run at least two benchmark targets and compare every mutant's verdict with a report made before the change. A changed verdict is a defect until explained; Killed and Timeout swapping for a mutant that both fails a test and loops is the one known benign difference. `bench/run.ts` prints every mutant that is not as the last run of the scope on this machine had it. That holds between two runs of unchanged code as well: one of the two is wrong, so write the mutant into the source and run the suite before anything else.
- Judge a change to how much work is done by the counts first: `bench/tier.ts` prints whole-file runs, trials and the time added up over the processes, which a busy machine changes by a few in a hundred between identical runs. Seconds come second and need a quiet machine: they vary by about a tenth between identical runs there, so one run does not show a small gain. The times in `docs/benchmark.md` are taken on CI runners; the table under Benchmark in `README.md` is a copy of its "On hosted CI runners" table and changes with it.
- A trap that produced a wrong verdict gets a minimal reproduction in `fixtures/basic/`. `pnpm test:truth` must agree on every mutant there; it finds what nobody thought to assert.
- A change to values the target's code observes through Date, performance, fs or process also needs truth comparisons on the full application scopes (umami lib, formbricks utils, actual server, immich utils and services). Small tier scopes missed a fractional Date.now result that broke an application using BigInt; passing them alone is insufficient.
- Ground truth is the suite itself: `bench/truth.ts` writes each mutant into the source and runs Vitest. `bench/truth/` holds what that gave for the benchmark scopes, and `bench/run.ts` fails on a verdict that disagrees. An entry is changed only after running the suite by hand, never to match a report.
- Say what was run and what was not. Do not report a platform, a target or a path as working without having run it.
- CI uses representative detailed checks for classified low-risk changes, and all seven environments for platform-sensitive or unclassified changes and scheduled/manual full runs. Missing or cancelled required results fail the gate. Benchmarks run manually; keep the required before/after benchmark evidence for relevant changes. See [Development workflow](docs/development.md).

## Conventions

- Comments explain why the obvious alternative was rejected or why the natural approach is a trap. No history ("now", "previously", "as requested"), no restating what the code does.
- No compatibility shims or fallback paths unless they are free. An experiment that does not pay off is removed and recorded in `docs/decisions.md` with its numbers.
- The runner works with whichever Vitest the target project resolves (3.0 or later). Do not add a dependency on a Vitest version or internal to `src/runtime/`.
- Pin GitHub Actions to full commit SHAs.
- Do not commit, push or publish unless asked.
