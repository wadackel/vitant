# vitant

Mutation testing for Vitest. Every verdict is what your own test suite would give; the run is faster than running it once per mutant.

[![native](https://github.com/wadackel/vitant/actions/workflows/native.yml/badge.svg?branch=main)](https://github.com/wadackel/vitant/actions/workflows/native.yml)
[![bench](https://github.com/wadackel/vitant/actions/workflows/bench.yml/badge.svg?branch=main&event=workflow_dispatch)](https://github.com/wadackel/vitant/actions/workflows/bench.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why vitant

- **Verdicts you can trust.** A mutant is Killed or Survived only on what your test files do when run whole, in a fresh process, with the mutant on from before the file is imported. The verdicts on the benchmark scopes are checked against the suite with the mutant written into the source: every mutant on some scopes, a sample and every survivor on others. [Limits](#limits) lists what cannot be judged that way. `--strict` makes every detection rest on a run made with nothing else on the machine, for a project to be held to that from the start; the default lets those runs go beside other test files', which is faster and has given the same verdicts on every benchmark scope.
- **Faster than a run per mutant.** On GitHub's hosted runners vitant is as fast as or faster than StrykerJS on every scope both ran. See [Benchmark](#benchmark).
- **Any Vitest from 3.0.** Run against 3.0, 3.2, 4.1 and 5.0.
- **Nothing to configure.** No plugin, no config change, no code added to your tests. vitant finds the Vitest config and the sources under `src`.

## Why not vitant

- Your tests do not run on Vitest.
- You cannot run Node 24.
- You are on Windows: every run starts a worker of its own there, since copying one needs `fork()`. One scope has been run on Windows, none timed.
- Your tests rewrite files they share. vitant names such files and ends with exit code 1.
- You rely on type tests. They are not run.
- You rely on StrykerJS directives. `// Stryker disable` is ignored.

## Quick start

> [!NOTE]
> vitant is not on npm yet. Until it is, clone this repository and run it from the sources: see [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
npm install -D vitant
npx vitant --mutate 'src/**/*.ts'
```

The end of a run on the fixture project in this repository looks like this:

```
Killed 142  Timeout 4  Survived 50  NoCoverage 9  Static 5  Pending 0
score 71.22% (covered 74.49%)  51 tests in 26 files, vitest 5.0.3
time 15.1s (generate 0.0s, run 15.0s, rounds 15)
whole-file runs 233: 224 in copies of a worker (43 made before the file loaded, 181 after), 9 in workers started for them
```

## Usage

```sh
# Mutate files matching a glob in another project, and write a report
npx vitant --root ../my-app --mutate 'src/**/*.ts' --report report.json

# Mutate only what changed since a git ref, as a pull request check would
npx vitant --changed origin/main

# Reuse the last run's results for test files that loaded nothing that changed
npx vitant --changed origin/main --incremental

# Write a page that shows the result in mutation-testing-elements
npx vitant --mutate 'src/**/*.ts' --elements report.html
```

Positional arguments are passed to Vitest as test file filters.

### In CI

The score never fails the run: there is no threshold option. The exit code is 1 when a test file had to be given up on and its mutants are left pending, when no test ran at all, or when files under version control are not as they were before the run. Bad arguments exit with 2. For a pull request check, `--changed <ref>` keeps the run to the lines changed since that git ref, compared with the working tree, so pass the merge base rather than a branch that has moved on. `--incremental` reuses the last run's results for test files that loaded nothing that changed; the results live in `node_modules/.vitant/`, which a fresh runner starts without, so keep that directory in the CI cache.

## Options

| Option | Default | Effect |
|---|---|---|
| `--root <dir>` | the current directory | The project, where its Vitest config is. |
| `--mutate <glob>` | the sources under `src` | Files to mutate. Repeatable. |
| `--exclude <glob>` | | Files not to mutate. Repeatable. |
| `--changed <ref>` | | Only mutants whose code lies entirely on lines changed since the git ref. |
| `--project <name>` | every project | The Vitest project to run. Repeatable. |
| `--report <file>` | | Write every mutant with its status as JSON. |
| `--elements <file>` | | Write the result for [mutation-testing-elements](https://github.com/stryker-mutator/mutation-testing-elements): a page for a name ending in `.html`, JSON otherwise. |
| `--incremental` | off | Reuse the last run's results for test files nothing they load has changed in. |
| `--static` | off | Also run mutants in code that only runs while a module loads. |
| `--confirm <n>` | every test file that reaches the mutant | Let a mutant go once it has passed the `n` test files nearest to it, and report it as Unconfirmed, not Survived, where others reach it. |
| `--strict` | off | Make the runs that confirm a failure no lead vouches for one at a time on the whole machine. By default they go beside other test files' runs, one run of a file at a time, and only files whose runs have got in each other's way wait for the machine to themselves; two files that share a port or a path and never meet in the suite could fail each other there. |
| `--led` | off | Leave a mutant a test failed with while trying it at that, with no run of its test file to confirm it, and report it as Led, not Killed. A mutant that failed a run of a test file next to other runs, with no lead, is not run again with nothing else running either, and is reported as Unconfirmed. |
| `--no-related` | | Run every test file, not only those that import a mutated file. |
| `--no-clone` | | Start a worker for every whole-file run instead of copying one. |
| `--max-workers <n>` | the number of processors | Workers at once. More than that and tests that wait on the clock fail on a machine that is behind; a third more gave wrong verdicts on hosted CI runners. |
| `--recycle-heap-mb <n>` | a third of the machine's memory divided by the workers, between 512 and 1,536 | A worker hands over once its live heap passes this, or its resident size passes 1.5 times this. Lower uses less memory and costs more restarts. |
| `--timeout-factor <n>` | 4 | A test may take this many times what it took unmutated. |
| `--timeout-ms <n>` | 3000 | And this much on top, in milliseconds. |
| `--help` | | Print the usage. |
| `--version` | | Print the version. |

`--confirm` and `--led` trade part of the answer for time. Neither guesses: what they left open is reported under a status of its own, and the score counts it as survived. What each saves and what it leaves out is measured in [docs/design.md](docs/design.md#tuning).

## Statuses

| Status | Meaning |
|---|---|
| Killed | A test file failed when run whole, in a fresh worker, with the mutant on from before the file was imported. |
| Timeout | The same, with the file running into a loop or a hang instead of failing. Counted as detected. |
| Survived | Every test file the mutant can change anything in passed, run that way. |
| Unconfirmed | No run settled the mutant: a test that reaches it was left out for failing with no mutant on, failed in one run of its file and passed in another, or has failed and passed with another mutant; or the files beyond the `--confirm` limit were not run. Or, with `--led`, a file failed with the mutant next to other runs and no run made with nothing else running was made to confirm it; the report names the file. Counted as survived in the score. |
| Led | Only with `--led`: a test failed with the mutant while trying it, and no run of the whole file was made to confirm it. Counted as survived in the score. |
| NoCoverage | No test runs the mutated code. |
| Static | The code only runs while a module loads, and no test or hook reaches it. Not run unless `--static` is given. |
| Pending | The run gave up on a test file before the mutant was settled. |

The exact definitions are in [docs/design.md](docs/design.md#statuses).

## How it works

- **Mutants are compiled in once, behind runtime switches.** Every mutant of a file goes into the source at the same time, as `__vitant__.a === 12 ? a - b : a + b`. The mutators and their names follow StrykerJS.
- **Mutants are tried inside the workers that are already running.** A custom runner repeats each test with one mutant on per repeat, so the test file is imported once for hundreds of mutants. A failure is checked against a run without the mutant.
- **Runs that cannot change anything are skipped.** During a test's unmutated run, probes compute what each mutated expression would have produced and follow the value as far as nothing else could see it. A test that cannot fail because of a mutant is not run with it.
- **Every verdict comes from a whole-file run.** What a test does with a mutant inside a shared worker is a lead, not a verdict. Each mutant is settled by running test files whole, in a fresh worker, with the mutant on from the start.
- **A fresh worker is a copy, not a start.** A worker that has loaded Vitest and the environment copies itself with `fork()` for each whole-file run, through a small addon in Rust. Where there is no `fork()`, a worker is started instead.
- **Results carry over on request.** With `--incremental`, a test file's results are reused when nothing it loaded has changed.

How each step was arrived at, what it costs, and what went wrong before it existed: [docs/design.md](docs/design.md).

## Benchmark

StrykerJS 10 and vitant over the same files of real projects at pinned commits, on GitHub's hosted runners. Seconds, the median of three runs; every report of vitant agreed with the stored ground truth, see [Checking the verdicts](docs/benchmark.md#checking-the-verdicts). The two ran one after the other in one job; the macOS runners are of one model, the Linux ones are not.

| Target and scope | Linux: StrykerJS | vitant | macOS: StrykerJS | vitant |
|---|---|---|---|---|
| ufo `all` | 54.4 | 23.7 | 63.5 | 44.8 |
| zustand `all` | 221.2 | 41.5 | 264.7 | 51.5 |
| es-toolkit `array` | 330.5 | 140.0 | 359.7 | 193.0 |
| es-toolkit `pr`: lines the pinned commit changed | 38.3 | 49.0 | 31.8 | 47.9 |
| immer `all` | 402.4 | 214.5 | 597.3 | 340.3 |
| jotai `vanilla` | 1,855.6 | 439.5 | 1,748.1 | 459.1 |
| query `core` | 1,737.1 | 397.3 | 1,445.5 | 369.8 |
| valibot `schemas` | 1,008.6 | 168.7 | 992.5 | 155.5 |
| xstate `core` | 584.7 | 375.9 | 702.6 | 520.5 |

On the eight whole-directory scopes that is 1.2 to 3.0 times as fast on macOS. On the few changed lines of es-toolkit `pr`, StrykerJS is the faster: one of its 93 mutants makes a loop that never ends, and vitant lets it run to the test's own limit before it calls it a timeout. The application targets, the scopes where StrykerJS does not start or reports nothing usable, and the other targets are in [docs/benchmark.md](docs/benchmark.md#on-hosted-ci-runners).

## Limits

- **Type tests are not run.** A mutant that only breaks types passes here.
- **Tests that read the source from disk see the original.** Mutants live in what Vitest serves, not in the files.
- **One test file runs in many processes at once**, which a plain run never does. Tests that listen on a port or write files next to themselves get in each other's way; vitant notices and runs such a file one process at a time.
- **A Vitest project with a config file of its own is not run.** Projects declared in the root config are.
- **A test that fails now and then** is left out once it is caught failing with no mutant on, and a mutant only it reaches is reported as Unconfirmed, not Survived. A test that is not caught, or that a mutant makes fail by chance, can still give a wrong verdict.
- **A timeout is a judgement.** No run is ended sooner than the project's own limit for the test that is running, but a mutant that keeps a hook busy for many times longer than the file takes, or makes several tests each wait for most of their time, and still finishes is called a timeout here.

The full list, with what each one cost on a real project: [docs/limits.md](docs/limits.md).

## Contributing

Node 24 runs the TypeScript sources directly. How to run the tool from a clone, which checks a change has to pass, and where the record behind the design lives are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
