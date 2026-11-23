# vitant

Mutation testing for Vitest. Every verdict is what your own test suite would give; the run is faster than running it once per mutant.

[![native](https://github.com/wadackel/vitant/actions/workflows/native.yml/badge.svg?branch=main)](https://github.com/wadackel/vitant/actions/workflows/native.yml)
[![bench](https://github.com/wadackel/vitant/actions/workflows/bench.yml/badge.svg?branch=main&event=workflow_dispatch)](https://github.com/wadackel/vitant/actions/workflows/bench.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why vitant

- **Verdicts you can trust.** A mutant is Killed or Survived only on what your test files do when run whole, in a fresh process, with the mutant on from before the file is imported. The verdicts on the benchmark scopes are checked against the suite with the mutant written into the source: every mutant on some scopes, a sample and every survivor on others. [Limits](#limits) lists what cannot be judged that way. `--strict` makes every detection rest on a run made with nothing else on the machine, for a project to be held to that from the start; the default lets those runs go beside other test files', which is faster and has given the same verdicts on every benchmark scope.
- **Faster than a run per mutant.** See [Benchmark](#benchmark) for StrykerJS comparisons on pinned projects and the limits of each comparison.
- **Any Vitest from 3.0.** Run against 3.0, 3.2, 4.1 and 5.0.
- **Nothing to configure.** No plugin, no config change, no code added to your tests. vitant finds the Vitest config and the sources under `src`.

## Why not vitant

- Your tests do not run on Vitest.
- You cannot run Node 24.
- You are on Windows: every run starts a worker of its own there, since copying one needs `fork()`. One scope has been run on Windows, none timed.
- Your tests rewrite files they share, or remove the temp directory. vitant names such files, or the directory, and ends with exit code 1.
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

The score never fails the run: there is no threshold option. The exit code is 1 when a test file had to be given up on and its mutants are left pending, when no test ran at all, when files under version control are not as they were before the run, or when tests removed the temp directory they were given. Bad arguments exit with 2. For a pull request check, `--changed <ref>` keeps the run to the lines changed since that git ref, compared with the working tree, so pass the merge base rather than a branch that has moved on. `--incremental` reuses the last run's results for test files that loaded nothing that changed; the results live in `node_modules/.vitant/`, which a fresh runner starts without, so keep that directory in the CI cache.

A run can be split across jobs. `--shard <i>/<n>` mutates only the i-th of n shares of the files, dealt so that each has about as many mutants, and every machine deals the same sources the same way. `vitant merge` makes one report of the shares' reports, and refuses a share left out, given twice or with another count:

```sh
npx vitant --shard 1/3 --report shard-1.json   # in each of three jobs, with its own index
npx vitant merge --report vitant.json --elements vitant.html shard-1.json shard-2.json shard-3.json
```

Shares are of whole files, so a file with most of the mutants makes its share the largest: ufo's 918 came out as 433, 248 and 237. Each mutant is judged in its share as in a run of all of them; on the fixture project and on ufo, three shares merged gave every mutant the verdict one run of all of them gave. What takes longer is the start of each job and the round that runs every test file a share's files reach. The test files whose runs fail each other are found in each share by itself.

## Options

| Option | Default | Effect |
|---|---|---|
| `--root <dir>` | the current directory | The project, where its Vitest config is. |
| `--config <file>` | the one Vitest finds in the root, `vitest.config.ts` and the like | The Vitest config file, a path relative to the root, for a suite that runs as `vitest --config <file>`. |
| `--mutate <glob>` | the sources under `src` | Files to mutate. Repeatable. Only JavaScript and TypeScript are mutated: a file of another kind it matches, a `.vue` or `.svelte` component for one, is named in the output and left out. |
| `--exclude <glob>` | | Files not to mutate. Repeatable. |
| `--changed <ref>` | | Only mutants whose code lies entirely on lines changed since the git ref. |
| `--shard <i>/<n>` | | Only the i-th of n shares of the files to mutate, with about as many mutants in each; `vitant merge --report <file> [--elements <file>] <reports>...` makes one report of them. |
| `--project <name>` | every project | The Vitest project to run. Repeatable. |
| `--report <file>` | | Write every mutant with its status as JSON. |
| `--elements <file>` | | Write the result for [mutation-testing-elements](https://github.com/stryker-mutator/mutation-testing-elements): a page for a name ending in `.html`, JSON otherwise. |
| `--incremental` | off | Reuse the last run's results for test files nothing they load has changed in; a change to comments, layout or types alone is no change. |
| `--static` | off | Judge mutants reached only while a module loads. |
| `--confirm <n>` | every test file that reaches the mutant | Let a mutant go once it has passed the `n` test files nearest to it, and report it as Unconfirmed, not Survived, where others reach it. |
| `--fast` | off | `--led` and `--confirm 1`, with a lead counted only from a test that failed with its file to itself, and led mutants counted as detected in the score. About 1.5 to 5 times as fast as without it on the benchmark targets. |
| `--strict` | off | Make the runs that confirm a failure no lead vouches for one at a time on the whole machine. By default they go beside other test files' runs, one run of a file at a time, and only files whose runs have got in each other's way wait for the machine to themselves; two files that share a port or a path and never meet in the suite could fail each other there. |
| `--led` | off | Leave a mutant a test failed with while trying it at that, with no run of its test file to confirm it, and report it as Led, not Killed. A mutant that failed a run of a test file next to other runs, with no lead, is not run again with nothing else running either, and is reported as Unconfirmed; so is one whose run of a test file was stopped for the memory it held. |
| `--no-related` | | Run every test file, not only those that import a mutated file. |
| `--no-clone` | | Start a worker for every whole-file run instead of copying one. |
| `--max-workers <n>` | the number of processors | Workers at once. More than that and tests that wait on the clock fail on a machine that is behind; a third more gave wrong verdicts on hosted CI runners. |
| `--recycle-heap-mb <n>` | a third of the machine's memory divided by the workers, between 512 and 1,536 | A worker hands over once its live heap passes this, or its resident size passes 1.5 times this. Lower uses less memory and costs more restarts. |
| `--memory-mb <n>` | what the machine has available, less a sixteenth of its memory | The most the processes that run test files may be expected to hold together. From the second round on, a process waits for room before it starts on a file, going by what the file's processes were seen to hold; it is a forecast, not a hard limit, and a process goes anyway where nothing else could give memory back, so none is left out. Where workers are not copied (`--no-clone`, Windows) nothing waits. |
| `--timeout-factor <n>` | 4 | A test may take this many times what it took unmutated. |
| `--timeout-ms <n>` | 3000 | And this much on top, in milliseconds. |
| `--help` | | Print the usage. |
| `--version` | | Print the version. |

`--confirm` and `--led` trade part of the answer for time. Neither guesses: what they left open is reported under a status of its own, and the score counts it as survived. `--fast` goes one step further and counts a led mutant as detected: on the Linux benchmark runs no led mutant was one the suite passes with, and locally two of about 21,000 were. What each saves and what it leaves out is measured in [docs/design.md](docs/design.md#tuning).

## Statuses

| Status | Meaning |
|---|---|
| Killed | A test file failed when run whole, in a fresh worker, with the mutant on from before the file was imported. |
| Timeout | The same, with the file running into a loop or a hang instead of failing. Counted as detected. |
| Survived | Every test file the mutant can change anything in passed, run that way. |
| Unconfirmed | No run settled the mutant: a test that reaches it was left out for failing with no mutant on (one that never passed, every mutant in the sources its file loads), failed in one run of its file and passed in another, or has failed and passed with another mutant; or the files beyond the `--confirm` limit were not run. Or, with `--led`, a file failed with the mutant next to other runs, or its run was stopped for its memory, and no run made with nothing else running was made to settle it; the report names the file. Counted as survived in the score. |
| Led | Only with `--led`: a test failed with the mutant while trying it, and no run of the whole file was made to confirm it. Counted as survived in the score. |
| NoCoverage | No test runs the mutated code. |
| Static | Reached only while loading and left unjudged. `--static` requests verdicts for these mutants. |
| Pending | The run gave up on a test file before the mutant was settled. The report's `abandonedFiles` says why for each file: it failed with no mutant on and nothing else running, with no test to name (`restless`); it still had runs to make after `--max-rounds` rounds (`round cap`); or after three rounds in a row that added nothing to what the runs had found (`no headway`), with what those rounds gave it to do and how each run ended. |

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

StrykerJS 10 and vitant at [bc4025c](https://github.com/wadackel/vitant/commit/bc4025c9fbdc22c4333e1110d18e2536b8eac153), measured on 15 November 2026 one after the other in each job on a four-core Ubuntu 24.04 runner, with Node 24.22.2 and pinned target commits: three jobs a scope ([libraries](https://github.com/wadackel/vitant/actions/runs/43624239141), [three more](https://github.com/wadackel/vitant/actions/runs/43627153264)). Seconds are medians; speed ratios are medians of within-job ratios, so they need not equal the ratio of the displayed seconds. A ratio above one favors vitant.

| Target and scope | Usable Stryker pairs / vitant runs | StrykerJS s | vitant s | vitant `--fast` s | Median paired Stryker / vitant |
|---|---:|---:|---:|---:|---:|
| yaml `lexer` | 3 / 3 | 525.0 | 393.0 | 71.0 | 1.251 |
| ufo `all` | 3 / 3 | 61.5 | 31.0 | 5.0 | 1.984 |
| immer `all` | 3 / 3 | 689.5 | 428.3 | 203.6 | 1.585 |
| es-toolkit `array` | 2 / 3 | 308.8 | 160.8 | 37.0 | 1.911 |
| es-toolkit `pr` | 3 / 3 | 26.9 | 49.8 | 13.5 | 0.532 |
| xstate `core` | 3 / 3 | 677.5 | 422.8 | 156.0 | 1.600 |
| i18next `translation` | 0 / 3 | not comparable | 72.2 | 32.8 | — |
| date-fns `dates` | 0 / 3 | not comparable | 18.0 | 8.7 | — |
| Secretlint `messages` | 3 / 3 | 8.8 | 2.9 | 1.9 | 3.088 |
| CSpell `distance` | 3 / 3 | 141.0 | 98.0 | 37.9 | 1.439 |
| commitlint `lint` | 3 / 3 | 24.0 | 4.7 | 3.0 | 5.200 |

When Stryker is usable, the StrykerJS and vitant columns use those same pairs; the `--fast` column uses every run. A Stryker run is usable when it exited with 0: one es-toolkit `array` run ended in 6 s with 1. Stryker selects zero tests for covered survivors on i18next and date-fns. vitant remains slower than StrykerJS on es-toolkit `pr`, the changed-lines scope, where two fifths of its time go to mutants whose loops run out a test's limit; `--fast` is not.

Against the same measurement of [b58eef9](https://github.com/wadackel/vitant/commit/b58eef9) on 10 November, the medians moved by a tenth or less, except Secretlint `messages` from 2.710 to 3.088, es-toolkit `array` from 2.218 to 1.911, immer from 1.755 to 1.585 and es-toolkit `pr` from 0.693 to 0.532. Between the two, [#16](https://github.com/wadackel/vitant/pull/16) makes a run stopped for its memory again alone, which within one job cost es-toolkit `array` 13 and immer 11 in a hundred; within one job the changes after it gave these 0.96 to 1.08. Every judged stored-truth entry agrees; these checks cover subsets of the generated mutants. [Application scopes, CI cohorts, correctness evidence and historical macOS measurements](docs/benchmark.md#on-hosted-ci-runners).

The targets added in November 2026, StrykerJS and vitant one after the other in a job, one run each, at [c853c54](https://github.com/wadackel/vitant/commit/c853c54208a102dc587aa925d484efe347b58275) on four-core Ubuntu 24.04 runners ([run](https://github.com/wadackel/vitant/actions/runs/44902363147); fast-check, added after it, at [516c9ac](https://github.com/wadackel/vitant/commit/516c9ac951df2d964035027c741cb1a4288c9f69) ([run](https://github.com/wadackel/vitant/actions/runs/44936867476))). The times are of the tool at those commits; #68 and #70 to #72 changed it after them (fast-check's commit has #68). Runners differ by half in speed, so only times from one job compare; "not comparable" marks a StrykerJS run that kills none or few of its mutants, or times out a third or more ([notes](docs/benchmark.md#every-target-on-main-21-november-2026)).

| Target and scope | Processor | StrykerJS | vitant | Against the suite |
|---|---|---|---|---|
| koel `composables` | Xeon 6975P-C | does not start | 1,611 s | all 1,120 agree |
| homepage `utils` | Xeon 6975P-C | 550 s | 919 s | all 726 agree |
| tailwindcss `parsers` | Xeon 6975P-C | 2,465 s, not comparable | 1,789 s | all 843 agree |
| sentry `utils` | EPYC 9V74 | 473 s | 386 s | all 883 agree |
| lobehub `topic` | Xeon 6975P-C | 1,957 s, not comparable | 2,882 s | all 502 agree |
| Shopify CLI `node` | Xeon 6975P-C | does not start | 240 s | all 718 agree (with `archiver.ts`, since left out: 43 of them) |
| promptfoo `assertions` | Xeon 6975P-C | does not start | 725 s | all 480 agree |
| ComfyUI_frontend `stores` | Xeon 6975P-C | 1,181 s, not comparable | 2,601 s | all 1,041 agree |
| freelens `utils` | Xeon 8573C | not run (`strykerSkip`) | 7,963 s | all 410 agree |
| n8n `proxy` | Xeon 6975P-C | 991 s | 756 s | all 1,351 agree |
| headlamp `api` | Xeon 6975P-C | 2,100 s | 5,438 s | all 641 agree |
| zod `core` | EPYC 9V74 | does not start | 1,768 s | all 1,240 agree |
| vercel/ai `node` | Xeon 6975P-C | 1,432 s | 639 s | all 756 agree |
| vercel/ai `edge` | Xeon 6975P-C | 1,476 s | 654 s | all 752 agree |
| SvelteKit `server` | EPYC 7763 | not run (`strykerSkip`) | 625 s | 1,042 agree, 17 as their notes say, 2 unconfirmed |
| renovate `util` | EPYC 9V74 | does not start | 554 s | 469 agree, 2 as their notes say |
| lint-staged `lib` | Xeon 6975P-C | 1,898 s, not comparable | 1,883 s | all 530 agree |
| happy-dom `selectors` | Xeon 6975P-C | does not start | 625 s | all 702 agree |
| mikro-orm `core` | EPYC 7763 | 3,680 s, not comparable | 3,220 s | all 616 agree |
| coder `agents` | Xeon 6975P-C | does not start | 570 s | all 2,670 agree |
| element-plus `table` | Xeon 6975P-C | 2,277 s, not comparable | 4,582 s | all 2,088 agree |
| element-plus `hooks` | Xeon 6975P-C | 208 s, not comparable | 4,096 s | 1,052 agree, 2 unconfirmed |
| fast-check `check`, at 516c9ac | Xeon 6975P-C | does not start | 5,633 s | all 505 agree |

## Limits

- **Type tests are not run.** A mutant that only breaks types passes here.
- **Tests that read the source from disk see the original.** Mutants live in what Vitest serves, not in the files.
- **One test file runs in many processes at once**, which a plain run never does. Tests that listen on a port or write files next to themselves get in each other's way; vitant notices and runs such a file one process at a time.
- **A Vitest project with a config file of its own is not run.** Projects written inline in the root config, under `test.projects` or, before Vitest 4, `test.workspace`, are.
- **Only JavaScript and TypeScript are mutated.** The `<script>` of a `.vue` or `.svelte` component is not: such a file is named in the output and left out.
- **A file the project's own plugins compile otherwise once instrumented is left out** and named, with why: one whose source and instrumented code import different modules after the plugins, as a hook the React Compiler compiles from its source and gives up on instrumented. A plugin that treats them differently without changing their imports is not seen. The exit code stays 0 for such a file, as for every file left out; the summary at the end of the output gives their number and names each.
- **A test that fails now and then** is left out once it is caught failing with no mutant on, and a mutant only it reaches is reported as Unconfirmed, not Survived. A test that is not caught, or that a mutant makes fail by chance, can still give a wrong verdict.
- **A timeout is a judgement.** No run is ended sooner than the project's own limit for the test that is running, but a mutant that keeps a hook busy for many times longer than the file takes, or makes several tests each wait for most of their time, and still finishes is called a timeout here.

The full list, with what each one cost on a real project: [docs/limits.md](docs/limits.md).

## Contributing

Node 24 runs the TypeScript sources directly. How to run the tool from a clone, which checks a change has to pass, and where the record behind the design lives are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
