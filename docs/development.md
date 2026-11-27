# Development workflow

The short commands answer whether an edit is ready for a larger check. The full commands retain every test and every ground-truth comparison; a quick pass does not replace them.

## Local checks

| Command | Scope |
|---|---|
| `pnpm check:quick` | TypeScript and the unit project |
| `pnpm test:unit` | Instrumentation, bindings, verdicts, process locks and harness unit tests |
| `pnpm test:smoke` | Native supervision, copied runs, clocks and Vitest 3 mocks |
| `pnpm test:e2e test/e2e/cache.test.ts` | Incremental and transformed-module caches |
| `pnpm test:e2e test/e2e/basic.test.ts` | Basic verdicts and worker-count and strict comparisons |
| `pnpm test:e2e test/e2e/basic-modes.test.ts test/e2e/basic-options.test.ts` | No-clone and static comparisons; confirm, led, fast and shard comparisons |
| `pnpm test:e2e test/e2e/boundaries.test.ts` | Limits, hangs, conflicting runs, changed files and typechecking boundaries |
| `pnpm test` | All unit, smoke and e2e tests |
| `pnpm test:truth` | Every eligible mutant in basic/default, basic/static, stuck, clash and walk, written into the source and judged by the suite |
| `pnpm test:packed` | Installed-package verdicts compared with the source invocation |

File arguments follow the script name directly. A separating `--` can prevent Vitest from using the file filter.

Build the addon with `pnpm build:native` before smoke or full tests on supported platforms. Smoke must exercise copies there; a missing addon is a failure. Windows runs the CLI without it and skips only the native-specific assertions it already skipped.

The e2e groups own private fixture directories and report directories. Basic/options share one baseline inside their file; the clash scenarios retain their order. Vitest runs unit, smoke and e2e projects in order, with only unit files running concurrently. The inner CLI worker counts and verdict rules are unchanged.

Run full tests, truth and packed checks sequentially in one checkout. Private fixture paths do not make truth safe beside another CLI run: truth writes tracked files, and the CLI checks the containing repository for changes. A second run on one root also replaces its session. Leave tracked files alone while a run is in progress.

## CI profiles

PR validation targets about ten minutes from workflow creation until all required checks finish, including setup, dependencies and runner waits. Runtime and native changes use the same PR checks as other code changes. Environment-specific regressions can be found after merge; the complete platform matrix runs daily and must pass on the release commit before release.

| Profile | Selection | Required validation |
|---|---|---|
| docs | A resolved, nonempty diff containing only README, CONTRIBUTING, LICENSE or Markdown under docs, excluding agent instructions | Profile selection and lockfile validation; platform checks explicitly finish through the docs path |
| standard | Every other PR or main push, including unknown paths and missing/invalid/empty diffs; explicit manual standard runs | Build/smoke on all seven environments; complete unit/e2e/packed checks on Linux x64 glibc and macOS arm64; all five full-suite truth cases on Linux x64 glibc |
| full | Daily runs and manual runs unless standard is explicitly requested | Every original unit, smoke, e2e, truth and packed check on every original environment |

`bench/ci.ts` only distinguishes proven documentation changes from code. AGENTS.md, CLAUDE.md and SKILL.md select standard at any depth. A failed diff cannot select docs. The summary records the comparison mode, base/head SHAs and whether the diff resolved, separately from the tested checkout SHA.

The seven environments are macOS arm64/x64, Linux x64/arm64 with glibc/musl, and Windows x64. Typechecking remains on the five macOS/glibc/Windows targets in full runs; musl retains its Alpine container boundary. Every PR retains the full unit suite on both representative targets, including native supervision in smoke on all supported targets.

The quick Linux job supplies its same-source typecheck/unit result once. Build/smoke jobs compile each addon and upload it with source, workflow-run, platform and content identities. Detail jobs download only from that workflow run and verify the manifest before using the binary.

Standard detail runs in independent jobs and checkouts, with up to twenty jobs in flight. A code PR takes about ten minutes, most of it the longest e2e lane on macOS:

- On Linux and macOS, the e2e files are spread over four lanes of about six minutes each on macOS, and the packed check has a fifth; five is as many macOS jobs as the account runs at once. Each of the three basic files makes the fixture's run with no options again, which its comparisons need. e2e files that no lane names, and on macOS the units and typechecking, run in the packed lane.
- On Linux, basic/default and basic/static truth each have four mutant partitions. Stuck, clash and walk each have one lane. Every partition runs the whole target suite for every assigned mutant, with the existing calibration and serial disagreement retries. The target suite itself is never sharded or sampled.
- Each truth partition records its complete eligible mutant set and the identities it actually checked. The gate requires every partition exactly once, identical mutant sets across partitions of a case, and the exact assigned identities without omissions or duplicates. Reports from another source or workflow run cannot fill a missing partition.

Full detail retains the original regression lane on every environment and one truth lane on each environment but Windows, with at most four running together. Windows truth runs in the same partitions as standard Linux truth, under the same gate checks: as one job it took up to 198 minutes against its 200-minute step limit, nearly all of it in basic/default and basic/static, since a run of the fixture's suite takes about a minute there against two seconds on macOS. The Windows partitions are queued first. Full runs can take more than two hours; their duration does not gate PR merges.

The gate checks the exact expected target/suite set, prerequisite job outcomes and source/run identity. Missing, duplicate, mismatched, failed, cancelled or unexpectedly skipped results fail it. The original platform check names remain, and `Required validation` is the single overall result; repository protection settings are not changed automatically. A time budget never turns unfinished checks into success.

Main pushes and pull requests use automatic selection. A newer automatic run cancels only the older run for that event and ref. Scheduled full runs occur daily at 20:17 UTC; manual runs default to full. Neither is cancelled by an automatic run. Investigate a failing full run and add a regression test where appropriate. Before release, run manual full validation on the release ref and verify that its checked-out source commit is exactly the commit being released; an earlier successful daily run is insufficient. There is no automated publishing workflow in this repository.

## Performance experiments

The benchmark workflow is manual. It retains the target/scope, tool, baseline commit, repetition, runner and record inputs, and the ground-truth comparisons. It no longer starts all 26 scopes on two operating systems for every matching main push.

Use `node bench/tier.ts`, `node bench/tier.ts apps`, or explicit `target:scope` arguments to see work counts and verdict agreement early. Instrumentation, planning, runner or addon changes are compared before and after with the compare workflow below. Changes to Date, performance, fs or process values need the full application scopes too; the short scopes cannot establish their correctness.

## Comparing two commits

A change to the instrumentation, the planning, the runner or the addon is held against the commit it starts from on CI alone:

```sh
gh workflow run compare.yml --ref <branch>     # base: where the branch leaves main
gh workflow run compare.yml --ref <branch> -f base=<commit> -f scopes='tailwindcss:parsers:4 shopify:node' -f macos=false
```

`bench/moves.ts` names the scopes. Each job runs one share of a scope's files (`--shard`) with the base and then with the head, on one runner, so that a time and a timeout of one compare with the other's. The compare job merges each commit's shares, matches the mutants by file, start, end, mutator and replacement, holds each merged report against `bench/truth/`, and writes to its summary every mutant whose status moved, grouped as: between detected and undetected; to or from a status without a verdict (Static, Unconfirmed, Led, Pending); between Killed and Timeout, which is benign; between Survived and NoCoverage, which the suite passes alike. It fails on a move of the first kind, a report that disagrees with the suite, a mutant in one commit's report only, a job that left no report, a run that did not exit with 0, and a mutant left pending. A change that adds or removes mutants fails on the third by design: the summary names the files, and the mutants it added have no base to be compared with, only the stored ground truth where it has them. A move between detected and undetected of a mutant whose `bench/truth/` entry has a note is listed apart and does not fail it: the suite was run by hand for that mutant, and the note says why this tool's verdict differs from the suite's in some runs, as n8n `proxy`'s `workflow-data-proxy.ts:1134:21`, Survived in one run and Timeout in another of the same commit, does. The other moves are listed for reading and do not fail it either: an Unconfirmed that comes or goes is as often the project's tests failing by chance as the change. `scopes` replaces the set with Linux runs of the scopes given, as `target:scope[:shards]`.

The set is chosen by what its runs go through, with about 22 jobs of under half an hour each:

| Scope | Runner, path | Shards | What it covers |
|---|---|---|---|
| yaml `lexer` | macOS, copies | 1 | 174 timeouts of 737 mutants; macOS's three processors and its build of the addon |
| es-toolkit `array` | macOS, copies; Linux, no copies | 1 | 68 small files, timeouts, copies made before a test |
| n8n `proxy` | Linux, copies, base and head apart | 1 | Files run only in copies made before they load, Vitest projects. Its mutants are nearly all in one file, which a shard cannot split, so base and head run in a job each on two processors |
| formbricks `utils` | Linux, copies | 3 | An application suite: copies refused for native threads and open descriptors, many Static mutants |
| h3 `utils` | Linux, copies | 3 | Timeouts, Unconfirmed and explained mutants in 39 files |
| umami `lib` | Linux, copies | 3 | An application suite that reads Date; the most Static mutants |
| sveltekit `server` | Linux, copies | 2 | Copies made before load, timeouts, Unconfirmed and explained mutants, Vitest 5 |
| xstate `core` | Linux, copies | 1 | Vitest 3.2, workers started for whole-file runs, timeouts |
| vue `reactivity` | Linux, copies | 1 | Files whose verdicts are unsure: most of the benchmark's Unconfirmed mutants |
| immer `all` | Linux, copies and no copies | 1 | Vitest 3.2, started workers, Static mutants |
| es-toolkit `pr` | Linux, copies | 1 | Lines a change touched (`--changed`) |
| hono `router` | Linux, no copies | 1 | The path of platforms without the addon |

What the set cannot show, and when the full benchmark is still needed:

- **A trap of a project outside it.** Of the last 28 fixes' comparisons, the wrong verdicts that showed on a benchmark scope were in n8n `proxy` (twice) and h3 `utils`, which the set has, and in headlamp `api`, Shopify `node` on macOS (610 mutants left pending), tailwindcss `parsers` on macOS (a run that stalled) and excalidraw `pr` on macOS (a wrong Killed), which it does not. A change aimed at a target, or at a kind of suite only some targets have (a browser environment, a project with several Vitest configs, a run that fills the memory), adds those scopes with `scopes` or runs them with `bench.yml` and `base`.
- **macOS beyond two library scopes.** The applications on macOS's three processors, where heavy files are run one at a time and runs come near the job's limit, are not in it. A change to how many processes run at once, to memory or to the addon's copies needs `bench.yml` on macOS.
- **Windows.** No benchmark runs there; the paths without the addon are run on Linux alone, and the PR checks' Windows smoke run is all Windows gets before a full run.
- **A wrong verdict that comes by chance.** Each commit is run once: h3's wrong Survived showed in one Linux job of several, and a verdict that one run in ten gets wrong shows here one time in ten. A change to how a failure is settled or a test is trusted is run with `bench.yml`'s `jobs` on the scopes it touches.
- **Timeouts of n8n `proxy`.** Its base and head run on two processors, and a move to or from Timeout there may be the processor's: such a move is written into the source and run with the suite before it is taken for the change's.
- **Times and counts of a speed change.** The summary gives each commit's longest shard, whole-file runs and trials, from one run each on the processor its job was given. A claimed speedup is measured on the scopes it is for, and the tables in `docs/benchmark.md` come from full runs.
- **A change of the packages.** Base and head share the head's `node_modules` unless their lockfiles differ, in which case the base installs its own.
- **Values the target's code observes through Date, performance, fs or process.** These need the full application scopes against the ground truth, as above.
- **A release.** Before a release and in the final pass of a goal, every target runs on Linux and macOS with `bench.yml`.

## Ground truth on CI

Ground truth for a benchmark scope takes one job a mutant at a time: from a second to nearly three minutes a mutant, hours a scope. `.github/workflows/truth.yml`, dispatched by hand, deals the mutants over jobs:

```sh
gh workflow run truth.yml --ref <branch> -f target=sveltekit -f scope=server [-f shards=8] [-f command=related] [-f jobs=1] [-f report=<bench run id>]
```

- **The report.** A first job runs this tool over the scope as `bench/run.ts` does, or takes `vitant.json` from the ubuntu-24.04 artifact of the bench run that `report` names. Every share is made for that one report, and each first checks that the report's `summary.json` names the target commit that `bench/targets.ts` sets up: a mutant goes in where the report says, whatever stands there.
- **The shares.** Each of the `shards` jobs sets up the target and runs `bench/truth.ts make --target <target> --report <report> --shard <i>/<n>`. It writes each mutant of its share into the source and runs the suite, as one `make` would: with the target's arguments, and with `--related` where the stored ground truth was made with it (`command`, empty by default). The calibration covers every file of the report, so each share gets the time limit the whole would have had on that machine. Runs that disagree with the report are made again alone. With `jobs` above 1, each job probes its copies for every file of its share, and with `--related` also the file whose tests took longest with no mutant, which sets the time limit; it refuses them as a local `make` does. Keep `jobs` at 1 for a target whose notes in `bench/targets.ts` say its ground truth is made with `--jobs 1`.
- **The merge.** The last job runs `bench/truth.ts merge`. It refuses a share that is missing, given twice, made for another report or made with another command, and rejects entries other than those a share says it checked. It writes the entries in the report's order, which is the file one `make` would have written. It then checks the file against the report and, with `bench/truth.ts diff`, against the stored `bench/truth/<target>-<scope>.json`; both results are in the run's summary. The file is the artifact `truth-<target>-<scope>`. It carries none of the notes written by hand, so a mutant whose stored entry has a note counts as wrong against the report until the note is carried over by hand.
- **Storing it.** A difference from a stored entry is a defect until the suite, run by hand with the mutant written in, settles it. Only then does an entry in `bench/truth/` change. One mutant detected in both, by failing in one and by running out of the limit in the other, is the known benign difference.
- **A new workflow.** GitHub dispatches only workflows it has seen run. A workflow that is not yet on `main` needs one push run first, from a temporary `push` trigger on its branch.

Each share is a Linux job of its own, among the twenty the account runs at once with PR checks; more shards than are free wait for a runner. SvelteKit `server`'s 2,485 mutants took 47.5 and 46.0 minutes in two runs from dispatch to the merged file in eight shards, against 3.9 and 3.3 hours of making added up over the jobs ([Checking the verdicts](benchmark.md#checking-the-verdicts)).

A run of the workflow fits in about an hour only where its shards and its report are sized for it:

- **Shards.** The slowest share sets the run's time. Count shards from the scope's seconds a mutant on these runners: SvelteKit's were about 5 s, the calibration of each share included. Local ground truth has taken from 1 to 171 s a mutant, and this tool took 1.8 to 2.8 times as long on these runners as locally on headlamp `api` and ComfyUI `stores`; ground truth is likely to grow about as much, though that was not measured. Mutants times seconds, divided by about 2,000, gives shares of about 33 minutes on average. The slowest share took 1.3 and 1.5 times the mean in SvelteKit's two runs, about 310 mutants a share, and may spread further with fewer. Setup, the merge and a report made in the workflow add about 10 minutes for SvelteKit. With `--related`, each share also runs the related tests of every file of the report once with no mutant to take its limit, a cost more shards do not divide.
- **The runners.** The account runs twenty jobs at once, PR checks among them. Shards past the free runners wait for a share to end, and the run then takes about two shares' time. A scope of 1,000 mutants at headlamp's 56 s locally, perhaps 110 s or more here, would want about 55 shards, and does not fit in an hour.
- **The report.** A report made in the workflow adds the tool's own time on the scope before any share starts. That was about 9 minutes for SvelteKit, but 40 to 85 minutes for ComfyUI `stores` and element-plus and over 85 for headlamp `api`, freelens and fast-check on Linux ([On hosted CI runners](benchmark.md#on-hosted-ci-runners)). For such a scope, take the report of a bench run with `report=<run id>`.

## Evidence and timings

E2e evidence stays under `build/test-reports/<group>-<unique-id>/`: named reports, per-invocation stdout/stderr, session records and `runs.jsonl` with start/end times and exit status. This also preserves a successful CLI report that a later assertion rejects. The fixture directory is removed independently of those records.

CI keeps check-result manifests and test reports as separate artifacts. An always-run step stages available truth sessions under `build/test-reports/truth-sessions`, outside hidden node_modules folders, even when validation fails or times out. It does not follow session symlinks. The validation summary names the source commit, profile/reason, selected and omitted work, outcomes and command durations. GitHub's job/step records provide install/build time and queue time. Count total runner-minutes as well as elapsed time: separate lanes repeat setup and can consume more runner time even when feedback arrives sooner.

A local measurement on Node 24.21.0 and macOS arm64 took 534.81 seconds for all 166 baseline tests, with 492.11 seconds in e2e. The quick path takes a few seconds for typechecking and the unit tests, including the fixture and CI harness tests; the isolated cache group took 64.62 seconds for five tests. These are different scopes, not a claim that the same complete suite became hundreds of times faster. Hosted completion time and runner cost require runs of the final candidate.

Before accepting a harness change, compare the old and new test inventories by suite/title and platform skip conditions, account for added tests, check that local CLI execution intervals do not overlap, and complete the full truth and packed checks. Record the candidate's actual CI source identity; a local pass does not establish another platform or a deployed workflow.
