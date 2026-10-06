# vitant

A proof of concept of a mutation testing tool for TypeScript projects that use Vitest. It has one job: to say for every mutant what the project's own test suite would say if the mutant were in the source for real, and to get there faster than running the suite once per mutant. There is no faster, less careful mode.

It works only with Vitest 3.0 or later, and has been run against 3.0, 3.2, 4.1 and 5.0.

## Usage

Requires Node 24, which runs the TypeScript sources directly. Nothing is installed into the project under test.

```sh
pnpm install
pnpm build:native   # macOS and Linux, needs Rust 1.85 or later; without it the tool works, and is slower

# Mutate files matching a glob in another project
node src/cli.ts --root ../my-app --mutate 'src/**/*.ts' --report report.json

# Mutate only what changed since a git ref, as a pull request check would
node src/cli.ts --root ../my-app --changed origin/main

# Reuse the last run's results for test files that loaded nothing that changed
node src/cli.ts --root ../my-app --changed origin/main --incremental
```

Positional arguments are passed to Vitest as test file filters. `--report` writes every mutant with its status as JSON. `--no-clone` starts a worker for every whole-file run instead of copying one (see How it works).

"Fresh worker" below means a worker process in which nothing of the project has run, or a copy of one.

| Status | Meaning |
|---|---|
| Killed | A test file failed when run whole, in a fresh worker, with the mutant on from before the file was imported: either after a test had failed with the mutant while trying it, or twice. A worker that dies in such a run counts as the file failing, as it does for Vitest. |
| Timeout | The same, with the file running into a loop or a hang instead of failing. Counted as detected. |
| Survived | Every test file the mutant can change anything in passed, in a fresh worker, with the mutant on from before the file was imported. |
| NoCoverage | No test runs the mutated code. |
| Static | The code only runs while a module loads or in `beforeAll`, and no test reaches it. Not run. |
| Pending | The run gave up on a test file before the mutant was settled. |

## How it works

StrykerJS starts a new Vitest run for every mutant, so each mutant pays for a worker, the test environment and the import of the test file. This tool tries the mutants inside workers that are already running, many per worker, to learn which test file is likely to fail on each, and then settles every mutant with as few runs in a fresh worker as that allows: one for a mutant a test failed on, one per test file for a mutant nothing failed on.

### Finding where each mutant is likely to be detected

1. **Mutant schemata.** Every mutant is compiled into the source once, behind a runtime switch: `__vitant__.a === 12 ? a - b : a + b`. Mutants are found with `oxc-parser` and spliced in as text. The mutators and their names follow StrykerJS.
2. **Mutants run inside the test's own worker.** A custom Vitest runner makes each test repeat, with `beforeEach` and `afterEach` around every repeat, turning on one mutant per repeat. The test file is imported once.
3. **A failure is checked against a run without the mutant.** Re-running a test in one process can fail for reasons unrelated to the mutant: state an earlier run left behind, a flaky test. A test that fails with a mutant is run again without it. If it passes, the mutant has a lead: a test file to run whole. If it fails too, the worker's state is no longer trusted and it is replaced.
4. **Runs that cannot change anything are skipped.** During a test's unmutated run, probes compute what each mutated operator, condition or literal would have produced and follow that value through the enclosing arithmetic, comparisons and calls of built-in `Math` functions, for as long as nothing else could have seen it. If the value never differs where that chain ends, the test cannot fail because of the mutant and is not run with it: `Math.round((value + Number.EPSILON) * m) / m` with `-` for `+` almost never rounds differently. Only primitives are recomputed, so no code of the program runs twice. A mutant that replaces a condition with `true` or `false` also drops the evaluation of that condition, so it is only cleared this way when that evaluation was seen, as it ran, to do nothing else: it did not throw, every property and global it read was plain data rather than a getter or a proxy, every operator got primitives, and nothing in it that can run code was reached, which leaves a call the condition short-circuited past, and calls of built-ins such as `Number.isFinite`, `Array.isArray` and `Math.abs` that are still the original functions.
5. **A coverage round, then a plan.** The first round runs every test once, unmutated, to learn what each one reaches; fast tests try their mutants right away. The main process then gives every remaining mutant first to the one test that reaches the most code, which in measurements found a killer first far more often than the cheapest or narrowest test, and only afterwards lets every test try what is left.
6. **Work is cut into chunks that any worker can claim.** A test's mutants are split into chunks of about a quarter second, claimed through lock files, so several workers can share one heavy test and a round ends within one chunk of its work running out. Workers skip the tests they do not drive; a file whose tests turn out to depend on earlier ones is replayed in order instead.
7. **Loops and hangs do not cost a restart.** Instrumented loops count iterations and throw when a mutant run goes far beyond the unmutated count. A hung `await` is abandoned by a timer that waits longer while the test is still using CPU. A mutant that is only slow is left to Vitest's own test timeout. A watchdog thread is the last resort for a mutant that blocks the event loop for good: it measures CPU time, so that a busy machine does not look like a hang, stops the worker after what a run may take, and leaves the mutant to a fresh worker, which calls it a timeout only after five times that. A mutant that ends the process outright is found the same way round: every worker leaves word of the mutant it is about to try, and one that is gone with a mutant named has that mutant left to a fresh worker and the rest of its work shared out again.

### Deciding

What a test does with a mutant inside such a worker is not what the suite would do with it. The mutant is on for that test alone, after a file that loaded without it and tests that ran without it, in a process where the test has already run once. Four things were measured to go wrong, each on a real project (ground truth being the mutant put into the source and the plain suite run):

- **Code that also runs while the test file loads.** immer's tests compute results in `describe` bodies and the tests only compare them; a mutant that is on during the test alone changes nothing they look at.
- **Code that only acts the first time it runs in a process.** immer's plugin registry keeps the first implementation it is given. In a worker where the unmutated run came first, the mutated one is built and dropped.
- **What an earlier mutant left behind.** In es-toolkit, `arr.sort()` for `arr.slice().sort()` returns the same result, so the mutant passes, but it sorts the array a `describe` block shares; every later mutant of the sort then passes on data that is already in order.
- **A failure that only the half-way state produces.** pinia installs its devtools plugin under a condition. With a mutant making that `true` for one test of `ssr.spec.ts`, the test fails, passes again without the mutant, and fails again with it; with the mutant in the source from the start, the file and the whole suite pass.

Nothing the instrumented code can observe tells these apart from an ordinary pass or an ordinary failure. So no verdict comes from inside such a worker:

8. **Every mutant is settled by running test files whole.** A fresh worker runs the file once, as a plain run would, with the mutant on from before the file is imported. A mutant that a test failed on gets the file of that test: if the file fails, by a test, a hook or an error nothing handles, the mutant is killed, and the run stops there. If it passes, the lead was wrong and the mutant goes on like any other. A mutant with no lead is run with each test file in which it can change a value, while the file loads, in a test, or in the hooks that clean up after one, the cheapest files first and a few at a time; a failure there is run once more before it counts and ends the search. Only a mutant that passed every one of its files is reported as survived. The report is made from these runs alone: what a test found is nowhere in it, and a lead whose record was lost with its worker is tried again rather than taken on trust.
9. **Which files those are is measured with no mutant tried.** The unmutated runs of the first round can come after mutants were tried in the same worker and may have seen what one left behind. Before the whole-file runs are planned, such files are gone through once more, untouched.

This costs one run of a test file per detected mutant, cut short at the failure, and one per file for every other mutant. That cannot be shared between mutants without giving up what makes it right: a process that has seen nothing else.

### Making such a process cheap

Started the usual way, such a process costs more than the tests it runs: Node, Vitest's worker and the test environment come to about 0.1 s of CPU time before a test file is even imported, and to 0.45 s with jsdom, where the tests of a file often take a hundredth of that. So the process is not started. It is copied:

10. **A worker that has started up is copied with `fork()`.** A worker that has loaded Vitest and the environment and has run nothing of the project is, for every mutant, what a new worker would be at that point. For each whole-file run it makes a copy of itself, which turns the mutant on, runs the file and ends; the worker waits for it and makes the next. Node has no call for this (`child_process.fork` starts a new process), so a small addon in Rust (`native/src/lib.rs`) calls `fork()` and `uv_loop_fork()`, which gives the copy an event loop of its own.
11. **Once the test file has loaded, for mutants whose code did not run while it did.** A run that had such a mutant on from the start would be, up to the end of loading, the same as one without it. The worker loads the file with no mutant on, checks for each mutant, in its own record of what ran, that the mutant's code did not, and copies itself from there, so the copy pays for neither the start nor the imports. Mutants whose code does run while the file loads get copies made before loading, and so does every mutant of a file that leaves something open while it loads: a file descriptor, a socket, a child process, or a timer, which would be due sooner in each later copy. Copies made afterwards would share it.
12. **A copy has only the thread that made it.** The workers run V8 with `--single-threaded`, so that nothing is left to compiler or garbage collector threads a copy would wait for in vain, and the watchdog thread of item 7 is not started in a worker that copies itself: it applies the same rule to its copies from outside, reading their CPU time. Copies share the worker's channel to the main process, so one is made only when no call of the worker is unanswered and nothing is half written, a copy reports neither its tests nor what they print to Vitest, and it reads its verdict and ends only when none of its own calls is unanswered. A copy is given the process id Node read in the worker, so it is told its own.
13. **Anything unexpected falls back to a worker of its own.** A copy that ends without a verdict, one that sits for three seconds using no CPU time and never returning to its event loop, as one waiting for a thread it does not have would, and one that goes on for several times what the file may take are stopped, and that run is made by a worker started for it. So is a run for which no copy could be made. So is every run of a mutant that has blocked a worker before: a copy that blocks holds up the copies behind it. Where there is no `fork()` (Windows) or the addon is not built, every run is made that way.

macOS makes copies of a process one at a time: sixteen workers copying themselves at once took 54 ms a copy where one alone takes 3 ms, most of it spent waiting inside the kernel. The addon takes a file lock around the call.

On Linux V8 marks the memory it allocates, the JavaScript heap included, as not to be given to a child process (`MADV_DONTFORK`), and a copy made without more ado dies on its first instruction. The addon takes the mark off every mapping of the process before each copy. It cannot tell V8's mark from one another library put on memory of its own for a reason, so such memory is copied as well.

#### The addon

`pnpm build:native` compiles it with `cargo`, for the platform of the Node that runs it, into `build/fork.<platform>-<arch>[-gnu|-musl].node`. The tool looks for that file first and for a package named after the platform second.

Nothing is published yet. The intended shape is one package per platform (`npm/`, in the layout `napi create-npm-dirs` makes), each an optional dependency of the tool so that a package manager installs the one that fits and nobody needs a compiler. Two things are missing for that: the root package does not list them, and it runs its TypeScript sources directly, which Node refuses for files under `node_modules`, so a published tool has to ship JavaScript.

`.github/workflows/native.yml` builds and tests all six on every push: macOS on arm64 and x64, Linux with glibc and with musl on both. On each, the tests of this repository pass with copies on, and every verdict on the fixture project is checked against the project's own suite (see Checking the verdicts).

### Around that

14. **Results carry over between runs, on request.** With `--incremental`, a test file's results are reused when every module it loaded last time, its snapshot file, the lock files, the config and the limits are unchanged, and no mutant is new to it. Only the other test files run again. What a test reads from disk in other ways is not tracked, which is why this is opt-in. Which test detected each mutant is remembered separately, under the mutant's file, kind and the text of its line, and survives whatever else changes: on the next run that test gets the mutant first. That only changes the order, so it cannot change a verdict.
15. **Workers are replaced before they use too much memory.** Thousands of repeats accumulate whatever a test leaks, and before Vitest 5 the mock registry keeps every `vi.fn()` alive. Mocks created during an attempt are held weakly, and a worker whose live heap or resident size passes a limit hands its work over to another.
16. **The mutated source is what Vitest loads, not a rewrite of what it loaded.** Other plugins change the source before a transform sees it, `import.meta.env` for one, and the places the mutants were put no longer line up; a transform that then leaves the file alone makes every mutant in it look unreached.
17. **Vitest is kept from giving up.** An error Vitest cannot serialise, an assertion holding a revoked proxy for one, makes it abandon the test, and before Vitest 4 the rest of the suite with it; errors thrown under a mutant are reduced to their message first, and what still gets through is detected and left to a fresh worker. The pool of Vitest 3 answers a worker that ended itself by sending it a teardown message, takes the failed send for another error of that worker, and loops on that for the rest of the run while every other worker waits for it; sends to a worker that is gone are dropped.

## Benchmark

The benchmark runs StrykerJS 10 and this tool over the same files of nine projects at pinned commits, and checks the verdicts against ground truth: each mutant put into the source for real and the plain suite run on the test files that reach it.

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

```sh
node bench/setup.ts excalidraw        # clone the pinned commit, install it and StrykerJS
node bench/run.ts excalidraw math     # mutate packages/math/src, run both tools, compare verdicts
node bench/run.ts excalidraw pr       # mutate only the lines the pinned commit changed
```

Results are written to `bench/results/<target>-<scope>/`: `summary.json` has the wall-clock times and `compare.txt` how the verdicts line up. StrykerJS runs with `coverageAnalysis: perTest`, `ignoreStatic: true` and no type checker, which is its fastest configuration.

Apple M6 (12 cores, 32 GB), Node 24.21.0. StrykerJS was run once, this tool as often as times are shown.

| Target and scope | Mutants | StrykerJS | This tool | Without copies |
|---|---|---|---|---|
| jotai `vanilla`: `src/vanilla` | 1,160 | 299.9 s | 62.3 s | 204.9 s |
| zustand `all`: `src` | 566 | 38.6 s | 11.9 s | 37.7 s |
| ufo `all`: `src` | 918 | 13.5 s | 5.2 s | 12.3 s |
| es-toolkit `array`: `src/array` | 706 | 61.0 s | 23.7 s | 28.6 s |
| query `core`: `packages/query-core/src` | 2,804 | 254.2 s | 109.0 s | 212.8 s |
| excalidraw `math`: 14 files of `packages/math/src`, exercised by 134 test files | 1,604 | 860.5 s | 496.2 s | 599.4 s |
| excalidraw `pr`: lines the pinned commit changed in 4 application files | 99 | 279.9 s | 161.8 s | 158.6 s |
| immer `all`: `src` | 1,535 | 89.0 s | 58.5 s | 103.2 s |
| pinia `pinia`: `packages/pinia/src` | 1,367 | failed to start | 14.6 s | 47.4 s |
| hono `utils`: `src/utils` | 2,530 | see below | 69.8 s | 92.4 s |
| hono `router`: `src/router` | 1,121 | see below | 38.8 s | 48.2 s |

Each of these is one run. The last column is the same tool starting a worker for every whole-file run (`--no-clone`), measured before copies existed; every mutant has the same verdict in both, apart from the difference of name described under How the verdicts hold up.

Copies remove the start of a worker and, for most mutants, the imports. What is left is the tests. Where they are light that is most of the time gone (jotai, zustand, pinia); where they are heavy it is not: in excalidraw the 1,053 whole-file runs of the mutants nothing detects take a median of 3.6 s of tests each, and in immer, whose whole suite takes under a second, 2,900 copies still each run a test file. macOS also limits it: copying a process is serialised in the kernel, about 3 ms a copy.

StrykerJS finished on hono in 137 s and 190 s but reported nearly every mutant as survived (1,026 of the 1,121 in `router`, 917 of which this tool detects; ground truth agreed on each of the 754 detections it got to), so its times there say nothing. Why was not looked into; hono declares its tests as several Vitest projects.

Started for each run, a worker costs the tests themselves where they are heavy (excalidraw: the heaviest file takes 20 s) and its own start where they are not (jotai: process, Vitest, jsdom and React come to about 1 s a run, against 0.09 s of tests). The workers keep every core busy: 12 workers took as long as 16. The main process uses under a tenth of a core.

### Checking the verdicts

`bench/truth.ts` writes each mutant of a report into the source, in parentheses where it stands for an expression and only where that parses to the same tree around it, runs Vitest, and compares: a mutant counts as agreeing when the suite fails or hangs and the report says Killed or Timeout, or the suite passes and the report says anything else. Three things are checked with it:

- **The fixture project, on every push and every platform.** `pnpm test:truth` runs the whole suite of `fixtures/basic` for each of its 105 mutants. The first time it ran it found two defects no assertion had been written for: mutants in code that only cleanup hooks reach were reported as not covered, and a mutant that ended the process left every mutant of its test file pending.
- **The benchmark scopes, in CI.** `bench/truth/` holds what the suites gave for 6,353 mutants of nine scopes, and `bench/run.ts` fails when a report disagrees with it; `.github/workflows/bench.yml` runs that on Linux and macOS runners. The entries were made on macOS with the test files that reach each mutant; the ten that the first version of the check had written without parentheses, and so wrongly, were made again. One entry carries a note: the miss in hono described under Limits. pinia's own suite does not pass at the pinned commit, so seven of its entries that could not be made again were dropped.
- **Mutants reported as not covered,** which the earlier checks had left out: the suite passes with each of the 121 in ufo, zustand and immer.

### How the verdicts hold up

Against ground truth, counting a mutant as agreeing when both sides detect it or neither does:

| Target and scope | Checked | Agree | The rest |
|---|---|---|---|
| es-toolkit `array` | all 706 judged | 706 | |
| immer `all` | all 1,437 judged | 1,436 | 1 where the check itself was wrong: the mutant text went in without parentheses and regrouped the operators around it. Put in by hand, the suite passes, as reported |
| jotai `vanilla` | all 1,088 judged | 1,086 | 1 where the parentheses turned the line before into a call; 1 where the suite failed without a failing test and was not looked into |
| excalidraw `math` | the 215 survivors | 212 | 3 `&&`/`||` mutants inside longer chains, taken to be the regrouping above and not re-run |
| zustand `all` | all 532 judged | 531 | 1 regrouping again; put in by hand, the suite fails, as reported |
| hono `utils` | the 416 survived or timed out | 415 | 1 real miss: a test builds the source file with esbuild and checks the output (see Limits) |
| hono `router` | 840 of the 1,066 judged | 840 | The check was stopped before it finished |
| ufo `all` | all 850 judged | 850 | |
| pinia `pinia` | all 611 judged | 604 | 5 regroupings, confirmed by hand to pass as reported; 2 that fail only the type tests Vitest runs for this project, which this tool does not run |
| query `core` | the 523 survived or timed out | 518 | 5 regroupings, confirmed by hand |

What the same check found before each of the steps under Deciding existed:

- Survivors judged inside workers: 39 of immer's 269 and 4 of es-toolkit's 44 were wrong, none of excalidraw's 215.
- Kills judged inside workers: 3 of pinia's 460 were wrong, none of about 3,900 in immer, es-toolkit, jotai, zustand and hono.
- Errors nothing handles: 6 of query's mutants and none elsewhere pass every test and fail the run.

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

## Tuning

| Option | Default | Effect |
|---|---|---|
| `--max-workers` | 4/3 of the CPU count | Tests spend part of their time waiting on timers, so a few more workers than cores keep the CPU busy. |
| `--recycle-heap-mb` | half the machine's memory divided by the workers, at most 1,536 | A worker hands over once its live heap passes this, or its resident size passes 1.5 times this. Lower uses less memory and costs more restarts. |
| `--changed <ref>` | | Only mutants whose code lies entirely on lines changed since `ref`. |

Things that turned out to matter, each measured:

- **The pool of Vitest 3 only starts a worker while it has fewer workers than queued files**, so with a few long runs in flight the last, short ones waited although most of the allowed workers were idle. Asking it to keep the full number alive took excalidraw `math` from about 189 s to about 173 s at the time.
- **The same pool loops on a worker that ended itself** (see step 13). On immer, where workers are replaced often, that alone was the difference between 180 s and 55 s.
- **In a round long enough to give every worker several runs, the runs are shuffled** instead of started longest first: a fixed order gives the tests of the last files their turn only when every other test has already tried the same mutants.
- **Node's compile cache is turned on for the workers.** Where a whole-file run is mostly the start of a worker, it took jotai from 171 s to 151 s and immer from 90 s to 81 s.
- **Whole-file runs are not held back where they rarely fail.** They start a few files at a time per mutant so that a detection spares the rest, but every such step ends on its slowest run. Once fifty of them have run with under one in twenty failing, the rest go at once, longest first. With that, one worker per file for the mutant-free pass, no more than two extra workers for a file whose workers had to be replaced, and the limit on trying mutants in passing checked per mutant rather than per test, immer went from about 95 s to 72 s, hono `utils` from 107 s to 83 s and excalidraw `pr` from about 147 s to 127 s.
- **A worker that blocks is stopped after what a run may take, not five times that.** immer has a mutant that never returns from an iterator; waiting for it took 90 s of a run that now takes that long in total.

## Measured and dropped

Ideas that were implemented, measured on the benchmark, and removed because they did not pay off:

- **Copies made at the first test that runs a mutant's code.** The worker went through the file's tests with no mutant on and copied itself, for each mutant, just before the test recorded as the first to reach it, so that the tests before it ran once and not once per mutant. Verdicts were the same on every target and CPU time fell by a tenth on excalidraw `math`, but no run got shorter (498 s against 496 s, immer 68 s against 62 s): a worker makes its copies one after another, and the tests most mutants are first reached by come early in a file.
- **Copies made the moment a mutant's code first runs while a file loads**, in place of copies made before loading. Each site was marked before its switch was read, and the worker, loading with no mutant on, copied itself on the first mark of a site that had runs waiting. Verdicts were the same on every target and no run got shorter: in immer, where half the mutants run while some test file loads, 538 of 2,863 runs were made this way and the rest were copies made after loading already.
- **Dropping the round in which every test tries what is left**, now that a whole-file run is a copy. Verdicts were the same; the other targets ran between as long and a seventh shorter, excalidraw `math` went from 498 s to 560 s. A whole-file run remains a costly way to find the test that fails where the tests are heavy.
- **Keeping workers alive between files** (`isolate: false` after the first round) to save re-importing the application. With Vitest 3.0, every file after the first in a reused worker collected no tests at all.
- **Comparing results of side-effect-free functions.** The unmutated run called each such function again with each mutant on and skipped the test if every call returned the same. It ruled out 22% of the pairs it checked, while the first round grew from 27 s to 174 s.
- **Sharing one run among same-site mutants with identical value traces.** At most 5% of survive runs could have been saved.
- **Capping the tests tried per mutant.** Trying even the ten cheapest covering tests first finds the killer for only 42–63% of killed mutants, so a cap would turn kills into survivors.
- **Evening out when each test gets its turn within a file.** A kill matrix of the 174 `math` mutants detected after the coverage round showed that tests ran them 5,047 times without killing, where trying the tests in random order would expect 2,171: the tests at the end of long files run last, and a mutant only they can kill has been run by every other test by then. Cutting each file into stretches taken in shuffled order brought that down to 3,369 in one run and 4,938 in the next, with no gain in time, and unbalanced the `pr` scope. Starting each file's workers at staggered places instead was slower on both scopes. Shuffling whole worker runs in long rounds, which was kept, brings it to about 3,800.
- **Trying likely killers first.** On the same matrix, ordering tests by how many other mutants they kill does worse than random for the mutants that are hard to kill (302 s of test time against 219 s), and no test that killed a neighbouring mutant earlier turned out to be the killer of one that wasted runs.
- **Trying mutants only after a coverage round that tries none**, so that no test's unmutated run comes after a mutant. Verdicts were the same on all four targets, and excalidraw `math` took 596 s instead of 497 s: the mutants that fast tests detect in passing then need workers of their own. Going through the files once more before the whole-file runs costs about 16 s there.
- **Skipping the round in which every test tries what is left** and sending those mutants straight to whole-file runs. The same verdicts; immer and jotai gained 2 s to 4 s, excalidraw `math` went from 485 s to 615 s, because a whole-file run is a costly way to find a test that fails.
- **Checking a pass or an uncertain failure in a fresh worker with the mutant on only during the test in question.** The whole-file run with the mutant on from the start settles the same cases and the ones this missed, so the separate check, and the status for what it left open, were removed with no verdict changing.
- **The `vmForks` pool.** Workers that keep their process and get a fresh VM context per file ran the plain suite in 20.5 s instead of 25.1 s, but 15 of the benchmark's tests fail under it, and a pool that changes what tests do changes verdicts.
- **Telling workers where served modules are on disk**, so that they do not ask the main process for each one (Vitest before 4). Startup went from 1.4 s to 1.1 s per worker and the runs got no shorter.
- **Two or three first tries per mutant.** Giving each mutant to its top tests by reached code at once left fewer killable mutants for the main round (`math` 163–168 s against about 173 s) and added work where the first try already kills most (`pr` 64.5 s against 63.1 s). It also moved three mutants from Killed to Timeout, since two tests now reach a mutant at once.
- **A higher threshold for running mutants during the coverage round** (`--cheap-ms`): 40 and 60 ms were within noise of 20 ms, and from 80 ms on files ran out of their budget in the first round and the run took several times longer.
- **Other orders of worker runs**: files with a single run first, a few workers reserved for short runs. Each was slower.
- **More workers for small rounds.** Letting a round with 12 s of work use all 16 workers instead of 6 made it longer (5.5 s to 6.6 s): each worker imports the application first.
- **A V8 code cache for the modules Vitest evaluates itself**, compiled with `cachedData`: startup of an excalidraw worker went from 1.4 s to 1.3 s and the coverage round stayed where it was.

Run with 4, 32 and 48 workers on 12 cores, zustand, hono `router`, ufo, jotai, query and pinia give the verdicts of the 16-worker run for every mutant but that difference of name: one of jotai's 1,160 and at most three of query's 2,804 change between Killed and Timeout, and none moves between detected and survived.

### Whether the switches change the code they sit in

Everything above assumes that code with no mutant on behaves like the code it was made from. `bench/conformance.ts` checks that against [test262](https://github.com/tc39/test262): each test that runs as a strict-mode script is run as it is and instrumented, and the two must end the same way.

```sh
git clone --depth 1 https://github.com/tc39/test262 bench/.work/test262
node bench/conformance.ts bench/.work/test262
```

Of 36,071 tests that got at least one mutant, 36,045 end the same. The 26 that do not:

- 20 compare what `Function.prototype.toString` returns, which is the instrumented text (see Limits).
- 6 run into the check's two-second limit; without it they pass.

One more takes the process down and is skipped. The first run of this check had 95 differences, and five kinds of them were defects: internal lists that went through accessors a test had put on `Array.prototype`, arrow functions in class fields losing their name, `(a?.b)()` and method calls on `Object` or `Math` losing their receiver, and functions holding `var x` next to `function x() {}` no longer parsing.

With `CONFORMANCE_MUTANTS=3` the check also turns on up to three mutants per test, taken from the code the test runs, and compares each with the test's text with the mutant written into it. Over `test/language`, 16,174 tests with a mutant, that found one kind of mutant a switch cannot stand in for: a block emptied in the source takes its `var` declarations with it, so code after it that reads one fails for the name not existing, while a switch only skips the block and the declarations stay. In 7 of 21 such tests the written mutant failed and the switched one passed. Blocks that declare a `var` are no longer emptied, other than function bodies, which keep their declarations to themselves. The differences that remain are messages: the engine words its own errors after the text of the code, and tests print functions.

## Limits

- **`Function.prototype.toString` returns the instrumented text.** A test that compares a function's source, or a library that parses it, sees the switches. So does a test that expects the exact wording of an error the engine raises, `x.y is not a function` for one: the wording follows the text of the code.
- **A block that declares a `var` is not emptied.** See above; StrykerJS does make that mutant.
- **Copies of a worker need `fork()`** and the addon for the platform; elsewhere the tool starts a worker per run. A copy shares what the worker had open when it was made: its random number seed, its standard streams, its channel to the main process. Code that kept the process id while the file loaded has the worker's. Where a copy is stopped in the middle of a message to the main process, the rest of the worker's run on that channel is lost and the run does not end; a copy sends none of the long ones. On macOS a copy that blocks outlives a worker that dies before it; on Linux the kernel stops it. Workers run V8 single-threaded when they are to be copied, which makes the tests themselves somewhat slower.
- **Type tests are not run.** Vitest can run a type checker next to the tests, and a mutant that only breaks types fails such a run with every test passing. Type checking is switched off here, as StrykerJS does without its checker plugin.
- **A test file is the unit.** A whole-file run reproduces what a mutant does within one file's run. What tests in one file leave for another file, a `globalSetup`, a server or a file on disk, is outside it.
- **Code that only cleanup hooks reach gets no lead.** While tests try mutants one at a time the mutant is switched off before `afterEach` and the hooks like it, so that it cannot keep them from restoring shared state. A mutant in code that only they run is therefore settled by whole-file runs alone, one per test file whose hooks reach it.
- **Code that only runs while a module loads or in `beforeAll`** and that no test reaches is reported as Static and not run, as StrykerJS does with `ignoreStatic`.
- **Skipped runs assume deterministic tests.** If a test takes a different path on each run, a mutant judged harmless in the unmutated run might still have changed something.
- **A mutant that changes which tests a file has** is judged by the first failure of the whole-file run, whatever the tests are then.
- **Tests that read the source from disk.** Mutants live in what Vitest serves, not in the files. A test that reads, builds or lints a source file itself sees the original.
- **Vitest projects.** Projects declared in the root config are handled. A project with a config file of its own is not run, and of a test file that several projects include only the first project's run counts; the tool names the projects it left out. Browser mode and the `vmThreads` and `vmForks` pools are not handled. The pool is forced to `forks`, and while tests try mutants one at a time, concurrent tests run one after another.
- **No StrykerJS directives.** `// Stryker disable` comments are ignored. The Regex mutator and StrykerJS's statement-removal mutator are missing.
- **Reports.** Output is this tool's own JSON; there is no `mutation-testing-elements` report yet.

## Development

```sh
pnpm test        # unit tests and an end-to-end run against fixtures/basic
pnpm test:truth  # every verdict on fixtures/basic against the suite run with the mutant written in
pnpm typecheck
```

| Path | Contents |
|---|---|
| `src/mutate/` | Mutators, placement of the runtime switches, probes |
| `src/runtime/runner.ts` | The runner mixin that executes inside Vitest workers |
| `src/run.ts` | Starts Vitest, plans rounds, aggregates results |
| `src/session.ts` | Files shared between the main process and the workers |
| `src/cache.ts` | What a run stores for `--incremental` and when it still holds |
| `native/` | The addon that copies a worker process, in Rust, and its build script |
| `npm/` | One package per platform for the built addon |
| `fixtures/basic/` | A small project whose tests each pin down one way a verdict can go wrong |
| `bench/` | Benchmark targets, setup, runner and verdict comparison; `truth.ts` checks a report against the suite itself, `conformance.ts` instrumented code against test262 |
