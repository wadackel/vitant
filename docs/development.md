# Development workflow

The short commands answer whether an edit is ready for a larger check. The full commands retain every test and every ground-truth comparison; a quick pass does not replace them.

## Local checks

| Command | Scope |
|---|---|
| `pnpm check:quick` | TypeScript and the unit project |
| `pnpm test:unit` | Instrumentation, bindings, verdicts, process locks and harness unit tests |
| `pnpm test:smoke` | Native supervision, copied runs, clocks and Vitest 3 mocks |
| `pnpm test:e2e test/e2e/cache.test.ts` | Incremental and transformed-module caches |
| `pnpm test:e2e test/e2e/basic.test.ts` | Basic verdicts and worker-count, strict, no-clone, static, confirm and led comparisons |
| `pnpm test:e2e test/e2e/boundaries.test.ts` | Limits, hangs, conflicting runs, changed files and typechecking boundaries |
| `pnpm test` | All unit, smoke and e2e tests |
| `pnpm test:truth` | Every eligible mutant in basic/default, basic/static, stuck, clash and walk, written into the source and judged by the suite |
| `pnpm test:packed` | Installed-package verdicts compared with the source invocation |

File arguments follow the script name directly. A separating `--` can prevent Vitest from using the file filter.

Build the addon with `pnpm build:native` before smoke or full tests on supported platforms. Smoke must exercise copies there; a missing addon is a failure. Windows runs the CLI without it and skips only the native-specific assertions it already skipped.

The e2e groups own private fixture directories and report directories. Basic/options share one baseline inside their file; the clash scenarios retain their order. Vitest runs unit, smoke and e2e projects in order, with only unit files running concurrently. The inner CLI worker counts and verdict rules are unchanged.

Run full tests, truth and packed checks sequentially in one checkout. Private fixture paths do not make truth safe beside another CLI run: truth writes tracked files, and the CLI checks the containing repository for changes. A second run on one root also replaces its session. Leave tracked files alone while a run is in progress.

## CI profiles

| Profile | Selection | Required validation |
|---|---|---|
| docs | Only README, CONTRIBUTING, LICENSE or Markdown under docs | Profile selection and lockfile validation; platform checks explicitly finish through the docs path |
| standard | Only src/mutate, the listed platform-independent unit tests, and documentation | Build/smoke on all seven environments; complete detail on Linux x64 glibc and macOS arm64 |
| full | Any other path, mixed high-risk changes, missing/invalid/empty diff, or the daily/manual full run | Every original unit, smoke, e2e, truth and packed check on every original environment |

`bench/ci.ts` contains the small allowlist. It does not infer test relevance from imports. Runtime, native, process-lock tests, fixtures, test helpers, dependency/config changes, CI and agent instructions all select full. AGENTS.md, CLAUDE.md and SKILL.md select full at any depth, including under docs or src/mutate. Renames include the old and new paths; a failed diff cannot select a cheaper profile. The summary records the comparison mode, base/head SHAs and whether the diff resolved, separately from the tested checkout SHA.

The seven environments are macOS arm64/x64, Linux x64/arm64 with glibc/musl, and Windows x64. Typechecking remains on the five macOS/glibc/Windows targets that ran it before; musl retains its Alpine container boundary. Standard uses the full unit suite on both representative targets, not just native tests.

The quick Linux job supplies its same-source typecheck/unit result once. Build/smoke jobs compile each addon once and upload it with source, workflow-run, platform and content identities. Detail jobs download only from that workflow run and verify the manifest before using the binary.

Detail has two lanes, each in its own checkout: regression (unit/typecheck where required, e2e, packed) and truth. At most four detail jobs run at once. Windows truth is queued first because delaying it would lengthen an already long critical path. A full run may still take as long as Windows truth.

The gate checks the exact expected target/suite set, prerequisite job outcomes and source/run identity. Missing, duplicate, mismatched, failed, cancelled or unexpectedly skipped results fail it. A matrix job's last output is not evidence for the other matrix entries. The original platform check names remain, and `Required validation` is the single overall result; repository protection settings are not changed automatically.

Main pushes and pull requests use automatic classification. A newer automatic run cancels only the older run for that event and ref. Scheduled full runs occur daily at 20:17 UTC; manual runs default to full and can explicitly request standard. Neither is cancelled by an automatic run. Investigate a failing full run before making further changes that could obscure it.

## Performance experiments

The benchmark workflow is manual. It retains the target/scope, tool, baseline commit, repetition, runner and record inputs, and the ground-truth comparisons. It no longer starts all 26 scopes on two operating systems for every matching main push.

Use `node bench/tier.ts`, `node bench/tier.ts apps`, or explicit `target:scope` arguments to see work counts and verdict agreement early. Compare before and after on at least two targets for instrumentation, planning, runner or addon changes. Changes to Date, performance, fs or process values need the full application scopes too; the short scopes cannot establish their correctness.

## Evidence and timings

E2e evidence stays under `build/test-reports/<group>-<unique-id>/`: named reports, per-invocation stdout/stderr, session records and `runs.jsonl` with start/end times and exit status. This also preserves a successful CLI report that a later assertion rejects. The fixture directory is removed independently of those records.

CI keeps check-result manifests and test reports as separate artifacts. An always-run step stages available truth sessions under `build/test-reports/truth-sessions`, outside hidden node_modules folders, even when validation fails or times out. It does not follow session symlinks. The validation summary names the source commit, profile/reason, selected and omitted work, outcomes and command durations. GitHub's job/step records provide install/build time and queue time. Count total runner-minutes as well as elapsed time: separate lanes repeat setup and can consume more runner time even when feedback arrives sooner.

A local measurement on Node 24.21.0 and macOS arm64 took 534.81 seconds for all 166 baseline tests, with 492.11 seconds in e2e. The quick path takes a few seconds for typechecking and the unit tests, including the fixture and CI harness tests; the isolated cache group took 64.62 seconds for five tests. These are different scopes, not a claim that the same complete suite became hundreds of times faster. Hosted completion time and runner cost require runs of the final candidate.

Before accepting a harness change, compare the old and new test inventories by suite/title and platform skip conditions, account for added tests, check that local CLI execution intervals do not overlap, and complete the full truth and packed checks. Record the candidate's actual CI source identity; a local pass does not establish another platform or a deployed workflow.
