# Contributing to vitant

## Running from the sources

Node 24 runs the TypeScript sources directly; nothing has to be built to run the tool.

```sh
pnpm install
pnpm build:native   # optional: the addon that copies a worker process instead of starting one; macOS and Linux, Rust 1.85 or later
node src/cli.ts --root ../my-app --mutate 'src/**/*.ts' --report report.json
```

## Checking a change

Start with the short checks while editing, then run the e2e group that exercises the change:

```sh
pnpm check:quick                  # typecheck and unit tests
pnpm test:smoke                   # native supervision and small CLI fixtures
pnpm test:e2e test/e2e/cache.test.ts
```

Pass the file name directly, without a separating `--`: Vitest treats arguments after that separator differently and can run the entire project instead. A selected group does not establish that all tests pass.

Before finishing a change, run the complete checks:

```sh
pnpm test           # all unit, smoke and e2e tests
pnpm test:truth     # complete truth checks for basic (both modes), stuck, clash and walk
pnpm test:packed    # the tool packed, installed into a copy of the fixture and run from there
pnpm typecheck
```

A verdict must equal what the plain suite gives with the mutant written into the source, so a change to instrumentation, planning, the runner or the addon is also run against benchmark targets and compared mutant by mutant. What to run, what counts as a defect, and how to say what was checked are under [Verifying a change](AGENTS.md#verifying-a-change) in AGENTS.md; the benchmark commands are under [Commands](AGENTS.md#commands) there.

Run `test`, `test:truth` and `test:packed` one after another in a checkout. Truth writes mutants into tracked sources, and the other runs check those files for changes. The [development workflow](docs/development.md) describes the CI profiles, reports and measurements.

## Where things are

The layout of the sources is the [Layout](AGENTS.md#layout) table in AGENTS.md. The record behind the design, which explains why the tool is built the way it is and what was tried and dropped:

- [docs/design.md](docs/design.md): how a verdict is reached, what makes a fresh process cheap, and what each rule cost
- [docs/benchmark.md](docs/benchmark.md): the targets, the times, and how the verdicts are checked against the suite
- [docs/decisions.md](docs/decisions.md): ideas that were built, measured, and dropped, with their numbers
- [docs/limits.md](docs/limits.md): what cannot be judged, and why

Read `docs/design.md`, `docs/limits.md` and `docs/decisions.md` before changing behaviour: every shortcut that looked safe turned out wrong on some real project until it was checked against ground truth.

## Conventions

Everything in the repository is in English, comments say only why the obvious alternative was rejected, and GitHub Actions are pinned to full commit SHAs. The full list is under [Conventions](AGENTS.md#conventions) in AGENTS.md.
