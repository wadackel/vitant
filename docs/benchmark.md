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

## Targets added in November 2026

Each adds a shape the targets above do not have. Their commits, installation commands and scopes are pinned in `bench/targets.ts`, and each scope is in the hosted benchmark workflow.

| Target and scope | Vitest | Tests | Sources mutated |
|---|---|---|---|
| [koel](https://github.com/koel/koel) `composables` | 5.0.5, through Vite+ | jsdom, 407 files of a Vue application in a `vmThreads` pool with a memory limit; the composables are reached by 390 files, components among them | `resources/assets/js/composables/*.ts` |
| [homepage](https://github.com/gethomepage/homepage) `utils` | 4.1.10 | node, 574 files in a `threads` pool, JavaScript and JSX; tests replace `process.env` and reset modules before importing them again | `src/utils/{proxy,kubernetes,docker}/**/*.js` and `src/utils/contexts/*.jsx` |
| [tailwindcss](https://github.com/tailwindlabs/tailwindcss) `parsers` | 4.1.10 | node, 45 files in `packages/tailwindcss`, 1,151 inline snapshots among some 5,400 tests, a native CSS parser (lightningcss) | `src/{attribute-selector-parser,selector-parser,value-parser}.ts` |
| [sentry-javascript](https://github.com/getsentry/sentry-javascript) `packages/core`, scope `utils` | 4.1.12 | node, 166 files; state shared through `globalThis`, wrapped globals, a transform plugin of the project's that runs first, coverage turned on by the shared config | the 25 modules of `src/utils` that four or fewer of the package's sources import |
| [lobehub](https://github.com/lobehub/lobehub) `packages/database`, scope `topic` | 5.0.0 | happy-dom and node, 582 files; each file restores a PGlite (Postgres in WebAssembly) database from a snapshot that a global setup writes and names through the environment; 37 files reach the scope | `src/models/topic/**` and `src/repositories/topic*/**` |
| [Shopify CLI](https://github.com/Shopify/cli) `packages/cli-kit`, scope `node` | 4.1.10 | node, 181 files in a `threads` pool, with real temporary directories and `git`; 14 files reach the scope | nine modules of `src/public/node` that one or two others import; not `archiver.ts`, a mutant of which makes a test remove the temp directory itself ([Limits](limits.md)) |
| [promptfoo](https://github.com/promptfoo/promptfoo) `assertions` | 5.1.0 | node, 1,107 files in a `forks` pool, in an order shuffled with no fixed seed; 157 files reach the scope | the scoring modules of `src/assertions` (`bleu`, `gleu`, `rouge`, `ngrams`, `levenshtein`, `meteor`, `toolCallF1`, `trajectory`) |
| [ComfyUI_frontend](https://github.com/Comfy-Org/ComfyUI_frontend) `stores` | 5.0.5 | happy-dom and node, 2,550 files in three inline projects, with test tags under `strictTags`, a setup that stops real network requests, two retries of a failing test under `CI`; 106 files reach the scope | the 13 modules of `src/stores` that the fewest test files reach |
| [freelens](https://github.com/freelensapp/freelens) `utils`, project `@freelensapp/core` | 5.0.5 | jsdom, 402 files in a `threads` pool, in projects the config makes as it loads, through a plugin of the project's for standard decorators, with snapshots; 327 files reach the scope | the modules of `src/common/utils` that are not injectables or their registration |
| [n8n](https://github.com/n8n-io/n8n) `packages/workflow`, scope `proxy`, projects `default` and `vm-engine` | 5.0.1 | node, 164 files in four inline projects, the 21 entries of one list of the tests that evaluate expressions run once for each of three engines, among them a native isolate (isolated-vm) and QuickJS in WebAssembly; 106 files in the two projects run, 36 reach the scope | `src/workflow-data-proxy*.ts` |
| [headlamp](https://github.com/kubernetes-sigs/headlamp) `frontend`, scope `api` | 4.1.12 | jsdom, 314 files of a React application, one of which renders the Storybook stories of its 259 story files through `import.meta.glob`, its API client tested against a WebSocket mock server, msw and nock; 179 files reach the scope | the `.ts` modules of `src/lib/k8s/api/v2` but `useKubeObjectList.ts` |
| [zod](https://github.com/colinhacks/zod), scope `core`, config `vitest.compile.config.ts` | 4.1.5 | node, the package's 197 files with its parsers compiled to code through `new Function` before they run, a setup file that makes every call to `console` throw; 130 files reach the scope | `packages/zod/src/v4/core/{compile,checks,util}.ts` |
| [vercel/ai](https://github.com/vercel/ai) `packages/ai`, scope `node`, config `vitest.node.config.js` | 4.1.11 | node, 207 files with 993 snapshots, a type check of 40 `*.test-d.ts` files turned on; 167 files reach the scope | `src/{util,prompt}/**`, not the type tests |
| vercel/ai `packages/ai`, target `vercel-ai-edge`, scope `edge`, config `vitest.edge.config.js` | 4.1.11 | the same tests in the edge runtime (`@edge-runtime/vm`), but for `*.node.test.ts`: 203 files, 164 of which reach the scope | the same |
| [SvelteKit](https://github.com/sveltejs/kit) `packages/kit`, scope `server`, config `vitest.kit.config.js` | 5.0.1 | node and jsdom, 78 files of JavaScript typed through JSDoc in two inline projects, one of them in `forks` with `--expose-gc`; tests that generate types and run `tsc` on them, and one that runs a module in a worker thread of its own; 53 files reach the scope | `src/utils/*.js` and the modules of `src/runtime/server` that the package's tests reach |
| [renovate](https://github.com/renovatebot/renovate), scope `util` | 4.1.12 | node, spec files next to the sources, with nock, memfs and a native regular expression engine (re2), coverage turned on by the config; 407 files reach the scope | ten modules of `lib/util` whose related tests run in 75 s or less, 472 mutants; `lib/modules/manager/helmv3` left out, its related tests taking about 70 s a run for each of its 365 mutants |
| [lint-staged](https://github.com/lint-staged/lint-staged) `lib`, projects `unit` and `integration` | 5.0.5 | node, 73 files of plain ESM JavaScript; the integration tests run real git in temporary repositories and start the project's formatter by its name; coverage held to 100% by the config | `lib/*.js` |
| [happy-dom](https://github.com/capricorn86/happy-dom) `packages/happy-dom`, scope `selectors` | 4.1.8 | node, 304 files, each test held to 500 ms, Node's `child_process`, `http` and `https` mocked from the setup file; 276 files reach the scope | `src/query-selector/*.ts` and `src/dom/DOMTokenList.ts` |
| [mikro-orm](https://github.com/mikro-orm/mikro-orm), scope `core`, config `vitest.sqlite.config.ts` | 5.1.0 | node, the 107 `*.sqlite.test.ts` files of 1,585, against SQLite through better-sqlite3, in two inline projects, legacy decorators through oxc and standard ones through SWC, with `isolate: false` | six modules of `packages/core/src/{unit-of-work,hydration,serialization}` |
| [coder](https://github.com/coder/coder) `site`, scope `agents`, project `unit`, config `vitest.bench.config.mts` | 4.1.12 | jsdom, the `unit` project's 378 files beside a project of Storybook stories in a browser, the agents' pages compiled by the React Compiler (Babel); the config, written by the install, keeps the 41 files of `src/pages/AgentsPage/{hooks,utils}`, 33 of which reach the scope | `src/pages/AgentsPage/{hooks,utils}/**/*.ts`; this tool leaves out the 17 modules the compiler compiles, every hook among them, and mutates the other 36, all in `utils` |
| [element-plus](https://github.com/element-plus/element-plus), scope `table` | 5.1.0 | jsdom, 173 files of a Vue component library, its components single-file components (`.vue`) and TSX through the Vue plugins, mounted through @vue/test-utils; 5 files reach the scope | the `.ts` and `.tsx` modules of `packages/components/table/src`; its `.vue` files are left out |
| element-plus, scope `hooks` | 5.1.0 | the same; 137 files reach the scope, through the components that use the hooks | `packages/hooks/use-*/index.ts` |
| [fast-check](https://github.com/dubzzz/fast-check), scope `check`, project `fast-check` | 5.1.0 | node, 209 files of property-based tests in one of the inline projects the config makes from the directories of the repository, driven by the package's own build with a fixed seed; after each property run, many check that nothing reachable from `globalThis` has changed (@fast-check/poisoning); 167 files reach the scope | `packages/fast-check/src/check/**` |

On the machine above, with Node 24.22.2 and six workers, one run each, with another benchmark beside each run (load averages of 15 to 60 on its 12 cores): the times are of the work, not of the tool at its best. The check against the suite is of every mutant reported as survived, uncovered or timed out, and of 250 of the killed ones spread evenly over the rest (200 for lobehub, Shopify CLI, promptfoo, lint-staged, happy-dom and element-plus `table`); for tailwindcss, of every mutant, for ComfyUI_frontend, freelens, n8n, renovate, mikro-orm, coder and element-plus `hooks`, of every one but those that only run while a module loads; and for headlamp, of every mutant.

| Target and scope | Mutants | This tool | Against the suite |
|---|---|---|---|
| koel `composables` | 2,442 | 922 s | 1,120 checked, every survivor among them: all agree |
| homepage `utils` | 1,661 | 611 s for all 4,708 mutants of `src/utils` | 726 checked, every survivor and every mutant on which StrykerJS differs among them: all agree |
| tailwindcss `parsers` | 843 | 453 s | 843 checked, the 18 timeouts among them: all agree |
| sentry `utils` | 2,136 | 273 s, and the same verdicts in 273 s with `CI` set | 883 checked, every survivor among them: all agree |
| lobehub `topic` | 1,577 | 1,294 s | 502 checked, every survivor among them: all 489 judged agree, 13 unconfirmed |
| Shopify CLI `node` | 1,796 | 266 s | 718 checked, every survivor among them: all agree (with `archiver.ts`, since left out: 77 of the mutants and 43 of the checked) |
| promptfoo `assertions` | 1,760 | 281 s with `CI` set | 480 checked, every survivor among them: all agree |
| ComfyUI_frontend `stores` | 1,059 | 1,336 s | 1,041 checked, all but the 18 that only run while a module loads: all 1,040 judged agree, 1 unconfirmed |
| freelens `utils` | 429 | 2,042 s | 410 checked, all but the 19 that only run while a module loads: all agree |
| n8n `proxy` | 1,395 | 258 s | 1,351 checked, all but the 44 that only run while a module loads: 1,350 agree, 1 differs as its note says |
| headlamp `api` | 641 | 2,519 s | 641 checked, every mutant, the 46 timeouts among them: all agree |
| zod `core` | 2,954 | 574 s | 1,240 checked, every survivor among them: all agree |
| vercel/ai `node` | 2,774 | 432 s | 756 checked, every survivor among them: all agree |
| vercel/ai `edge` | 2,774 | 392 s | 752 checked, every survivor among them: all agree |
| SvelteKit `server` | 2,486 | 377 s | 1,061 checked, every survivor among them: 1,042 agree, 17 differ as their notes say, 2 unconfirmed |
| renovate `util` | 472 | 245 s | 471 checked, all but the 1 that only runs while a module loads: 469 agree, 2 differ as their notes say |
| lint-staged `lib` | 2,091 | 2,965 s | 530 checked, every survivor among them: all agree |
| happy-dom `selectors` | 1,787 | 161 s | 702 checked, every survivor among them: all agree |
| mikro-orm `core` | 617 | 1,013 s | 616 checked, all but the 1 that only runs while a module loads: all agree |
| coder `agents` | 2,808 | 413 s | 2,670 checked, all but the 138 that only run while a module loads: all agree |
| element-plus `table` | 4,014 | not run here | 2,088 checked, every survivor among them: all agree |
| element-plus `hooks` | 1,107 | not run here | 1,054 checked, all but the 53 that only run while a module loads: all agree |
| fast-check `check` | 1,638 | 4,596 s | 505 checked, every survivor among them: 504 agree, 1 unconfirmed |

koel's tests build their songs, albums and artists with faker, unseeded. A mutant that leaves two songs tied on a sort key, `'track'` made `""` in `usePlayableList.ts`, then orders them by random titles: the suite failed with it in 6 of 10 runs, with another of the same kind in 4 of 10, and passed 10 of 10 without either. A single run of the suite does not settle such a mutant, and a hosted run reported both as killed where the stored entries, made unseeded, had them pass. The install appends `faker.seed(0)` to the project's setup file, which runs once for each test file, so a file's data is the same in every run of it; seeding before each test instead left 17 tests failing with no mutant, in both of two runs. With the seed both mutants pass in 5 runs of 5.

StrykerJS on sentry stops at once without `inPlace`: its sandbox rewrites `tsconfig.json` through `typescript.parseConfigFileTextToJson`, which TypeScript 7 no longer has, as on date-fns and commitlint. The package's type test (`test/types`) needs the package built and fails without it; no source in the scope reaches it, and the shared config's coverage is switched off for ground truth, where it only slows each run. With `CI` set the config adds a JUnit and a GitHub reporter; ground truth sets `CI` and the hosted runner does, and the verdicts are the same as without it.

homepage's scope is a third of `src/utils`: the service helpers, the MCP server and the highlights add 981 survivors, each a run of the suite in ground truth, against 399 here. The scope's verdicts above are those of the run over all of `src/utils`; the hosted run is of the scope alone.

lobehub keeps no lockfile (`lockfile: false`), so a fresh install would resolve whatever is newest. The versions ground truth was made with are kept as `bench/lockfiles/lobehub-pnpm-lock.yaml`, written by pnpm from the filtered install, and the install turns the lockfile on and installs from it frozen. The package's config aliases `@/database` to `../database/src`, and the server code the tests load reaches the topic models through it: from a copy of the package that path is the original's sources, so ground truth is made in the checkout alone (`--jobs 1`) and StrykerJS runs in place.

The Shopify CLI suite reads which package manager started it from `npm_config_user_agent`, and one test expects pnpm, which the package's script gives and a run started as `node` does not: the target sets the variable, with `SHOPIFY_CLI_ENV=development`, which the repository's root config sets and a run inside the package does not get. Without either, five tests fail with no mutant. `fs.ts` and `path.ts` are left out of the scope: each is imported by more than 50 of the package's modules, and most of the 181 test files reach them. In one of six runs of the suite with no mutant, six tests of `analytics.test.ts` failed, which pass by themselves.

promptfoo's server reports the version in `npm_package_version`, which `npm test` sets, and `0.0.0-development` where the suite is started as `node`, as both tools and ground truth start it. For that version the version route offers no update, and its test `should not return 500 when fetch fails (graceful fallback)` fails in every run. The target sets the variable to the package's version. The stored entries were made without it, and ground truth left that test out as one that fails by itself; made again with the variable set, 20 of the stored survivors and 20 of the stored killed mutants, spread over the scope, each gave what is stored.

promptfoo's config stops a run at its first failing test when `CI` is set. Where the version route's test was the first to fail, the run stopped before the tests the mutant fails and was taken for a pass. 26 of 480 entries, made that way, disagreed with this tool, and one of them, put in by hand, failed `trajectory.test.ts` in three runs of three. Ground truth runs with `--bail=0`.

promptfoo runs its tests in an order shuffled with no fixed seed, and the stored entries were made that way. Ground truth for 20 of its survivors and 20 of its killed mutants, spread over the scope, was made three more times, each in a new order: every run gave what is stored for all 40.

On the machine that made promptfoo's entries, 25 tests of `test/providers/agentWorkspace.test.ts` and `agentWorkspace.appServer.test.ts` fail with no mutant, in each of two runs of the whole suite: git there has `core.fsmonitor` on, and the copy of a test repository the tests make stops at the monitor's socket in its `.git`. Neither file reaches a module of the scope, so ground truth, which runs the test files that do (`--related`), and this tool left them out; ground truth made again for this scope does the same wherever it runs, and a run of the whole suite on such a machine fails without a mutant.

ComfyUI_frontend's `src/lib/litegraph/src/utils` is loaded by almost all of its 2,550 test files, one module of it by 1,968; the scope is the 13 stores that the fewest test files import, directly or through other modules: 106 test files reach them. Its config retries a failing test twice when `CI` is set, as ground truth and the hosted runner set it; the run above was made without it, and agrees with ground truth as the hosted run does. Ground truth is made in the checkout alone (`--jobs 1`): from a copy next to it, whose `node_modules` are the original's, `vitest related` on one store ran 1,965 test files, 60 tests among them failing, where the checkout runs 6, and a test that runs `pnpm exec playwright` had pnpm install the workspace in the copy, which relinked the checkout's workspace packages to the copy.

freelens needs the extension API and the fixture extension built: without them 21 tests fail with no mutant. Electron fetches its binary the first time it is loaded, and in one of two runs of the suite two workers fetching it at once failed two more files; the install fetches it first. Every test that builds the dependency container loads every injectable of `src` through `import.meta.glob`, and with them nearly all of `src/common/utils`: each module of the scope is reached by about 300 of the 402 test files, 327 in all. The injectables and the files that register them are left out of the scope. This tool reports errors outside tests, "Obsolete snapshots found when no snapshot update is expected" in files with snapshots, 52 in the run above and 3 in the hosted one. They come with runs in which a mutant fails a test before its `toMatchSnapshot`: the snapshot goes unchecked, and Vitest 5, updating none, fails the file for it, as it does in the suite with such a mutant written in (a test that throws before its snapshot gives the same error under `CI=true` with Vitest 5.0.3, and passes without the throw). Tests left out of a run by name do not: a run of one test of `download-logs.test.tsx` under `CI` gave none. The tool lists these errors and runs such a file from its first test from then on; no verdict is read from them. Ground truth is made in the checkout alone (`--jobs 1`): from a copy next to it, most of the 303 test files that reach one module of the scope fail as they load.

n8n's config runs each test that evaluates an expression once for each of three engines, in projects of their own, and the rest in a `default` project. Of a test file that several projects include this tool counts only the first project's run ([limits](limits.md)), so the target runs `default` and `vm-engine`, the native isolate, as the package's own StrykerJS config does; the other two engines are not run. Outside UTC a test of `.toDateTime` fails in each engine project with no mutant, so the target sets `TZ=UTC`. The install builds the workspace packages the package depends on. The scope is narrower than first meant: with `src/expression.ts` and `src/expressions/**` beside it, 3,797 mutants, a run of this tool on the machine above took 1,793 s and left 17 unconfirmed, the native evaluator's fuzz test file being run one at a time. `src/extensions/*`, which `@n8n/expression-runtime` holds a copy of, is left out too: of the 220 mutants of `number-extensions.ts` 160 survive, most of them in tables of strings. Ground truth was made from four copies of the package next to it (`--jobs 4`): the package reaches its own sources only by relative paths, and no workspace package it loads depends on it. From a copy, `vitest related` on `workflow-data-proxy.ts` ran the same 34 test files and 2,198 tests as the checkout, and 156 entries made again in the checkout alone, every timeout among them, gave what is stored for 155; the other, an `i++` that loops, timed out in one and failed in the other.

headlamp's install runs the package's `make-env.js`, as its `pretest` script does, which writes the `.env` Vite reads. The config defines `import.meta.env.UNDER_TEST` as whether the variable `UNDER_TEST` or `VITEST` is `true`, and where it is, `retry.ts` turns off the retries of a failed request. The target sets `UNDER_TEST` for StrykerJS ([below](#the-targets-added-in-november-2026)); Vitest started by its own command or by this tool sets `VITEST` to `true`, and the variable changes nothing there. `src/lib/k8s/api/v2/useKubeObjectList.ts` and the `.tsx` modules are left out of the scope: the first has 707 mutants by itself and `apiDiscovery.tsx` 289, and each mutant adds a run of about a minute to ground truth, made in the checkout alone. Each module of the scope is imported, directly or not, by 124 to 176 test files, components and the test of every story among them. `src/frontendDevServer.test.js` fails in the whole suite with no mutant, wanting the `npm_execpath` an npm script sets; it imports no source of the package, so neither ground truth, which runs the test files that reach the mutated module (`--related`), nor this tool runs it. The suite fails with each of the 46 mutants reported as timed out, 28 in `multiplexer.ts` and 18 in `webSocket.ts`, and times out with none. The `{}` body of `cancel()` in `nodeSummaryApi.ts` leaves an interval running into later tests: with it the related tests failed in 6 of 8 runs, and passed in the first run ground truth made and one other; in each of the five failing runs made by hand, one to three tests of other stories in `storybook.test.tsx` failed, different ones each time; its entry carries a note. The run above had no other benchmark beside it, at load averages of 2 to 9 where they were looked at. A run of this tool writes some 335 MB of the tests' console output, from React and jsdom. Ground truth is made in the checkout alone (`--jobs 1`): from a copy next to it Vite refuses the `?url` import of a file in `node_modules`, which is the original's and outside the copy, and two of the 143 test files that reach `retry.ts` fail as they load.

zod's suite as the repository runs it is a root config whose projects are config files, each package's and `vitest.compile.config.ts`, which this tool does not run ([limits](limits.md)), and the package's own config merges the root's, whose projects then name files from the package's directory, so Vitest does not start from it. The target runs `vitest.compile.config.ts`, the repository's `test:compile`: every test of the package, with compilation turned on for all of them. That config turns the type check off, which the root config has on with `tsc`: ground truth is the suite of that config, without the type check, as this tool runs it. The repository's package manager is nub, which writes a pnpm lockfile that pnpm does not install from frozen: peers resolved to the workspace's own `zod` are written as `zod@4.6.7`, which the lockfile has no entry for, and aliased packages under their aliases. The install writes the workspace file pnpm reads, adds that one entry and installs frozen with pnpm 10. Adding StrykerJS then resolves the workspace again, as on every target, which writes those peers as links to the workspace's package and, of the versions locked, drops only get-tsconfig 4.10.0; both tools and ground truth run on what that leaves. The tests import `zod` by its name, which resolves to the checkout's sources through `node_modules`, so ground truth is made in the checkout alone (`--jobs 1`).

vercel/ai's `packages/ai` runs its tests twice, in node and in the edge runtime, each from a config of its own: two targets, `vercel-ai` and `vercel-ai-edge`, with one scope each over the same sources. Both configs turn on Vitest's type check, of 40 `*.test-d.ts` files, in which a mutant that breaks only types fails the suite: with `const n: string = vector1.length;` written into `src/util/cosine-similarity.ts`, which changes nothing at run time, every test passes and the run exits with 1. This tool does not run the type check, and reports such a mutant as survived, as for h3. Ground truth for both scopes is made with the type check off (`--typecheck.enabled=false` in `truthArgs`): it is the suite's runtime tests, not its type tests, that the verdicts are held against. The type tests themselves are left out of the scope. The install builds the package and the workspace packages it depends on, as the repository's `test` task does: the tests import those from their builds, and one compiles a declaration against the package's own, failing with no mutant without it. Ground truth was made from four copies of the package (`--jobs 4`): the package reaches its own sources by relative paths, and the workspace packages it loads do not depend on it. 80 entries of the `node` scope, spread over its survivors, uncovered mutants and timeouts, made again in the checkout alone gave what is stored for 79; the other, a `{}` for a block of `consume-stream.ts`, failed in one and timed out in the other.

SvelteKit's package keeps its own tests in `vitest.kit.config.js`, a name of its own so that the test applications under `test/apps`, each a Vite project, do not pick it up: run from the default config, the package's tests took in those applications, and 254 tests failed with no mutant, wanting their servers. Of `src/runtime/server` and `src/utils`, 5,845 mutants, the package's tests reach few of the modules that handle requests and render pages, which the repository tests through those applications: 2,419 of the 3,359 mutants left out of the scope are reached by no test. The scope is `src/utils` and the server modules its tests reach for most of their mutants. Two of the package's tests see the sources as they are on disk, not as Vitest serves them, which this tool cannot put a mutant into ([limits](limits.md), tests that read the source from disk). `src/utils/fork.js` runs a module in a worker thread that Node loads from its file: the 24 mutants in the part of it that runs there are reported as covered by no test, and with 16 of them written into the source the suite fails or times out. The tests of `Creates correct $types` in `src/core/sync/write_types/index.spec.js` generate types for sample routes and run `tsc` on them in a process of their own, which reads the package's JSDoc types from disk: with `false` for `typeof source !== 'string'` in `src/utils/sourcemap.js` written into the source, those 10 tests are the only ones of the Vitest run that fail, and this tool, whose mutant `tsc` never sees, reports it as survived. Their 17 entries carry a note to say so. Those 16 are not the 16 of `fork.js` reported as timed out: of its 76 mutants this tool reports 24 killed, 16 timed out, 8 survived, 24 uncovered and 4 static, as it did when the project was first tried, before the scope was chosen, and the suite detects each of the 16 timeouts, 12 timing out with it and 4 failing. The same test file's runs fail each other where two run at once, and this tool ran it one run at a time. Ground truth is made in the checkout alone (`--jobs 1`): the tests import the package by its own name, and from copies next to it 269 mutants failed the suite that passes with them in the checkout. Made again in the checkout alone, the entries differ from what the copies gave, once those were run again there, only in 11 that time out in one and fail in the other.

renovate's target sets the five variables of the project's `vitest` script and removes `CI`, under which the config adds reporters of its own. Without `CI`, Vitest writes snapshots it has not seen and passes, so ground truth runs with `--update=none`, and with the coverage the config turns on switched off. The scope is the ten modules of `lib/util` whose related tests, one run of ground truth each, took 75 s or less on the machine above, `minimum-release-age.ts` among them. `check-token.ts`, `coerce.ts` and `emoji.ts` are reached by 383 to 396 test files and took 151 to 215 s a run, and the modules of `lib/modules/manager/helmv3`, 365 mutants, 59 to 78 s each: about seven hours of ground truth for helmv3 alone, one run in the checkout at a time. Truth was made from copies of the checkout next to it (`--jobs 2`): from a copy, the related tests of `minimum-release-age.ts` pass, 91 files, and a throw put at the top of the copy's `interpolator.ts` fails all 20 of its related files. `sample.ts` draws an index with `Math.random`, unseeded, and its mutant `length - 1` made `length + 1` lets the index fall past the end: two tests of `bitbucket-server/index.spec.ts` then fail, one or both of them in each of 8 runs of 8 made by hand, and the entry carries a note. One hosted run had that mutant survive. Another, `lastIndex - index` made `lastIndex + index` in the same draw, widens its range: the related tests failed with it in 6 of 10 runs made by hand, a hosted run had it killed where the entry first said pass, and its entry carries a note too. A third, `index + Math.floor(...)` made `index - Math.floor(...)`, lets the index fall before the start: the related tests failed with it in 7 of 10 runs made by hand, a hosted run ([run](https://github.com/wadackel/vitant/actions/runs/44750797937)) had it survive, and its entry carries a note as well.

lint-staged's integration tests start the formatter `oxfmt` by its name, which a run started as `node` finds only with the project's `node_modules/.bin` on `PATH` (`binOnPath`). The config holds coverage to 100%, which a run of some of the test files falls short of, so ground truth runs with coverage off. The `e2e` project, which runs the published command, and `types`, Vitest's type check, are not run. Ground truth is made in the checkout alone (`--jobs 1`): a copy has no `.git`, and in one the related tests of `lib/state.js` fail three tests with no mutant. A first attempt from two copies had 294 of 330 entries fail at first and pass alone.

happy-dom's modules of `src/css`, `src/dom` and `src/query-selector` are each reached by 276 of the package's 304 test files, so each run of ground truth is a run of nearly the whole suite: the scope is the selector engine and `DOMTokenList.ts`, 1,787 of their 10,606 mutants. Of `DOMTokenList.ts`'s 185, the 67 reported as reached by no test are so: with markers in the code they are in, the whole suite fired none of them. The suite runs from `packages/happy-dom`, against whose working directory it resolves the directories of its virtual servers. Every test is held to 500 ms; ground truth made from two copies (`--jobs 2`) had 4 of 502 entries fail at first and pass alone, and a hosted run on a Xeon Platinum 8573C left 17 mutants unconfirmed.

mikro-orm's suite starts MongoDB from its global setup, downloading it the first time, unless `npm_lifecycle_event` is `test:sqlite`, as its `test:sqlite` script sets it. That script runs the files named by the filter `sqlite.test.ts`. The install writes a config that does both: it keeps each project's files to those, 107 of them, the same files the filter selects, since StrykerJS takes no filter and `vitest related` none either, and it sets the variable, which a variable of the target's could not do for StrykerJS: npx, which starts it, sets `npm_lifecycle_event` to `npx`. Started that way with the config, the suite passes and no `mongod` runs; with the filter in its place, one does. The config resolves the workspace's packages to their sources from its own place, so ground truth from copies (`--jobs 2`) tests the copy's sources: a throw put at the top of the copy's `ChangeSetComputer.ts` fails all 107 files. better-sqlite3 reads the clock in native code ([limits](limits.md)); of the 313 killed mutants 289 rest only on runs in copies of a worker, and ground truth covers every mutant. Over all of `unit-of-work`, `hydration` and `serialization`, 3,605 mutants, a hosted run had not ended after 150 minutes.

coder's front end is `site`, whose config has two projects: `unit`, in jsdom, and one that runs Storybook's stories in a browser, which the target leaves out. The config's vite-plugin-checker makes Vitest's `forks` pool fail to start a worker after five test files with `spawn EBADF`, in the plain suite as well; this tool runs every file in `forks`. The install writes `vitest.bench.config.mts` beside the project's config, which leaves the plugin out and keeps the `unit` project to the 41 test files of `src/pages/AgentsPage/{hooks,utils}`: the scope's modules are imported, directly or not, by some 155 test files, the pages' components among them, and a run of those took 228 s, against 15 s for the 41. The verdicts are of those 41: a mutant reported as survived may fail a test of a component the target leaves out, and ground truth, run with the same config, does not run those either. Outside UTC two tests of `timeGroups.test.ts` fail with no mutant, comparing a pinned time with local midnight, so the target sets `TZ=UTC`. The project compiles `src/pages/AgentsPage` with the React Compiler, which compiles a hook or component from its source and gives up on its instrumented code; this tool leaves such a file out ([limits](limits.md)): of the scope's 53 modules, the 16 of `hooks` and `utils/notificationWindow.ts`, 2,206 of 5,014 mutants. No module of `hooks` is left to mutate, and the scope's verdicts are of the 36 other modules of `utils`, 2,808 mutants. The check that leaves them out took 3.4 s in the run above. Ground truth covers every mutant this tool judged, 2,670, and none of the files it left out. It is made in the checkout alone (`--jobs 1`): from a copy next to it Vite refuses the setup file `@testing-library/jest-dom/vitest`, which resolves through the linked `node_modules` to the original, outside the copy, and every run there fails. The four mutants of the decoding timeout's callback in `resizeImage.ts` (lines 236 to 240) are reported as survived on the machine above and as covered by no test on a runner: whether a test's run reaches the callback before the image loads depends on the machine; the suite passes with each.

element-plus writes its components as Vue single-file components, which this tool leaves out ([limits](limits.md)): 1,117 of the 7,622 mutants of the `.ts`, `.tsx` and `.vue` sources of `packages/components/{table,select,form}` and `packages/hooks`, about 15%. The scopes are the `.ts` and `.tsx` modules of the table component and the hooks, which `table.vue` and the other components import. Both in one scope, 5,121 mutants, did not end within 150 minutes on a hosted runner, and a run on the machine above, beside a run of ground truth for another target, was ended after 45 minutes for the memory the two held; as two scopes each takes about 70 minutes on a runner, and neither was run here. The hooks are imported by the components: each of four of them is reached by 115 to 118 of the 173 test files, and a run of ground truth for a hook takes about 13 s, for a module of the table, which five files reach, 3 s. Ground truth covers every mutant of `hooks` but the 53 that only run while a module loads, and of `table` every survivor and 200 killed ones, held against the reports of a hosted run of this tool alone ([run](https://github.com/wadackel/vitant/actions/runs/44724632038)). It is made in the checkout alone (`--jobs 1`). In a copy next to it, a test that imports a workspace package by its name, as the components import `@element-plus/hooks`, loads the original's sources through the linked `node_modules`, beside the copy's own wherever a test also imports a hook by its path: 171 killed mutants of `hooks` passed there. The copy's probes passed all the same when they asked only that some test file fail with the throw, since each hook's own test file imports it by its path; they now ask for the same test files as in the checkout, and refuse the copies for `use-namespace`, `use-model-toggle` and `use-focus`. Made again in the checkout, every entry from the copies had the same outcome but for 26 of `hooks` that failed there and timed out here. No test worker loads a native module: in a run of the suite with every `process.dlopen` recorded, only Vitest's main process loads rolldown's binding and fsevents.

fast-check's tests drive the code under test with the package's own build, `lib/`, and their assertions load the built `@fast-check/poisoning`: the install builds both, from the sources as they are, as in a run of the suite with a mutant written into them. The setup file seeds every property with `DEFAULT_SEED`, and throws without it under `GITHUB_ACTION`; the target sets it to 42. pnpm is the 12.18.0 that the repository's `devEngines` names, which the pnpm on the path fetches and hands over to, and StrykerJS is started with `npx --force`, as on tsdown. Ground truth is made in the checkout alone (`--jobs 1`): from copies next to it, the related tests of 36 of the scope's 37 modules fail with no mutant and pass in the checkout, and the copies' probes refuse them. In each run of this tool, four to six mutants make a worker run out of its 4 GB heap. The one unconfirmed mutant of the run here, `safePerformanceNow() + startTimeProbe` at `TimeoutPlugin.ts:30:10`, rests on a test of `test/Ticks.spec.ts` that counts ticks against a time limit and failed in one run of its file and not in another; the suite passes with it, and both hosted runs have it survive.

## On hosted CI runners

### The targets added in November 2026

The targets of [Targets added in November 2026](#targets-added-in-november-2026), measured from 15 to 21 November 2026 on the branches that added them, on four-core Ubuntu 24.04 runners: one run each, StrykerJS and this tool one after the other in a job ([tailwindcss](https://github.com/wadackel/vitant/actions/runs/43770269949), [homepage and sentry](https://github.com/wadackel/vitant/actions/runs/43782028294), [koel](https://github.com/wadackel/vitant/actions/runs/43790526671); on 16 November, [lobehub](https://github.com/wadackel/vitant/actions/runs/43851817912), [Shopify CLI](https://github.com/wadackel/vitant/actions/runs/43874404546), [promptfoo](https://github.com/wadackel/vitant/actions/runs/43924753715); on 17 November, [ComfyUI_frontend](https://github.com/wadackel/vitant/actions/runs/44005389996), [freelens](https://github.com/wadackel/vitant/actions/runs/44006868976), whose report was held against its ground truth once that was stored; on 18 November, [n8n](https://github.com/wadackel/vitant/actions/runs/44298632468) and [headlamp](https://github.com/wadackel/vitant/actions/runs/44343699763), whose report was held against its ground truth once that was stored; on 19 November, [zod and vercel/ai](https://github.com/wadackel/vitant/actions/runs/44439682733), and [SvelteKit](https://github.com/wadackel/vitant/actions/runs/44454088789) by this tool alone; [renovate](https://github.com/wadackel/vitant/actions/runs/44464439898), [lint-staged](https://github.com/wadackel/vitant/actions/runs/44464443671), [happy-dom](https://github.com/wadackel/vitant/actions/runs/44458676541) and [mikro-orm](https://github.com/wadackel/vitant/actions/runs/44635874651), whose reports were held against their ground truth once that was stored; [coder](https://github.com/wadackel/vitant/actions/runs/44601050049), whose report was held against its ground truth once that was stored; and on 20 November, [element-plus](https://github.com/wadackel/vitant/actions/runs/44743033338), whose reports were held against their ground truth once that was stored; and on 21 November, [fast-check](https://github.com/wadackel/vitant/actions/runs/44910416317), whose report was held against its ground truth once that was stored), every report of this tool held against the stored ground truth.

| Target and scope | Processor | StrykerJS | This tool | Against the suite |
|---|---|---|---|---|
| koel `composables` | Xeon 6975P-C | does not start | 1,561 s | all 1,120 agree |
| homepage `utils` | EPYC 7763 | 824 s | 1,359 s | all 718 then stored agree |
| tailwindcss `parsers` | EPYC 7763 | 3,494 s, not comparable | 4,485 s | all 843 agree |
| sentry `utils` | EPYC 9V45 | 392 s | 371 s | all 883 agree |
| lobehub `topic` | Xeon 8370C | 2,746 s, not comparable | 4,056 s | all 502 agree |
| Shopify CLI `node` | Xeon 8573C | does not start | 256 s | all 718 agree (with `archiver.ts`, since left out: 43 of them) |
| promptfoo `assertions` | Xeon 6975P-C | does not start | 713 s | all 480 agree |
| ComfyUI_frontend `stores` | EPYC 9V74 | 1,348 s, not comparable | 2,987 s | all 1,041 agree |
| freelens `utils` | Xeon 6975P-C | 15,994 s on an EPYC 7763, not comparable | 7,824 s | all 410 agree |
| n8n `proxy` | Xeon 6975P-C | 1,004 s | 768 s | all 1,351 agree |
| headlamp `api` | Xeon 6973P-C | 1,999 s | 5,223 s | all 641 agree |
| zod `core` | Xeon 6975P-C | does not start | 1,406 s | all 1,240 agree |
| vercel/ai `node` | EPYC 9V74 | 1,553 s | 658 s | all 756 agree |
| vercel/ai `edge` | Xeon 6975P-C | 1,499 s | 667 s | all 752 agree |
| SvelteKit `server` | Xeon 6975P-C | not through in six hours | 456 s | 1,044 agree, 17 as their notes say |
| renovate `util` | Xeon 6975P-C | does not start | 386 s | 470 agree, 1 as its note says |
| lint-staged `lib` | EPYC 9V74 | 2,181 s, not comparable | 2,872 s | all 530 agree |
| happy-dom `selectors` | Xeon 6975P-C | does not start | 622 s | all 702 agree |
| mikro-orm `core` | Xeon 6975P-C | 2,778 s, not comparable | 2,065 s | all 616 agree |
| coder `agents` | EPYC 9V74 | does not start | 595 s | all 2,670 agree |
| element-plus `table` | EPYC 9V74 | 2,557 s, not comparable | 5,181 s | all 2,088 agree |
| element-plus `hooks` | EPYC 9V45 | does not start | 4,092 s | 1,053 agree, 1 unconfirmed |
| fast-check `check` | Xeon 6975P-C | does not start | 6,065 s | all 505 agree |

A run of this tool alone on each scope at [52211e2](https://github.com/wadackel/vitant/commit/52211e2e70ef006c997d7ad362e8aa1fd68cf137), on top of [#34](https://github.com/wadackel/vitant/pull/34) ([run](https://github.com/wadackel/vitant/actions/runs/43796297923)), agreed with every stored entry, homepage's 726 among them: koel 2,400 s on an EPYC 7763, homepage 853 s on an EPYC 9V45, tailwindcss 1,481 s and sentry 379 s on a Xeon 6975P-C. Between processors a time differs as much as between the tools, so only times from one job compare.

lobehub: StrykerJS kills none of its 1,540 mutants, so its time is not of the same work. This tool reports 1,188 of them as killed, and 193 of those StrykerJS has survive are stored entries with which the suite fails or times out.

Shopify CLI: with `CI` set the config's reporter is `basic`, which Vitest 4 no longer has, and StrykerJS stops as it starts; this tool and ground truth name reporters of their own. An earlier run, before StrykerJS was run in place, stopped where its copy of the package could not import `../../configurations/vite.config` ([run](https://github.com/wadackel/vitant/actions/runs/43869015872), where this tool took 234 s on a Xeon 6975P-C and agreed with all 718).

promptfoo: StrykerJS stops in its first run, its runner having put the tests in a `threads` pool where no worker starts ("Failed to start threads worker"); the config gives the workers `--max-old-space-size` in `execArgv`, which is likely what a worker thread does not take, though that was not looked into further. Without running in place it stopped earlier, on the TypeScript 7 API its sandbox calls ([run](https://github.com/wadackel/vitant/actions/runs/43916487826), where this tool took 704 s on a Xeon 6975P-C and agreed with all 480).

koel: StrykerJS stops after its first run, in which a test of `songWaveform.vue` fails that passes in the suite.

ComfyUI_frontend: StrykerJS kills 7 of its 1,104 mutants, so its time is not of the same work: of those it has survive, 623 are stored entries with which the suite fails, and 10 more with which it times out. From its sandbox it stopped in its first run, where a test's mock of a workspace package was looked for in the checkout and not found ([run](https://github.com/wadackel/vitant/actions/runs/43997853644), where this tool took 2,476 s on a Xeon 6975P-C and agreed with all 1,041); it runs in place.

freelens: StrykerJS, run in place and alone in a job on an EPYC 7763 ([run](https://github.com/wadackel/vitant/actions/runs/44023834598)), took 15,994 s and killed none of its 454 mutants, so its time is not of the same work. In the job of the table it was not yet run in place, and stopped at once: its sandbox rewrites `tsconfig.json` through the TypeScript API that version 7 no longer has. This tool's 7,824 s on a Xeon 6975P-C is close to the 150 minutes after which the workflow ends a run of it as one that hangs, which a runner a sixth slower would pass; the target sets its own limit of 300 minutes (`limit` in `bench/targets.ts`), which a runner half as fast stays within, as does the job's six hours where the job runs this tool alone (`tools=vitant`): each tool but StrykerJS gets the limit, and StrykerJS took 15,994 s by itself. The target now leaves StrykerJS out (`strykerSkip`): a job whose tools include StrykerJS, as the workflow's default does, runs the others and records why. The run takes that long because some 300 test files reach each mutant, and 9,629 s of the 13,525 s its processes spent went to runs of whole files that pass.

n8n: StrykerJS is the package's own 10.1.1, which its workspace catalog pins and allows no other version of, where the other targets but tsdown get 10.0.0. It runs the tests in the `forks` pool (`strykerPool` in `bench/targets.ts`), as the package's own config for it does: in its default, `threads`, isolated-vm aborts the process when a thread that started an isolate ends, which in a trial on one file it did in the first run. Of its verdicts 39 differ from the stored entries: 29 mutants survive with which the suite fails, and 10 time out with which it passes. A second run of this tool alone ([run](https://github.com/wadackel/vitant/actions/runs/44298637735)) took 716 s on a Xeon 6975P-C and gave every mutant the verdict of the first; neither left a mutant unconfirmed.

Two tests of `native-evaluation-parity.test.ts`, `$now.toMillis()` and `$now.toSeconds()`, compare a time read in isolated-vm's isolate, from the machine's clock, with one read in the test, within a minute. In a copy of a worker made after other copies the test's clocks leave out the time the copy stood waiting, and the two failed there where the suite passes them: in a run of the wider scope on the machine above whose runs of the file were made in copies made once it had loaded, 1,709 of those runs failed one of the two and neither of 2 runs in workers started for them did, and on a runner the scope was left with 28 and then 44 mutants unconfirmed for them. The file starts an isolate's thread, and its runs are made in copies made before it loads, which never stand still: all 108 in the first run above ([A copy reads some clocks later than the run it stands for](limits.md)); in the two runs above neither test failed.

Two entries carry a note. `false` for the condition at `workflow-data-proxy.ts:432:9` makes the suite end in a fatal error of V8 under isolated-vm on the machine above in 10 runs of 10, and pass on a runner in 10 of 10 ([run](https://github.com/wadackel/vitant/actions/runs/44238273091)), both the same with `--single-threaded` for the workers; its entry is the runner's, and this tool reports it killed on the machine above and survived on a runner. `step.next.length + 1` at `workflow-data-proxy.ts:1134:20` makes the two "resolves 5000 pages" tests of `workflow-data-proxy.test.ts` take some 30 times as long, 10 and 18 ms becoming 260 to 540 ms on the machine above, and they pass. In one run on a runner ([run](https://github.com/wadackel/vitant/actions/runs/44230225165)) a try of the first blocked a worker, and the run of the file that followed, in a copy made once the file had loaded, went past the shorter limit that leaves ([A timeout is a judgement](limits.md)) after 17.5 s and was reported as timed out; in the two runs above it survived.

headlamp: this tool is slower than StrykerJS here. Of the 12,776 s its four processes spent on trials and on runs of whole files, 8,442 s went to runs of whole files that pass. In the run on the machine above, whose records were kept, one file took most of that time: `storybook.test.tsx`, which renders every story and takes about a minute a run, made 151 of the 865 runs of whole files and 9,432 s of their 10,308 s, 5,352 s of it in 84 runs that passed. A survivor is run whole with the files whose tests reach it, one to eight of them, and that file was among them for 74 of the 128 survivors run so; only the one survivor of `retry.ts`, whose code runs while the module loads, was run with 83. The 46 timeouts took 590 s of those runs. StrykerJS's runner sets `VITEST` to `1`, not `true`, so without `UNDER_TEST` the retries of a failed request stay on there, and a test that expects a failed request to give its error at once fails in StrykerJS's first run, where it stops ([run](https://github.com/wadackel/vitant/actions/runs/44315760809), where this tool took 7,885 s on an EPYC 7763, gave every mutant the verdict of the run of the table, and agreed with all 641). That time is close to the 150 minutes after which the workflow ends a run of this tool, and the target sets its own limit of 300 minutes (`limit` in `bench/targets.ts`), as freelens does. Of the mutants both tools ran, they disagree on 11, each checked against the suite: StrykerJS has them survive, and the suite fails with them. 10 of them only run while a module loads; the other is the `{}` body of `cancel()` in `nodeSummaryApi.ts`, with which the related tests fail in most runs.

zod: StrykerJS stops after its first run, in which `forwarding more issues than fit in a call's arguments does not throw` runs past Vitest's 5 seconds for a test, which it stays within in the suite. Before the directory symlink `.codex/skills` was left out of its sandbox (`strykerIgnore`) it stopped as it copied it ([run](https://github.com/wadackel/vitant/actions/runs/44405934153), where this tool took 1,622 s on an EPYC 9V74 and agreed with all 1,240).

vercel/ai: of the mutants both tools ran, the two differ on 11 in each scope, every one a stored entry the suite passes with, which StrykerJS has 10 of killed and 1 timed out. An earlier run of both scopes, with the 9 mutants of two type test files then still in the scope ([run](https://github.com/wadackel/vitant/actions/runs/44405979526)), gave this tool's same verdicts for every other mutant, in 631 s and 753 s on a Xeon 6975P-C.

SvelteKit: the target leaves StrykerJS out (`strykerSkip` in `bench/targets.ts`): a job whose tools include StrykerJS runs the others and records why. StrykerJS was not through after the six hours a job is given, in a job of both tools ([run](https://github.com/wadackel/vitant/actions/runs/44454086099)), which leaves nothing to read, nor in an earlier job with the scope over all of `src/runtime/server` and `src/utils`, 5,845 mutants, stopped by hand after StrykerJS had run for 5 hours 54 minutes ([run](https://github.com/wadackel/vitant/actions/runs/44405979526)); the time of this tool is from a job of its own. On the machine above StrykerJS wrote nothing after it had placed its mutants, in 25 minutes. The 2 mutants of `routing.js` that this tool left unconfirmed on the machine above, where runs of `write_types/index.spec.js` failed each other, it reports as survived on the runner, as the suite has them.

renovate: StrykerJS stops at once in its sandbox, on `ts.parseConfigFileTextToJson`, which TypeScript 7 no longer has. In place, a test of `azure-helper` loads StrykerJS's backup of `lib/expose.ts`, which finds no `../package.json`, and StrykerJS's first run fails.

lint-staged: StrykerJS runs in place, its sandbox stopping on TypeScript 7 as on renovate. Its first run passes all 492 tests, and it then reports every one of the 1,939 mutants it runs as survived, so its time is not of the same work: of those, this tool reports 1,522 as killed, and the 200 of them that ground truth checked all fail the suite.

happy-dom: StrykerJS's first run fails, in its sandbox and in place, in `HTMLScriptElement > Dispatches "error" event on Window when compilation of module failed`, which passes in Vitest started by itself, with one worker in `threads`, with `--maxConcurrency=1`, without isolation and with `NODE_ENV=test`.

mikro-orm: StrykerJS runs in place, as on renovate, and reports 416 of the 648 mutants it makes as timed out, so its time is not of the same work: this tool has 226 of those killed and 166 survive, and the suite passes with each of the 166.

coder: StrykerJS stops in its first run, in which a worker of Vitest's exits, after 173 s in the job of the table and after 193 s in an earlier one ([run](https://github.com/wadackel/vitant/actions/runs/44405979526), before this tool left the compiled modules out). It mutates all 53 modules of the scope, the 17 this tool leaves out among them. Run in place on the machine above, its first run stopped the same way with all 53, and passed, 670 tests, with every one but `hooks/useDesktopConnection.ts`: that hook, left uncompiled once instrumented, renders in a loop, which ran this tool's workers out of memory before it left the file out ([limits](limits.md)) and is likely what ends StrykerJS's worker, though that was not looked into further.

element-plus: StrykerJS kills none of the 4,165 mutants it makes in `table`, its first run having run 138 tests where this tool's runs of the five files have 163, so its time is not of the same work: of those it has survive, this tool has 2,036 killed, and the 200 killed ones among the stored entries are each a mutant the suite fails with. On `hooks` its first run fails in `Datetimerange confirm honors disabledDate`, which passes in the suite, and it stops after 47 s; that was not looked into further. This tool is slow here all the same: of `table`'s run, 9,545 s of its four processes' time went to runs of whole files that pass, each of the 1,280 survivors run with every file that reaches its module, and 5,537 s to trials. A run of this tool alone on a Xeon 6975P-C ([run](https://github.com/wadackel/vitant/actions/runs/44724632038)) took 4,230 s on `table` and 3,947 s on `hooks`. The one unconfirmed mutant of `hooks`, `true` for the condition at `use-model-toggle/index.ts:125:10`, rests on a test of `popconfirm.test.tsx` that failed and passed with it; the suite passes with it.

fast-check: StrykerJS's Vitest runner finds no test file related to the mutated files and stops after 5 s, no test having run. A run of this tool alone on the same processor ([run](https://github.com/wadackel/vitant/actions/runs/44902185378)) took 5,790 s, with the same verdicts.

StrykerJS on tailwindcss reports 319 of its 869 mutants as timed out, 66 of which the suite passes with, so its time is not of the same work. This tool is slower there all the same: of the time its four processes spent, 6,648 s went to runs of whole files that pass, the 79 survivors and the 95 uncovered mutants each run with every test file that reaches them.

homepage is also slower here than with StrykerJS: 3,453 s of its processes' time went to runs of whole files that pass, the 399 survivors each run with every test file that loads the module, up to 228 for `proxy/http.js`. Of the 1,661 mutants both ran, the two agree on all but 10, each checked against the suite: StrykerJS has 9 survive, all in code that runs while a module loads, that this tool reports as killed and that fail the suite, and kills one that this tool reports as survived and that the suite passes with.

### Linux measurements at bc4025c

StrykerJS 10 and vitant at [bc4025c](https://github.com/wadackel/vitant/commit/bc4025c9fbdc22c4333e1110d18e2536b8eac153), measured on 15 November 2026 one after the other in each job on a four-core Ubuntu 24.04 runner, with Node 24.22.2 and pinned target commits: three jobs a scope ([libraries](https://github.com/wadackel/vitant/actions/runs/43624239141), [date-fns, Secretlint and commitlint](https://github.com/wadackel/vitant/actions/runs/43627153264)). Seconds are medians; speed ratios are medians of within-job ratios, so they need not equal the ratio of the displayed seconds. A ratio above one favors vitant.

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

The table above is also in the README.

#### Application scopes

The same commit on the same runners, two jobs a scope ([applications](https://github.com/wadackel/vitant/actions/runs/43624241499)), and actual `server` in a run of its own without StrykerJS, as on 10 November ([actual](https://github.com/wadackel/vitant/actions/runs/43624286153)).

| Target and scope | Jobs | vitant s | vitant `--fast` s | Median paired Stryker / vitant |
|---|---:|---:|---:|---:|
| Umami `lib` | 2 | 878.5 | 359.7 | not comparable |
| Formbricks `utils` | 2 | 1,253.9 | 780.5 | 1.704 (1 / 2 pairs) |
| Immich `utils` | 2 | 2,269.1 | 1,152.6 | not comparable |
| Immich `services` | 2 | 2,510.9 | 1,672.0 | not comparable |
| Actual `server` | 1 | 10,939.1 | 4,645.1 | not run |

Stryker's covered survivors with zero completed tests make its Umami and Immich results incomparable; on Formbricks one of its two runs failed. Every judged stored-truth entry agrees: 1,367 on Umami, 473 on Formbricks, 531 and 250 on Immich, 240 on Actual. One Immich `services` job exited with 1 for four mutants of `database-backup.service.ts` that the two modes report as NoCoverage and Survived, both undetected, which flip between jobs on earlier commits as well.

Actual's time follows the processor more than anything else: the same work, 13,921 to 14,070 runs of whole files, took 5,486 s on an EPYC 9V45, 7,549 to 7,951 s on an EPYC 9V74 in four runs of this and the commits before it, and 10,939 s on the EPYC 7763 this run had. Within one job, before against after, [#21](https://github.com/wadackel/vitant/pull/21) gave Umami `lib` 1.06, Formbricks `utils` 1.02, Immich `utils` 1.08 and `services` 1.10, [#22](https://github.com/wadackel/vitant/pull/22) 1.08, 1.03, 1.05 and 1.04, [#23](https://github.com/wadackel/vitant/pull/23) 1.03, 1.04 in its one comparable job, 0.99 and 1.05 (see [Making such a process cheap](design.md#making-such-a-process-cheap) and [Tuning](design.md#tuning)).

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

Older measurements below retain their own source versions, operating systems and conditions.

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

`bench/truth.ts` writes each mutant of a report into the source, in parentheses where it stands for an expression and only where that parses to the same tree around it, runs Vitest, and compares. Inside an optional chain that goes on past the mutant it writes the text bare: `(a?.b.c)()` calls undefined where `a?.b.c()` stops at `a`, and one survivor of umami was taken for failing the suite until that was seen. Of the 190 entries stored before then that lie inside such a chain, none came out otherwise written bare. The template of a tagged template goes in bare as well: in parentheses the tag becomes a call, ```sql(``)``` for ``sql`...` ``, or at the start of a statement, with the semicolon, a statement of its own. lobehub's queries are the first scope with such mutants; none of the 293 entries with a template for their text stored before then is the template of a tagged template. A mutant counts as agreeing when the suite fails or hangs and the report says Killed or Timeout, or the suite passes and the report says anything else. Three things are checked with it:

- **The fixture projects, on every platform in full CI.** `pnpm test:truth` runs the suites with each eligible mutant written into the source: basic in default and static modes, then stuck, clash and walk. Full CI runs on all seven environments for platform-sensitive or unclassified changes and on scheduled/manual full runs; standard CI uses the two representative environments for these detailed checks (see [Development workflow](development.md)). The first time the check ran it found two defects no assertion had been written for: mutants in code that only cleanup hooks reach were reported as not covered, and a mutant that ended the process left every mutant of its test file pending. Two reviews then named traps the fixture did not have, and the check confirmed six of them as defects, each now a fixture: code only `afterAll` or the teardown of a shared fixture reaches (reported as static), tests with `retry` or `repeats` and tests that skip themselves (not covered), a loop that a mutant makes long but not endless (timeout), a loop in `beforeAll` counted against the tests' share (timeout), and a file that never finishes loading with a mutant, where the tool itself did not end.
- **The benchmark scopes, in CI.** `bench/truth/` holds what the suites gave for 27,445 mutants of 47 scopes, and `bench/run.ts` fails when a report disagrees with it; `.github/workflows/bench.yml` runs that on Linux and macOS runners. The entries were made on macOS with the test files that reach each mutant; the ten that the first version of the check had written without parentheses, and so wrongly, were made again. One entry carries a note: the miss in hono described under [Limits](limits.md). pinia's own suite does not pass at the pinned commit, so seven of its entries that could not be made again were dropped. A run in which nothing failed but tests that fail with no mutant too counts as passing only if Vitest also had no error that nothing handled: it ends with an error for those while every test passes, its JSON report does not list them, and a reporter of the check's own asks for them. One mutant of solid, rightly reported as killed, was first taken for passing without that.
- **Mutants reported as not covered,** which the earlier checks had left out: the suite passes with each of the 121 in ufo, zustand and immer.

With `--jobs` above 1 the mutants are run in copies of the project next to it. A copy whose tests cannot run there fails every run, and every mutant the report has killed then agrees whatever it does; one whose tests load the original's sources passes every run, and every survivor agrees. Before any mutant, the check runs in each copy the tests for a mutated file, for every one with `--related`, and stops, naming the copy, the file and the probe, unless they pass there with no mutant; with a throw put at the top of the copy's file, fail the same test files as fail with it at the top of the checkout's; and with the throw in the checkout's file, fail none. A test file counts as failed by the throw only where its failure carries the throw's message, so that one failing by itself does not count, and where the two differ both are run again one at a time before the copy is refused. Without `--related` each run is the whole suite, and each copy is probed with one file, which stands for the others only where the tests reach every file alike, as in the fixtures CI makes ground truth for: probing each would be two runs of the whole suite a file in every shard. `node bench/truth.ts probe` makes these probes for every file of a report, with or without `--related`, runs no mutant, and names each file it refuses. From copies of lint-staged, which have no `.git`, the related tests of `lib/assertGitVersion.js` fail with no mutant; from copies of koel, those of `useKoelPlus.ts`, Vite refusing the `?url` import of `@koel-project/projectm-wasm`, outside the copy, so that `visualizers/projectm/index.spec.ts` fails as it loads.

The ground truth made from copies of koel, homepage, tailwindcss, sentry, Shopify CLI, promptfoo and happy-dom before that check was looked over in the logs of its making. Entries reported as survived or not covered that failed in a copy and passed in the checkout alone: 5 of 870 for koel, 1 of 518 for Shopify CLI (with the entries of `archiver.ts`, since left out), 4 of 502 for happy-dom, none of 468 for homepage, 633 for sentry and 280 for promptfoo; tailwindcss's 174 passing entries all passed in copies. No entry the report killed passed in a copy. So the copies ran the tests, but not every file had a run that passed in one: the 55 entries the suite detects in such files, 40 of koel (three of its files among them, where every passing entry had failed in a copy first), 5 of homepage, 7 of sentry and 3 of promptfoo, and the 8 of homepage made in a run of their own, were made again in the checkout alone, and each of the 63 gave what is stored. A copy that loads the original's file leaves no trace in these logs where every entry of the file passes; the three such files, koel's `useNetworkStatus.ts` and sentry's `anr.ts` and `supports.ts`, pass the probes above.

Every scope whose ground truth was made in copies was probed again once the probes asked for the same test files as in the checkout, with two copies and every file the stored entries name: tailwindcss (3 files), happy-dom (4), n8n (4), mikro-orm (6), promptfoo (8), renovate (10), Shopify CLI (10, `archiver.ts` among them, since left out of the scope), homepage (23), sentry (25), vercel/ai in node (50) and in the edge runtime (49), and koel (51). Each file was accepted but four of koel's, `useKoelPlus.ts`, `useLocalStorage.ts`, `usePolicies.ts` and `useVault.ts`, whose related tests fail in a copy with no mutant, Vite refusing the `?url` import above. Their 27 entries, open ones among them, were made again in the checkout alone, and each gave what is stored.

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
