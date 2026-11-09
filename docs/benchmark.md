# Benchmark

What StrykerJS and vitant take on the same files of real projects at pinned commits, and how the verdicts were checked against the suite.

The benchmark runs StrykerJS 10 and this tool over the same files of projects at pinned commits, and checks the verdicts against ground truth: each mutant put into the source for real and the plain suite run on the test files that reach it.

| Target | Vitest | Tests |
|---|---|---|
| [excalidraw](https://github.com/excalidraw/excalidraw) | 3.0.6 | jsdom, 141 files, a large application imported by most of them |
| [immer](https://github.com/immerjs/immer) | 3.2.6 | node, 22 files, one of them with 3,350 tests; much is computed while the files load |
| [es-toolkit](https://github.com/toss/es-toolkit) | 4.1.10 | node, a small spec file next to every function |
| [jotai](https://github.com/pmndrs/jotai) | 5.0.2 | jsdom and React Testing Library, 44 files |
| [zustand](https://github.com/pmndrs/zustand) | 4.1.10 | jsdom, 13 files; imports go through an alias and one suite resets modules before every test |
| [hono](https://github.com/honojs/hono) | 5.0.1 | node, 145 files in several Vitest projects |
| [TanStack Query](https://github.com/TanStack/query) `query-core` | 4.1.11 | one package of a pnpm workspace; fake timers throughout, type tests next to the tests |
| [pinia](https://github.com/vuejs/pinia) | 4.1.11 | Vue, a workspace run from its root config; two test files of another package fail to load |
| [ufo](https://github.com/unjs/ufo) | 4.1.5 | node, one small module, 13 files |
| [vue](https://github.com/vuejs/core) | 4.1.11 | 183 files in five projects of one config, two of which need a browser and are left out; threads as the pool, a setup file whose hooks fail a test for a warning nobody asserted |
| [solid](https://github.com/solidjs/solid) | 4.1.10 | jsdom, one package of a workspace; every file in one worker without isolation, and one test that fails one run in four with no mutant |
| [svelte](https://github.com/sveltejs/svelte) | 4.1.7 | 21 files, two of which register over a thousand sample directories each as tests, compile them to files on disk and import those |

```sh
node bench/setup.ts excalidraw        # clone the pinned commit, install it and StrykerJS
node bench/run.ts excalidraw math     # mutate packages/math/src, run both tools, compare verdicts
node bench/run.ts excalidraw pr       # mutate only the lines the pinned commit changed
```

Results are written to `bench/results/<target>-<scope>/`: `summary.json` has the wall-clock times and `compare.txt` how the verdicts line up. StrykerJS runs with `coverageAnalysis: perTest`, `ignoreStatic: true` and no type checker, which is its fastest configuration.

The times that are kept up to date are those under "On hosted CI runners" below. The tables before it are of one machine at the time each target was added, and say what a rule cost or gained there. Apple M6 (12 cores, 32 GB), Node 24.21.0. StrykerJS was run once, this tool as often as times are shown. The times of this tool were taken before a loop in a whole-file run had to keep the process busy for a second to count as endless; that rule adds about a second of one core for every such mutant, which on this machine took es-toolkit `array` from 24 s to 34 s and hono `router` from 35 s to 40 s. What exact verdicts allow at best on this machine follows from the runs of a session: those that are made with nothing else running take what they took, and all the others, spread with no gap over the twelve workers, take a twelfth of theirs. For runs that took 105.1 s on immer, 49.1 s on es-toolkit `array` and 12.7 s on ufo that is 62.8 s, 31.4 s and 7.0 s, leaving out the start of each worker, 20 ms to 140 ms before its first record.

| Target and scope | Mutants | StrykerJS | This tool | Without copies |
|---|---|---|---|---|
| jotai `vanilla`: `src/vanilla` | 1,160 | 298.3 s | 82.8 s | 236.0 s |
| zustand `all`: `src` | 566 | 38.2 s | 14.2 s | 47.4 s |
| ufo `all`: `src` | 918 | 13.2 s | 6.8 s | 14.2 s |
| es-toolkit `array`: `src/array` | 706 | 59.9 s | 49.4 s | 36.4 s |
| query `core`: `packages/query-core/src` | 2,804 | 253.7 s | 205.4 s | 251.0 s |
| excalidraw `math`: 14 files of `packages/math/src`, exercised by 134 test files | 1,604 | 854.6 s | 588.4 s | 671.3 s |
| excalidraw `pr`: lines the pinned commit changed in 4 application files | 99 | 279.3 s | 236.8 s | 212.0 s |
| immer `all`: `src` | 1,535 | 86.6 s | 95.6 s | 119.7 s |
| pinia `pinia`: `packages/pinia/src` | 1,367 | failed to start | 14.2 s | 48.3 s |
| hono `utils`: `src/utils` | 2,530 | see below | 135.7 s | 108.9 s |
| hono `router`: `src/router` | 1,121 | see below | 40.2 s | 58.3 s |

Each of these is one run on a quiet machine. StrykerJS and the last column, the same tool starting a worker for every whole-file run (`--no-clone`), are of one evening; the column of this tool is of the day after, when the rules for what settles a failure had been tightened once more, and the last column would be slower by as much if made again. This tool agrees with the suite on every mutant checked. Against StrykerJS that is 3.6 times as fast on jotai, 2.7 on zustand, 1.9 on ufo, 1.5 on excalidraw `math`, 1.2 on es-toolkit, query and excalidraw `pr`, and 0.9 on immer, where it is the slower of the two. Before any of those rules it read 4.8, 3.2, 2.6, 1.7, 2.6, 2.3, 1.7 and 1.5.

That is what being right costs here. A failure in a test that had not itself failed with the mutant while trying it, its file to itself, settles nothing, however often it repeats in a row: the run goes on to a test that had, or the tests that failed try the mutant in a round of their own, or the file is run once more with nothing else running, one run at a time. In these runs that last step was made 34 times on zustand, 133 on immer, 75 on vue, 203 on solid, and not once did the file pass: on a quiet machine with twelve cores every one of those mutants would have been reported as killed without it, correctly. The one mutant it was written for failed twice in a row on a 4-core CI runner and passes the suite. The report says how many such runs were made and how many passed.

Copies remove the start of a worker and, for most mutants, the imports. What is left is the tests. Where they are light that is most of the time gone (jotai, zustand, pinia); where they are heavy it is not: in excalidraw the 1,053 whole-file runs of the mutants nothing detects take a median of 3.6 s of tests each, and in immer, whose whole suite takes under a second, 2,900 copies still each run a test file. macOS also limits it: copying a process is serialised in the kernel, about 3 ms a copy.

StrykerJS finished on hono in 137 s and 190 s but reported nearly every mutant as survived (1,026 of the 1,121 in `router`, 917 of which this tool detects; ground truth agreed on each of the 754 detections it got to), so its times there say nothing. Why was not looked into; hono declares its tests as several Vitest projects.

Started for each run, a worker costs the tests themselves where they are heavy (excalidraw: the heaviest file takes 20 s) and its own start where they are not (jotai: process, Vitest, jsdom and React come to about 1 s a run, against 0.09 s of tests). The workers keep every core busy: 12 workers took as long as 16. The main process uses under a tenth of a core.

## The three targets added last

Chosen for shapes the first nine do not have, and each run for the first time found something. The last three rows came later, one run each. Two to four runs each on the same machine; the check against the suite is of a sample, spread evenly over the mutants, and of every mutant reported as survived besides.

| Target and scope | Mutants | This tool | Against the suite | StrykerJS |
|---|---|---|---|---|
| vue `reactivity`: `packages/reactivity/src` | 1,675 | 130 s | 1,595 checked, every mutant judged among them: 1,581 agree, none wrong, 14 not judged | does not start: a test fails in its first run |
| solid `reactive`: `src/reactive` | 1,560 | 755 s | 1,454 checked, every mutant judged among them: 1,450 agree, none wrong, 4 not judged | 212.3 s, not comparable: see below |
| svelte `sources`: one file of the runtime | 244 | 2,879 s | 70 checked, every survivor among them: 67 agree, none wrong, 3 not judged | does not start |
| Effect `data`: three modules that nearly every test file imports | 1,507 | 599 s | 179 checked, every survivor among them: all agree | not run |
| shiki `transformers`: `packages/transformers/src` | 1,037 | 56 s | 887 checked, every mutant judged among them: 884 agree, none wrong, 3 not judged | not run |
| unocss `core`: `packages-engine/core/src/utils` | 650 | 1 s | 40 checked: all agree | not run |
| pacer `timing`: three files of `packages/pacer/src` (Vitest 5, happy-dom, fake timers) | 603 | 10 s | 556 checked, every mutant judged among them: 551 agree, none wrong, 5 not judged | 41 s and not one mutant detected, on Vitest 5; not looked into |
| xstate `core`: `stateUtils.ts` and `StateMachine.ts` (Vitest 3.2, real timers) | 1,133 | 107 s | 1,091 checked, every mutant judged among them: 1,090 agree, none wrong, 1 not judged | 168.6 s next to 123.3 s here on a busy machine; 63 mutants it reports as killed survive here, and all 63 pass the suite |
| valibot `schemas`: `library/src/schemas` (Vitest 4, jsdom, no isolation between test files) | 4,672 | 95 s | 3,108 checked, every mutant judged among them: all agree | 198.1 s next to 116.5 s here on a busy machine; the same verdict on all 4,573 mutants both ran |
| h3 `utils`: `src/utils` (Vitest 5, every suite also against a server on a port) | 4,096 | 744 s | 790 checked, every survivor among them: 701 agree, 89 that pass every test and fail the project's type check | not run |

What they showed, each fixed:

- **The run without the mutant after a failure with it had no limits of its own.** In vue a mutant left a dependency graph built wrong, and the run that was to show whether the test still passes took a billion loop iterations; the worker was silent for over a minute and Vitest gave up on it without stopping it, so the tool never ended. In svelte the same run waited on a promise nothing would settle, for the half minute the project gives a test, hundreds of times. That run is held to the limits of the run with the mutant.
- **Probes make a tight loop some 25 times slower.** A test of solid that takes 0.3 s ran out of its 5 s on its unmutated run and was left out as failing without any mutant. Such a run is made again without probes, and every mutant in the code it reached then counts as one that can change it. Reads of a property written with a dot no longer go through one shared `o[k]` per file, which took solid from 524 s to 474 s.
- **A mutant that leaves a test failing for good** was one more mutant nobody detected, and every test reaching it gave up a worker to it before any file was run: 50 rounds on solid and four files given up on. It is a lead for a whole-file run, like a failure the test did not repeat without the mutant.
- **A test whose unmutated run failed was tried again in a worker where tests before it had tried mutants,** and failed again on what they left. In a file with such a test nothing tries a mutant in that round.
- **A send to a worker that had just died** ended the main process on Vitest 4; **a worker that does not end when asked** kept Vitest waiting at the very end until Node ended the process without a report; **a project's own worker arguments** (`--expose-gc`) were replaced by the tool's.

On solid StrykerJS ran 93 of the 484 tests and reported 420 mutants as covered by none; this tool detects 195 of those and has 102 survive. Its 212 s are for a quarter of the work, and the 103 mutants on which the two disagree between detected and not were not checked against the suite one by one. No time of StrykerJS on these three targets is one to compare with.

Effect is slow for another reason than the rest. Its 146 surviving mutants are in modules that some 300 test files load, and a mutant survives only once it has passed every one of them: 4,800 of the 8,000 whole-file runs and three fifths of their time. It took 1,810 s while the files were tried cheapest first, see [Deciding](design.md#deciding), item 8. Another part goes to 163 runs made with nothing else running, for mutants that fail a file's run without the test that failed having failed on them while trying them; Effect runs every test concurrently, and tests trying mutants there give fewer leads than elsewhere. unocss is fast because there is next to nothing to run: the tests of the package load it as built, and all but eleven of the mutants are covered by no test.

svelte took 941 s before any of this and takes 2,900 s to 3,500 s: its two big test files are among those whose runs fail each other, so they run one process at a time, and in the run of 2,879 s that is four rounds of 314 s to 510 s. Sixteen of its tests used to be left out as failing by chance, and thirteen mutants were reported as killed that the suite passes with; none is now.

solid takes more than twice what it took before the last of those rules (350 s): its tests cannot be run again in a worker, so tests trying mutants say little there, 203 mutants rest on runs of whole files alone, and each gets its run with nothing else running, 1.6 s apiece and one at a time. A project like that pays the full price of the rule. Counted on a later run: that last round is 443 s of 836, 270 runs one after another, of which 183 fail in a test that cannot be run again in a worker and 69 wait out a five-second time limit of Vitest in two files. Nowhere else is that round more than 31 s. The first of two ways to shorten it has since been built, the copy just before such a test described under [Deciding](design.md#deciding), item 8: 172 runs are left in that round, 53 of them with no mutant, and 272 s, and solid takes 755 s. What is left are tests that time out with mutants their file passes with when they try them in a worker, and are believed for nothing. The other way, letting the next run start while one only waits, with the processor time the waiting one used held against it afterwards, was not built.

solid and svelte are slow for the reason excalidraw is: one or two test files that take seconds, run whole for every mutant not caught early (solid: 222 runs of a file that takes 3 s instrumented).

In vue, 13 of the 14 mutants not judged fail the suite: code that only runs while a module loads is not run here ([Limits](limits.md)), and in a library that builds its tables at load that is about one mutant in thirty.

## Application targets

The projects above are libraries. These are applications, each with what its own CI does before the tests can run: a generated Prisma client, workspace packages built first, an environment file. One run each of both tools on the machine above, one after the other: umami, formbricks and actual with nothing else running on 29 October 2026 (the first of actual's two runs next to small runs on fixtures), Roo-Code that day next to the check of actual, immich `services` that day with nothing else running, immich `utils` on 21 October with other work keeping the machine busy (a load average of 18 to 23 on its 12 cores). The check against the suite is of every mutant reported as survived, and of a sample spread evenly over the rest.

| Target and scope | Mutants | This tool | StrykerJS | Against the suite |
|---|---|---|---|---|
| [umami](https://github.com/umami-software/umami) `lib`: `src/lib` (Vitest 4, jsdom, a Next.js application) | 5,833 | 378 s, the median of 377, 378 and 387 s | 414 s, the median of 409, 414 and 429 s | 1,367 checked, every survivor among them: all agree |
| [formbricks](https://github.com/formbricks/formbricks) `utils`: `apps/web/lib/utils` (Vitest 4, a Next.js application, an environment file) | 2,559 | 413 s, the median of 401, 413 and 444 s | 404 s, the median of 400, 404 and 420 s | 473 checked, every survivor among them: all agree |
| [actual](https://github.com/actualbudget/actual) `server`: `packages/loot-core/src/server/{budget,aql}` (Vitest 5, Yarn 4, an in-process sqlite database) | 5,892 | 1,846 s and 1,919 s | 2,973 s and 2,849 s | 240 checked: all agree; StrykerJS disagrees with the suite on 81 of them |
| [Roo-Code](https://github.com/RooCodeInc/Roo-Code) `utils`: `src/utils`, `src/shared` (Vitest 3.2, a VS Code extension) | 3,273 | 1,239 s, six workers | does not start | 200 checked: all agree |
| [immich](https://github.com/immich-app/immich) `utils`: `server/src/utils` (Vitest 5, a NestJS server, SWC) | 4,280 | 902 s | does not start: a test fails in its first run | 531 checked, every survivor among them: all agree |
| [immich](https://github.com/immich-app/immich) `services`: `server/src/services` | 10,244 | 1,855 s | does not start | 250 checked: all agree |

749 of umami's 1,293 survivors are strings and lists in `src/lib/constants.ts`, which nearly every test file imports. Each was run with every test file that loads the module, 48,028 whole-file runs and 4,901 s, until a mutant that only reading its binding can make anything of was run with only the files that read it ([Deciding](design.md#deciding)): 4,317 runs. StrykerJS runs only the tests that reach a mutant. Of the 20 mutants on which the two disagree between detected and not, StrykerJS has 14 survive that the suite fails with, in code that runs while a module loads, and kills 6 that the suite passes with.

formbricks is the one of these where the two take about as long, three runs of each in turn. It spends 125 s in the round that makes runs one at a time: 81 runs with a mutant whose failures next to other runs nothing else vouched for, 16 of them waiting out the 5-s limit of a test, and 44 with none. With `--led` it took 189 s, 2,003 mutants reported as led and every survivor as without the option; with `--confirm 4` 444 s, 21 survivors unconfirmed.

actual is where StrykerJS is furthest from the suite. Its setup file empties the database before the tests, which builds every view from the table schema in `aql/schema/index.ts`, so every test file reads that binding: each of its surviving mutants was run with the 86 test files that load it, two seconds a run made before the file loads, 20,881 runs and most of the time, until a re-export that esbuild writes as `export { schema2 as schema }` was no longer taken for a read: then 8,429. Two test files were then run one process at a time, `executors.test.ts` among them, and its 486 runs made that way, 1,503 s one after another, were a third of the 4,489 s the run took. Most of the files read the schema in their tests, through the setup file's `emptyDatabase`, and not while they load, so a run there is a copy made after the file loaded in which the schema is made again with the mutant on ([Deciding](design.md#deciding)): 13,481 of 14,631 runs, 1,846 s, every verdict as two runs before. StrykerJS switches a mutant on in a process where the schema was built already, and the switch changes nothing: of the 63 such mutants in the sample that it reports as survived, 43 fail the suite. Before that, two runs took 4,846 s and 7,649 s with every verdict the same but for six that a test which fails by chance moves between survived and unconfirmed; the second made each run a third slower with as many runs, which was not looked into further. In the last run a test of `main.test.ts` failed with no mutant on and was left out, and 160 mutants it reaches are unconfirmed where the runs before had them survived or, for one the suite fails with, killed. With `--led` it took 2,255 s: 3,499 mutants led that the run without it detects, one led that it has as survived, and the 160 survived, the test that fails by itself not having been met there.

Roo-Code ran with six workers next to another check, so its time is not one to compare.

In immich, 562 of the 4,280 mutants are in code that only runs while a module loads, the decorators and schemas of a NestJS server, and are not run ([Limits](limits.md)). StrykerJS stops after its first run, in which a test of the database backups fails that passes in the suite.

## Additional libraries and developer tools

These six targets add translation, parsing, date boundaries, lint pipelines and dictionary algorithms. Their commits, installation commands and source scopes are pinned in `bench/targets.ts`; each scope is also in the hosted benchmark workflow.

| Target and scope | Vitest | Sources mutated | Test configuration |
|---|---|---|---|
| [i18next](https://github.com/i18next/i18next) `translation` | 5.1.0 | `src/{Interpolator,PluralResolver,LanguageUtils}.js` | The `runtime` project: 49 files, 780 passing tests and 2 skipped |
| [yaml](https://github.com/eemeli/yaml) `lexer` | 4.1.11 | `src/parse/lexer.ts` | 24 files, 3,413 passing tests and 11 skipped, including the upstream YAML and JSON test corpora |
| [date-fns](https://github.com/date-fns/date-fns) `dates` | 5.0.1 | `src/{parseISO,parse,format}/index.ts` in `pkgs/core` | The `main` Node project: 253 files, 3,148 passing tests and 19 skipped; concurrent tests without file isolation |
| [Secretlint](https://github.com/secretlint/secretlint) `messages` | 4.1.12 | `src/messages/filter-{ignored-process,duplicated-process,mask-secrets}.ts` in `packages/@secretlint/core` | 6 files, 31 passing tests; rule results, ignored ranges, duplicate messages and masking |
| [CSpell](https://github.com/streetsidesoftware/cspell) `distance` | 4.1.12 | `src/lib/distance/{levenshtein,weightedMaps}.ts` in `packages/cspell-trie-lib` | 82 files, 1,536 passing tests; string distances and weighted character mappings |
| [commitlint](https://github.com/conventional-changelog/commitlint) `lint` | 5.1.0 | `@commitlint/lint/src/lint.ts` | 91 files, 1,299 passing tests; the project's own Vitest environment |

The unmutated suites above were run on macOS arm64 with Node 24.21.0 on 7 November 2026. These are runtime tests: commitlint's configured type check is disabled, as it is in the mutation runs. The browser and separate time-zone test projects of date-fns are outside this scope.

YAML's two test-data submodules are checked out at the commits recorded by its repository. Its existing setup file fixes fast-check's seed to `0`, so the mutation runs and ground truth get the same generated inputs. Date-fns runs with `TZ=UTC`, set in the config both tools load; its source and test expectations are unchanged.

The i18next checkout renames its build-only `.babelrc` to `.babelrc.build`: StrykerJS 10's JavaScript parser loads Babel 7 presets from it into Babel 8 and otherwise stops before making a mutant. Vitest does not use that build configuration.

Commitlint exposes its `@commitlint/config-angular` workspace package as a root development dependency. One of its tests resolves that undeclared dependency through `NODE_PATH` set by pnpm's executable wrapper; direct Vitest runs, including ground truth, need the workspace link as well.

StrykerJS runs date-fns and commitlint with `inPlace: true` in their disposable benchmark checkouts. Its sandbox rewriter calls `typescript.parseConfigFileTextToJson`, which TypeScript 7 no longer exposes. In-place mode skips that rewriting and restores the original source files after the run. CSpell's sandbox excludes the unused directory symlink `test-fixtures/issues/issue-5120/.config`, which Stryker tries to copy as a regular file; the selected suite's shared dictionary fixtures remain included.

The benchmark refuses to continue when Stryker leaves a `backup-*` directory under `.stryker-tmp`, before deleting any old sandbox and again after Stryker exits. Such a directory may hold the original sources after an interrupted in-place run. Restore or re-create that benchmark checkout before retrying; the backups are kept.

StrykerJS 10 gives no usable comparison on i18next and date-fns with these Vitest versions. It joins nested test names with spaces when making a mutant's test filter, while Vitest joins them with ` > `. Every covered survivor has `testsCompleted: 0`: 691 on i18next and 531 on date-fns. A three-mutant i18next run with `coverageAnalysis: all` and `ignoreStatic: false` still completed no tests for any mutant. Their times are not evidence of mutation-testing speed; their vitant verdicts are checked against source-written ground truth.

Seconds at [d3967ce](https://github.com/wadackel/vitant/commit/d3967ce78e10644cd55e4bbbdc2e4d9c93929946), from one completed run of each tool on the machine above, not medians or hosted-CI measurements:

| Target and scope | vitant mutants | StrykerJS | vitant |
|---|---|---|---|
| i18next `translation` | 704 | no usable verdicts | 44.8 |
| yaml `lexer` | 737 | 125.6 | 194.2 |
| date-fns `dates` | 530 | no usable verdicts | 7.0 |
| Secretlint `messages` | 99 | 2.8 | 1.4 |
| CSpell `distance` | 448 | 23.6 | 20.8 |
| commitlint `lint` | 198 | 6.7 | 2.7 |

The stored ground truth covers up to 200 mutants spread evenly over each report, every survivor, every uncovered or static mutant, and every disagreement with a usable Stryker report. All 435 survivors are included. Each mutant was written into the source and the related test files run with the same project selection and type checking disabled.

| Scope | Checked | Judged and agreed | Static, not judged |
|---|---|---|---|
| i18next `translation` | 315 | 311 | 4 |
| yaml `lexer` | 301 | 298 | 3 |
| date-fns `dates` | 237 | 235 | 2 |
| Secretlint `messages` | 99 | 99 | 0 |
| CSpell `distance` | 249 | 245 | 4 |
| commitlint `lint` | 198 | 198 | 0 |

There were no disagreements among the 1,386 judged mutants checked. The 17 detected-versus-survived disagreements with StrykerJS on YAML all fail the plain suite; StrykerJS reports them as survived. YAML is slower here despite that extra detection. The other three usable Stryker comparisons agree on detected versus survived for every mutant both tools ran. The fixture checks and the existing ufo and immer scopes also cover the runner corrections these targets exposed: replay after a skipped prerequisite breaks a suite hook, and preserving the Promise contract of a suppressed console RPC (see [Deciding](design.md#deciding) and [Making such a process cheap](design.md#making-such-a-process-cheap)).

Secretlint's workspace dependencies, CSpell's trie package and its dependencies, and commitlint's workspace packages are built before testing. CSpell runs from its repository root with the trie package's test files selected in a wrapper of the upstream config: a Stryker sandbox of the package alone loses the shared dictionaries two directories above it. The selected tests import the mutated implementations from source. Other packages that import built artifacts still see those artifacts: these scopes measure the selected source modules, not each tool's whole CLI. CSpell's suggestion search is outside the mutation scope, but its tests can reach the distance code and its elapsed-time cutoff remains part of the suite being measured. The tests in `cspell-lib` that rewrite a shared dictionary are outside the selected package.

```sh
node bench/setup.ts i18next
node bench/run.ts i18next translation
node bench/setup.ts yaml
node bench/run.ts yaml lexer
node bench/setup.ts date-fns
node bench/run.ts date-fns dates
node bench/setup.ts secretlint
node bench/run.ts secretlint messages
node bench/setup.ts cspell
node bench/run.ts cspell distance
node bench/setup.ts commitlint
node bench/run.ts commitlint lint
```

## On hosted CI runners

### Corrected Linux measurements

StrykerJS 10 and vitant at [6c535f1](https://github.com/wadackel/vitant/commit/6c535f1842b7fcc4dbf3dce52e661296b7e6da83), measured sequentially on the same four-core Ubuntu 24.04 runner in each pair, with Node 24.22.2 and pinned target commits. Seconds are medians; speed ratios are medians of within-job ratios, so they need not equal the ratio of the displayed seconds. A ratio above one favors vitant.

The final core comparison was measured on 8 November 2026 in the [initial cohort](https://github.com/wadackel/vitant/actions/runs/42508644063), [control repeats](https://github.com/wadackel/vitant/actions/runs/42510975871), [YAML/XState repeat](https://github.com/wadackel/vitant/actions/runs/42513011947), and [Immer repeat](https://github.com/wadackel/vitant/actions/runs/42517154492). There are 60 complete START/vitant pairs across 11 scopes, with `runs=1`, `records=true`, unchanged dependencies and default complete mutation testing. START is [4909b59](https://github.com/wadackel/vitant/commit/4909b596203bd72cd6db587bf28db216e86c8793). Every job records its source SHAs, CPU model, reports and worker records.

| Target and scope | Usable Stryker pairs / vitant runs | StrykerJS s | vitant s | Median paired Stryker / vitant |
|---|---:|---:|---:|---:|
| yaml `lexer` | 6 / 6 | 719.6 | 599.0 | 1.203 |
| ufo `all` | 6 / 6 | 81.3 | 29.1 | 2.730 |
| immer `all` | 6 / 6 | 520.3 | 293.0 | 1.764 |
| es-toolkit `array` | 6 / 6 | 264.0 | 130.3 | 1.973 |
| es-toolkit `pr` | 5 / 6 | 39.6 | 48.9 | 0.806 |
| xstate `core` | 6 / 6 | 641.1 | 443.3 | 1.482 |
| i18next `translation` | 0 / 6 | not comparable | 89.3 | — |
| date-fns `dates` | 0 / 6 | not comparable | 26.2 | — |
| Secretlint `messages` | 3 / 3 | 7.8 | 2.8 | 2.833 |
| CSpell `distance` | 3 / 3 | 125.6 | 75.5 | 1.599 |
| commitlint `lint` | 6 / 6 | 28.8 | 5.9 | 5.155 |

When Stryker is usable, both time columns use those same pairs. Otherwise the vitant column uses all completed vitant runs. Stryker selects zero tests for covered survivors on i18next and date-fns. One es-toolkit `pr` Stryker run failed during a Vite cache rename; its duration is excluded, leaving five usable comparisons and six complete vitant runs. vitant remains slower on that changed-lines scope.

The table above is also in the README. Older measurements below retain their own source versions, operating systems and conditions.

#### Comparison with the starting implementation

| Target and scope | Pairs | START s | vitant s | Median paired START / vitant | vitant wins |
|---|---:|---:|---:|---:|---:|
| yaml `lexer` | 6 | 605.1 | 599.0 | 1.010 | 5 / 6 |
| ufo `all` | 6 | 28.6 | 29.1 | 0.972 | 0 / 6 |
| immer `all` | 6 | 282.0 | 293.0 | 0.959 | 0 / 6 |
| es-toolkit `array` | 6 | 131.5 | 130.3 | 1.009 | 4 / 6 |
| es-toolkit `pr` | 6 | 48.7 | 49.3 | 0.994 | 1 / 6 |
| xstate `core` | 6 | 410.6 | 443.3 | 0.952 | 0 / 6 |
| i18next `translation` | 6 | 83.2 | 89.3 | 0.927 | 0 / 6 |
| date-fns `dates` | 6 | 25.4 | 26.2 | 0.966 | 0 / 6 |
| Secretlint `messages` | 3 | 2.9 | 2.8 | 1.036 | 2 / 3 |
| CSpell `distance` | 3 | 76.7 | 75.5 | 1.016 | 2 / 3 |
| commitlint `lint` | 6 | 5.8 | 5.9 | 0.985 | 0 / 6 |

The practical threshold was fixed at 1.15 after same-commit controls showed symmetric timing variation up to 1.1224. Acceptance requires a median paired ratio above 1.15 and five wins in six pairs, or eight in the one permitted extension to nine. Controls with two slower initial observations are repeated under the same rule with ratios inverted. The smaller consistent slowdowns in this table remain reported: i18next's median adverse ratio is 1.079, XState's 1.050 and Immer's 1.043. No control demonstrates a regression beyond 1.15; this is not a claim that no slowdown exists.

YAML's final START/vitant ratios are 1.189216, 1.005897, 1.005264, 0.881818, 1.015082 and 1.018287: median 1.010490 with five wins. A practical gain over START is not demonstrated. Its Stryker/vitant ratios are 1.319636, 1.211827, 1.156111, 1.181431, 1.247924 and 1.194658: median 1.203242 with six wins, meeting the declared criterion. START already beats Stryker in all six of these jobs, with median Stryker/START ratio 1.188963, so the full Stryker advantage cannot be attributed to this investigation.

The retained bounded alternative-witness search was also measured in isolation, with all correctness repairs on both sides. Against [the corrected control without that search](https://github.com/wadackel/vitant/commit/f08834c6eee9421e68f66c75d1c8a0154ff06095), nine YAML pairs have median control/vitant ratio 1.164625, range 0.885950–1.265082 and eight wins. The [first](https://github.com/wadackel/vitant/actions/runs/42530711432), [second](https://github.com/wadackel/vitant/actions/runs/42533399687) and [final](https://github.com/wadackel/vitant/actions/runs/42536497085) cohorts retain all observations. Quiet confirmations decrease in eight pairs, but trial CPU increases in seven. Median paired control/vitant ratios are 1.003479 for whole-file counts, 0.956931 for trial CPU and 1.039029 for summed whole-file time. Summed process durations are distinct from elapsed time; no phase duration is subtracted to estimate a speedup.

#### Verdict evidence

All judged entries in the stored truth agree in the current core reports. That is sampled and survivor-focused source-written truth, not exhaustive source execution for every generated mutant. Raw Killed/Timeout differences remain distinct and were checked against identity-specific source failures, native test deadlines, worker errors or corrections to old tool-generated loop classifications. An external process cap alone proves neither a failed test nor nontermination.

YAML has 840 Stryker mutants, 737 vitant mutants and 729 matched identities in each final pair. The same 17 mutants survive Stryker but are detected by vitant and fail the source-written suite. Stryker also times out 3–14 matched mutants per pair that pass the source-written suite and survive vitant. All detected/undetected disagreements in these pairs agree with vitant under the stored truth; this does not establish source truth for all 737 mutants.

The [standard validation](https://github.com/wadackel/vitant/actions/runs/42508450872) at the measured implementation passed all 35 jobs and 25 result manifests, including Linux truth and required non-Linux lanes. Full local truth also agrees: 272 judged basic mutants in default mode with 29 Static entries unjudged, all 301 with `--static`, and the stuck, clash and walk fixtures. The packed tool matches all 301 source mutants. [The actual YAML regression](https://github.com/wadackel/vitant/actions/runs/42508589857) confirms that an injected loop interruption retains Timeout rather than becoming an ordinary Killed verdict.

#### Application comparisons

The same implementation is also checked on Umami, Formbricks, Actual and both Immich scopes. Stryker's covered survivors with zero completed tests make its Umami and Immich results incomparable: two such survivors on Umami, 2,366 on Immich utils and 7,186 on services in each measured report. Actual has no usable paired Stryker comparison; a [Linux adapter reproduction](https://github.com/wadackel/vitant/actions/runs/42420417140) confirms that the pinned Stryker/Vitest combination cannot reuse its nested test identifiers. Its comparison runs START and vitant over the unchanged full server scope.

| Target and scope | Valid START pairs / incomplete START runs | START s | vitant s | Median paired START / vitant | vitant wins | Median paired Stryker / vitant |
|---|---:|---:|---:|---:|---:|---:|
| Umami `lib` | 3 / 0 | 909.3 | 894.7 | 1.016 | 2 / 3 | not comparable |
| Formbricks `utils` | 6 / 6 | 1,221.6 | 1,231.8 | 0.991 | 3 / 6 | 1.609 (11 / 12 wins) |
| Actual `server` | 3 / 2 | 10,477.9 | 10,424.8 | 1.005 | 2 / 3 | not comparable |
| Immich `utils` | 6 / 0 | 2,111.5 | 2,073.6 | 1.018 | 5 / 6 | not comparable |
| Immich `services` | 6 / 0 | 2,675.4 | 2,699.9 | 0.997 | 3 / 6 | not comparable |

Seconds are medians over the valid START pairs. An incomplete START run left mutants Pending after abandoning test files; the candidate completed every mutant in all 32 of its application runs, and its partial-duration baselines are excluded from the ratios. No scope shows a material regression, and none reaches the 1.15 threshold for a gain. The Formbricks Stryker ratio uses all twelve completed candidate runs, including the slow one below. The cohorts are the [initial applications](https://github.com/wadackel/vitant/actions/runs/42508652860), [Actual](https://github.com/wadackel/vitant/actions/runs/42508599983) with its [replacements](https://github.com/wadackel/vitant/actions/runs/42543636681), the [Immich repeat](https://github.com/wadackel/vitant/actions/runs/42529033753), the [Formbricks repeat](https://github.com/wadackel/vitant/actions/runs/42543626696) and its [replacements](https://github.com/wadackel/vitant/actions/runs/42559824759). Every candidate report agrees with every stored truth entry of its scope: 1,367 on Umami, 473 on Formbricks, 240 on Actual, 531 on Immich utils and 250 on services.

Formbricks used an external per-vitant-process cap of 300 minutes for the initial cohort and replacements 1–4, and 150 minutes for the control repeat and its two replacements. Every recorded process ended before the smaller cap, including failed START attempts; the longest candidate took 4,291.6 seconds. This cap did not change Vitest test, hook or mutant limits.

Formbricks has a retained slow observation: [one candidate run](https://github.com/wadackel/vitant/actions/runs/42543626696/job/128923840566) took 4,291.6 seconds against Stryker's 2,176.2 seconds. START left 914 Pending in that job, so its partial duration is excluded from START ratios. The candidate completed all 2,559 mutants. Two requested coverage measurements for the Cube client file finished without clean test-level observations, leaving its coverage uncertain. This triggers conservative whole-file checks, including checks of otherwise skipped static mutants. Conflicting whole-file outcomes later trigger exclusive reruns. The Cube file alone accounts for 1,117 whole-file runs; the late rounds contain 495 such checks and span 1,894.6 seconds of wall time. The records do not establish physical interference between processes, and the first rejected baseline error text was not retained.

That run checks all 65 identities previously reported Static and detects 30 of them. Their mutation identities, static flags and zero test-level coverage are unchanged. [Thirty source-written checks on Linux](https://github.com/wadackel/vitant/actions/runs/42559023159) confirm every new Killed judgment: the original full files pass, the literal mutants fail at the expected test IDs, and all recorded source/test/configuration hashes restore. A previous Static label is an unjudged result, not evidence that the mutant passes. The slow observation and all raw label changes remain included.

### Additional scopes, 7 November 2026

[Run 42335023200](https://github.com/wadackel/vitant/actions/runs/42335023200) measured the six additions at [d3967ce](https://github.com/wadackel/vitant/commit/d3967ce78e10644cd55e4bbbdc2e4d9c93929946). The workflow used `tools=stryker,vitant`, `runs=1`, `jobs=3` and `only=i18next yaml date-fns secretlint cspell commitlint`: three independent jobs per scope and OS, with StrykerJS and vitant run sequentially on the same machine in each job. All used Node 24.22.2. Linux was x64 with four cores; macOS was arm64 with three cores on an Apple M1 (Virtual).

All 36 benchmark jobs succeeded and all 36 vitant reports passed the stored ground-truth check. No mutant changed status between the repeats or operating systems when Killed and Timeout were treated as one detected status. Every report had zero Pending and Unconfirmed mutants and used worker copies. This checks 1,399 stored entries per full set of six scopes, including all survivors; Static entries remain unjudged in the default mode.

Seconds, the median of the three runs for each tool and OS:

| Target and scope | Linux: StrykerJS | vitant | macOS: StrykerJS | vitant |
|---|---|---|---|---|
| i18next `translation` | not comparable | 84.4 | not comparable | 119.6 |
| yaml `lexer` | 727.3 | 649.2 | 714.3 | 681.0 |
| date-fns `dates` | not comparable | 18.0 | not comparable | 24.4 |
| Secretlint `messages` | 10.4 | 3.7 | 8.5 | 4.6 |
| CSpell `distance` | 138.1 | 92.6 | 133.5 | 113.5 |
| commitlint `lint` | 26.6 | 5.9 | 26.3 | 7.6 |

StrykerJS completed no tests for its covered survivors on i18next and date-fns on either OS, as in the local runs above; those timings are not comparable. Secretlint, CSpell and commitlint were faster with vitant in every pair. YAML varied: the lower median times do not mean it was faster in every run. Its three Linux pairs, StrykerJS / vitant, were 524.0 / 542.7, 727.3 / 649.2 and 796.7 / 929.8 seconds; on macOS they were 714.3 / 681.0, 948.7 / 808.1 and 540.8 / 649.2 seconds.

Linux jobs were assigned EPYC 7763, 9V45 and 9V74 processors and Xeon 8370C and 8573C processors. Each pair shares one machine, but the three pairs need not share a model. The macOS model was the same throughout, yet times still varied: CSpell took 101.0–190.5 seconds with StrykerJS and 84.8–114.3 with vitant. The run's 36 artifacts retain each machine description, timing, report and worker record; these measurements are separate from the earlier cohorts below.

### Earlier library scopes, 3 and 4 November 2026

`.github/workflows/bench.yml` runs the same scopes on GitHub's Linux (x64, 4 cores) and macOS (arm64, 3 cores) runners, and these are the times that are kept up to date. In seconds, the median of three runs, from runs of 3 and 4 November 2026; every report of this tool agreed with the stored ground truth on both. StrykerJS and this tool ran one after the other in one job, so a row has one processor for both: on Linux an EPYC 9V45 for ufo and immer, a 9V74 for es-toolkit `array`, jotai and xstate, a 7763 for query and valibot, a Xeon 8573C for zustand and an 8370C for es-toolkit `pr`. The macOS runners are of one model.

| Target and scope | Linux: StrykerJS | This tool | macOS: StrykerJS | This tool |
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

On Linux that is 6.0 times as fast on valibot, 5.3 on zustand, 4.4 on query, 4.2 on jotai, 2.4 on es-toolkit `array`, 2.3 on ufo, 1.9 on immer and 1.6 on xstate; on macOS 6.4, 5.1, 3.9, 3.8, 1.9, 1.4, 1.8 and 1.3. On the few changed lines of es-toolkit `pr` StrykerJS is the faster: this tool takes a quarter longer on Linux, half as long again on macOS.

On 13 October this tool had taken 17.7 and 20.4 s on ufo, 89.5 and 100.1 s on `array`, 30.3 and 24.8 s on `pr`, 460.3 and 369.5 s on jotai and 237.9 and 205.5 s on valibot. Run in one job with that version, the version of these runs takes ufo from 17.5 to 36.5 s on macOS and `pr` from 20.6 to 37.3 s, with every verdict the same. Nearly all of it is runs that stop a test: a loop past its count now runs until the test's own limit has passed on the clock and in the processor's time, and a test that waits for good until Vitest's limit ends it, where the second of before also called a timeout a loop or a wait that ends in two seconds and passes the suite (see [Limits](limits.md), a timeout is a judgement). es-toolkit's `pr` has one such mutant: its run took 1.1 s, twice, and takes 10.1 s. What was looked at to cut that without a wrong verdict is in the [decisions](decisions.md).

The application targets, in runs of 31 October 2026 with the copies made while a file loads and the timers it set put off for copies made once it has (see [Making such a process cheap](design.md#making-such-a-process-cheap)); actual and Roo-Code are of the version before the timers. These take hours, and StrykerJS and this tool ran in jobs of their own, so a row is two machines and the processor of each Linux job is named: an EPYC 7763 took StrykerJS 7,250 s on immich `services` where a 9V45 had taken it 3,953 s a day before. One run each unless more are shown; every report of this tool agreed with the stored ground truth on every mutant it judged.

| Target and scope | Linux: StrykerJS | This tool | macOS: StrykerJS | This tool |
|---|---|---|---|---|
| umami `lib` | 2,876.7 (7763) | 706.5 (9V45) | 2,374.9 | 1,352.9 |
| formbricks `utils` | 1,681.2 (9V74) | 1,307.0, 1,224.9, 1,236.1 (7763) | 2,017.0 | 1,412.6, 1,304.5, 1,499.7 |
| immich `utils` | 4,349.3 (9V74) | 3,187.6 (7763) | 5,912.7 | 3,526.4 |
| immich `services` | 7,250.2 (7763) | 3,545.0 (9V74) | 6,574.8 | 4,740.0 |
| actual `server` | 13,887.3 (9V45) | 7,528.6 (9V74) | 18,884.8 | 7,611.2 |
| Roo-Code `utils` | does not start | 892.1 (9V45) | does not start | 2,110.0 |

On macOS that is 1.8 times as fast on umami, 1.4 on formbricks, 1.7 on immich `utils`, 1.4 on `services` and 2.5 on actual. On Linux no row had both tools on one processor; every time of this tool is below StrykerJS's. immich `services` on Linux took 9,076 s on a 9V74 before the timers were put off: `detect-libc` leaves a request to Node's thread pool under way while those test files load, no copy is made while they do, and `exiftool-vendored`'s timer kept every copy from being made once they had. formbricks on Linux had given up on `proxy.test.ts` in two runs out of four, after three rounds in which no process said a word of the file, with every mutant it reaches reported as pending; such a file's runs now go to workers started for them, which happened twice in the three runs above, and each of the three ran to its end. That did not settle it: [4909b59](https://github.com/wadackel/vitant/commit/4909b596203bd72cd6db587bf28db216e86c8793) still gave up on the file in six of twelve later runs, and [6c535f1](https://github.com/wadackel/vitant/commit/6c535f1842b7fcc4dbf3dce52e661296b7e6da83) completed it in all twelve; see [Application comparisons](#application-comparisons).

Where the scopes short of twice StrykerJS's speed spend their time, from the records of these runs (`bench/run.ts --records`, read with `bench/spent.ts`) and of runs on this Mac with three workers:

- ufo and es-toolkit `array`: runs that wait out Vitest's 5 s test limit, a loop of a mutant that does not end. They are 65 of ufo's 117 worker-seconds on a macOS runner and 254 of es-toolkit's 329 on this Mac, and a timeout has to take 5 s of the processor as well as of the clock, so its eleven and fifty-four take 18 s and 90 s of three cores at the least. The runs are packed with a gap of under four worker-seconds.
- immer: a mutant that loops while a file loads waits out the 10 s hook limit (`produce.ts`, 10.1 s for one load), and a failure that a run next to others made is confirmed by one made with nothing else running, 146 runs and 12 s on this Mac.
- xstate: what the verdicts need at the least, the runs that pass for the survivors, the timeouts at 5 s each, one failing run for each detection and the first round, comes to about 300 s on a macOS runner, against the 340 s that twice StrykerJS's speed would take; starting workers, loading files and the end of each round add the rest.
- immich: the runs in copies spend a fifth of their time in the system, on the pages of the worker each copy writes to (`faults` on a copy's record), and they are under half of the run's worker time; see [decisions](decisions.md). Of thirteen runs of `services` on macOS runners, twelve took 2,869 s to 4,099 s and one 1,731 s; StrykerJS took 5,140 s to 6,087 s in the same jobs.
- es-toolkit `pr`: one mutant loops while a file loads and waits out the 10 s hook limit, which with the start and the first round puts the run past the 15 s that twice StrykerJS's speed would take.

The scopes StrykerJS does not start on, gives no usable verdicts for or was not run on, this tool alone:

| Target and scope | Linux | macOS |
|---|---|---|
| vue `pr`: lines the pinned commit changed | 39.8 | 39.1 |
| pacer `timing` | 46.1 | 43.1 |
| pinia `pinia` | 71.1 | 69.7 |
| hono `router` | 211.0 | 199.8 |
| shiki `transformers` | 203.8 | 372.7 |
| hono `utils` | 423.9 | 412.2 |
| vue `reactivity` | 574.0 | 422.6 |
| excalidraw `pr` | 870.8 | 1,767.6 |
| solid `reactive` | 1,097.1 | 1,171.1 |
| h3 `utils` | 1,184.7 | 1,336.4 |
| Effect `data` | 2,305.3 | 2,270.2 |

In the last of its three runs, hono `router` on Linux had 21 mutants reported as unconfirmed and h3 `utils` on macOS 13, none of them wrong: a test was found to fail by chance in that run, hono's check of the time it logged and h3's body over the limit sent to a port, and a mutant such a test reaches is not called survived on the strength of the rest ([Limits](limits.md), tests that fail now and then).

The time of shiki on macOS is of three later runs the same day, made with the rule for a worker stopped in a test's first try ([How it works](design.md#finding-where-each-mutant-is-likely-to-be-detected), 7): 11 rounds, where the three before it took 32 and 500.0 s. Those later runs on Linux were given a slower processor than the first three, an EPYC 7763 for an EPYC 9V45, and took 389.8 s in the 11 rounds the first three had taken as well; their first round, which has no mutant in it, took 10.7 s for 6.6 s.

An earlier run, of 6 October 2026 and one run each, also had this tool starting a worker for every whole-file run:

| Target and scope | Linux: StrykerJS | This tool | Without copies | macOS: StrykerJS | This tool | Without copies |
|---|---|---|---|---|---|---|
| ufo `all` | 85.6 | 24.6 | 110.2 | 78.7 | 28.2 | 78.1 |
| zustand `all` | 196.2 | 54.2 | 196.6 | 192.0 | 48.1 | 203.8 |
| es-toolkit `array` | 221.5 | 101.3 | 118.5 | 261.5 | 166.8 | 185.2 |
| immer `all` | 505.2 | 331.9 | 532.3 | 467.2 | 335.1 | 599.8 |
| jotai `vanilla` | 1,954.6 | 447.8 | 1,416.1 | 1,853.5 | 469.4 | 1,287.0 |
| query `core` | 1,097.0 | 276.0 | 858.8 | 1,426.7 | 376.2 | 1,138.2 |
| pinia `pinia` | failed to start | 72.3 | 348.1 | failed to start | 107.0 | 489.7 |
| hono `router` | see above | 136.6 | 240.1 | see above | 254.2 | 339.1 |
| hono `utils` | see above | 310.3 | 451.2 | see above | 376.2 | 547.0 |
| excalidraw `pr` | failed | 1,466.9 | 1,415.0 | failed | 1,967.3 | 1,770.7 |

Copies pay on Linux as they do on macOS, except where the tests are heavy: in excalidraw `pr`, 20 surviving mutants are each run with about 45 test files that take seconds apiece, the start of a worker is a small part of that, and workers that are to be copied run V8 on one thread, which before Vitest 4 holds for the whole run. There the tool is a little slower with copies than without.

The first run of this workflow, with a third more workers than cores, reported one or two mutants of hono as killed that the suite passes with: tests that wait on the clock failed twice in a row on the overloaded runner. See [Limits](limits.md), tests that fail now and then.

## Checking the verdicts

`bench/truth.ts` writes each mutant of a report into the source, in parentheses where it stands for an expression and only where that parses to the same tree around it, runs Vitest, and compares. Inside an optional chain that goes on past the mutant it writes the text bare: `(a?.b.c)()` calls undefined where `a?.b.c()` stops at `a`, and one survivor of umami was taken for failing the suite until that was seen. Of the 190 entries stored before then that lie inside such a chain, none came out otherwise written bare. A mutant counts as agreeing when the suite fails or hangs and the report says Killed or Timeout, or the suite passes and the report says anything else. Three things are checked with it:

- **The fixture projects, on every platform in full CI.** `pnpm test:truth` runs the suites with each eligible mutant written into the source: basic in default and static modes, then stuck, clash and walk. Full CI runs on all seven environments for platform-sensitive or unclassified changes and on scheduled/manual full runs; standard CI uses the two representative environments for these detailed checks (see [Development workflow](development.md)). The first time the check ran it found two defects no assertion had been written for: mutants in code that only cleanup hooks reach were reported as not covered, and a mutant that ended the process left every mutant of its test file pending. Two reviews then named traps the fixture did not have, and the check confirmed six of them as defects, each now a fixture: code only `afterAll` or the teardown of a shared fixture reaches (reported as static), tests with `retry` or `repeats` and tests that skip themselves (not covered), a loop that a mutant makes long but not endless (timeout), a loop in `beforeAll` counted against the tests' share (timeout), and a file that never finishes loading with a mutant, where the tool itself did not end.
- **The benchmark scopes, in CI.** `bench/truth/` holds what the suites gave for 16,663 mutants of 22 scopes, and `bench/run.ts` fails when a report disagrees with it; `.github/workflows/bench.yml` runs that on Linux and macOS runners. The entries were made on macOS with the test files that reach each mutant; the ten that the first version of the check had written without parentheses, and so wrongly, were made again. One entry carries a note: the miss in hono described under [Limits](limits.md). pinia's own suite does not pass at the pinned commit, so seven of its entries that could not be made again were dropped. A run in which nothing failed but tests that fail with no mutant too counts as passing only if Vitest also had no error that nothing handled: it ends with an error for those while every test passes, its JSON report does not list them, and a reporter of the check's own asks for them. One mutant of solid, rightly reported as killed, was first taken for passing without that.
- **Mutants reported as not covered,** which the earlier checks had left out: the suite passes with each of the 121 in ufo, zustand and immer.

## How the verdicts hold up

Against ground truth, counting a mutant as agreeing when both sides detect it or neither does:

| Target and scope | Checked | Agree | The rest |
|---|---|---|---|
| es-toolkit `array` | all 706 judged | 706 | |
| immer `all` | all 1,437 judged | 1,436 | 1 where the check itself was wrong: the mutant text went in without parentheses and regrouped the operators around it. Put in by hand, the suite passes, as reported |
| jotai `vanilla` | all 1,088 judged | 1,086 | 1 where the parentheses turned the line before into a call; 1 where the suite failed without a failing test and was not looked into |
| excalidraw `math` | the 215 survivors | 212 | 3 `&&`/`||` mutants inside longer chains, taken to be the regrouping above and not re-run |
| zustand `all` | all 532 judged | 531 | 1 regrouping again; put in by hand, the suite fails, as reported |
| hono `utils` | the 416 survived or timed out | 415 | 1 real miss: a test builds the source file with esbuild and checks the output (see [Limits](limits.md)) |
| hono `router` | 840 of the 1,066 judged | 840 | The check was stopped before it finished |
| ufo `all` | all 850 judged | 850 | |
| pinia `pinia` | all 611 judged | 604 | 5 regroupings, confirmed by hand to pass as reported; 2 that fail only the type tests Vitest runs for this project, which this tool does not run |
| query `core` | the 523 survived or timed out | 518 | 5 regroupings, confirmed by hand |
| vue `reactivity` | the 182 survivors | 181 | 1 real miss, since closed: the mutant was never run with the file that fails on it ([Deciding](design.md#deciding), item 8). The 400 entries kept for CI did not have it; the survivors are among them now |

What the same check found before each of the steps under [Deciding](design.md#deciding) existed:

- Survivors judged inside workers: 39 of immer's 269 and 4 of es-toolkit's 44 were wrong, none of excalidraw's 215.
- Kills judged inside workers: 3 of pinia's 460 were wrong, none of about 3,900 in immer, es-toolkit, jotai, zustand and hono.
- Errors nothing handles: 6 of query's mutants and none elsewhere pass every test and fail the run.
- Which files a mutant has to pass, read from a test's run in a worker that mutants had been tried in: 1 of vue's 182 survivors was wrong, in a run on three cores and in one on twelve; a second run of the same code had it right. For 433 of vue's 3,751 tests that was the only run there was.

Against StrykerJS, among mutants both tools ran:

| Target and scope | Same verdict | StrykerJS detected, here survived | Here detected, StrykerJS survived |
|---|---|---|---|
| excalidraw `math` | 1,295 | 44 | 0 |
| excalidraw `pr` | 96 | 0 | 0 |
| es-toolkit `array` | 704 | 0 | 0 |
| immer `all` | 1,402 | 2 | 25 |
| jotai `vanilla` | 850 | 39 | 183 |

Ground truth sides with this tool in every case that was checked. StrykerJS turns the mutant on in an environment it reuses and runs only the tests that reach the mutant, so it misses what tests detect without reaching it, as in immer, where 24 of the 39 survivors that turned out wrong were survivors for StrykerJS too. Of excalidraw's 44, 42 are kills by tests in `transform.test.ts` and `contextmenu.test.tsx` that compare snapshots depending on what earlier tests in the file did; StrykerJS runs each alone, where they fail with no mutant at all:

```sh
npx vitest run packages/element/src/__tests__/transform.test.ts -t "should transform the elements correctly when linear elements have single point"
```

Whether a detected mutant is called Killed or Timeout can differ between runs: a mutant that makes one test fail and another loop gets the verdict of whichever test reached it first. Both count as detected, and the report names what stopped each timed-out run (`timeoutCause`).
