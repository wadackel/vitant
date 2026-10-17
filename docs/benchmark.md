# Benchmark

What StrykerJS and vitant take on the same files of real projects at pinned commits, and how the verdicts were checked against the suite.

The benchmark runs StrykerJS 10 and this tool over the same files of twelve projects at pinned commits, and checks the verdicts against ground truth: each mutant put into the source for real and the plain suite run on the test files that reach it.

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

The times that are kept up to date are those under "On hosted CI runners" below. The tables before it are of one machine at the time each target was added, and say what a rule cost or gained there. Apple M6 (12 cores, 32 GB), Node 24.21.0. StrykerJS was run once, this tool as often as times are shown. The times of this tool were taken before a loop in a whole-file run had to keep the process busy for a second to count as endless; that rule adds about a second of one core for every such mutant, which on this machine took es-toolkit `array` from 24 s to 34 s and hono `router` from 35 s to 40 s.

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

## On hosted CI runners

`.github/workflows/bench.yml` runs the same scopes on GitHub's Linux (x64, 4 cores) and macOS (arm64, 3 cores) runners, and these are the times that are kept up to date. In seconds, the median of three runs, from the runs of 13 October 2026; every report of this tool agreed with the stored ground truth on both. StrykerJS and this tool ran one after the other in the same job, so a row compares the two on one machine. Between rows it does not: a job gets whichever processor is free (an EPYC 7763, 9V45 or 9V74 or a Xeon 8573C on Linux), and the same scope takes visibly longer on one than on another.

| Target and scope | Linux: StrykerJS | This tool | macOS: StrykerJS | This tool |
|---|---|---|---|---|
| ufo `all` | 65.4 | 17.7 | 51.9 | 20.4 |
| zustand `all` | 252.8 | 78.3 | 222.2 | 81.5 |
| es-toolkit `array` | 346.3 | 89.5 | 362.5 | 100.1 |
| es-toolkit `pr`: lines the pinned commit changed | 39.1 | 30.3 | 25.8 | 24.8 |
| immer `all` | 692.4 | 549.7 | 521.7 | 362.3 |
| jotai `vanilla` | 1,996.4 | 460.3 | 1,563.2 | 369.5 |
| query `core` | 1,580.5 | 443.0 | 1,436.3 | 429.7 |
| valibot `schemas` | 1,023.9 | 237.9 | 939.8 | 205.5 |
| xstate `core` | 656.9 | 416.1 | 809.4 | 466.4 |

Against StrykerJS that is, on Linux and on macOS, 4.3 and 4.2 times as fast on jotai, 4.3 and 4.6 on valibot, 3.7 and 2.5 on ufo, 3.6 and 3.3 on query, 3.2 and 2.7 on zustand, 3.9 and 3.6 on es-toolkit `array`, 1.6 and 1.7 on xstate, and 1.3 and 1.4 on immer. On the few changed lines of es-toolkit `pr` it is 1.3 times as fast on Linux and as fast on macOS, where the second of StrykerJS's three runs ended with an error after 6.3 s and the other two took 25.8 and 30.1 s.

The two rows of es-toolkit are of three later runs the same day. In the runs before them the benchmark had put the link that lets the project import itself by name into the project's own `node_modules`, which its config does not leave out of the test files, and this tool, like a plain run there, found every test file twice; StrykerJS runs in a copy of the project, where the files behind the link are not related to what was mutated, and ran each once. With each file found twice, `array` took this tool 124.8 and 160.2 s and `pr` 64.8 and 42.1 s. The same later runs have a process that was copied for every run of a file not load the file itself afterwards.

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

`bench/truth.ts` writes each mutant of a report into the source, in parentheses where it stands for an expression and only where that parses to the same tree around it, runs Vitest, and compares: a mutant counts as agreeing when the suite fails or hangs and the report says Killed or Timeout, or the suite passes and the report says anything else. Three things are checked with it:

- **The fixture project, on every push and every platform.** `pnpm test:truth` runs the whole suite of `fixtures/basic` for each of its 210 mutants. The first time it ran it found two defects no assertion had been written for: mutants in code that only cleanup hooks reach were reported as not covered, and a mutant that ended the process left every mutant of its test file pending. Two reviews then named traps the fixture did not have, and the check confirmed six of them as defects, each now a fixture: code only `afterAll` or the teardown of a shared fixture reaches (reported as static), tests with `retry` or `repeats` and tests that skip themselves (not covered), a loop that a mutant makes long but not endless (timeout), a loop in `beforeAll` counted against the tests' share (timeout), and a file that never finishes loading with a mutant, where the tool itself did not end.
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
