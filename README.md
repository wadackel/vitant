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

Positional arguments are passed to Vitest as test file filters. `--report` writes every mutant with its status as JSON. `--no-clone` starts a worker for every whole-file run instead of copying one (see How it works). `--static` also runs the mutants in code that only runs while a module loads.

"Fresh worker" below means a worker process in which nothing of the project has run, or a copy of one.

| Status | Meaning |
|---|---|
| Killed | A test file failed when run whole, in a fresh worker, with the mutant on from before the file was imported: in a test that had failed with the mutant while trying it with the file to itself, or twice with one of the two runs made while nothing else ran. A worker that dies in such a run counts as the file failing, as it does for Vitest. |
| Timeout | The same, with the file running into a loop or a hang instead of failing. Counted as detected. |
| Survived | Every test file the mutant can change anything in passed, in a fresh worker, with the mutant on from before the file was imported. |
| NoCoverage | No test runs the mutated code. |
| Static | The code only runs while a module loads, and no test or hook reaches it. Not run unless `--static` is given, and then judged like any other. |
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

8. **Every mutant is settled by running test files whole.** A fresh worker runs the file once, as a plain run would, with the mutant on from before the file is imported. A mutant that a test failed on gets the file of that test. If the file fails in that same test, the mutant is killed. A failure in another test settles nothing by itself, so the run does not stop at it while the test that gave the lead is still to come: it goes on as a plain run does, which does not stop at a failure either, and that test failing too settles it. Where it does not come to that, the failure is made once more on the spot by the worker that was copied, and then other evidence is looked for, in rounds of their own once nothing else is left to do: the tests that failed try the mutant, each file with one worker to itself, and so does a test whose lead was made next to other runs of its file; a test that fails with the mutant and passes without it makes the failure already seen count. What is still open after that gets a run of the file while nothing else runs, one file a mutant, the cheapest first. Nor does a lead vouch for a failure of its own test once another lead of that test came to nothing, its file passing with the mutant: a test that fails by chance on a busy machine fails with whatever mutant it is trying, and on a 4-core CI runner one such test of hono, which every mutant of the router reaches, failed once while trying a mutant and once more in the run of the file about once a run. A lead from one test does not vouch for the failure of another: a mutant switched on in the middle of a worker's life can fail a test that the file run whole does not, and with such a lead any other test of the file failing twice on a busy machine would settle it. If the file passes, the lead was wrong and the mutant goes on like any other. A mutant with no lead is run with each test file in which it can change a value, while the file loads, in a test, or in a hook (`beforeAll`, `afterAll`, those that clean up after a test, the teardown of a fixture), a few files first and then the rest: the files whose tests go through most of the mutant's source file while they run, then the cheapest; a failure there is run once more before it counts and ends the search. Which file is cheap says nothing of which one fails: of the 322 test files that load Effect's `Chunk`, one to three fail on most of its mutants, at the median the 181st cheapest, and with the cheapest first 120 mutants that were detected in the end passed 35,500 runs on the way, four fifths of all the time spent on runs of whole files. The file whose tests reach most of `Chunk` is one that fails for 109 of 113 such mutants. Only a mutant that passed every one of its files is reported as survived. Which files those are is read from what each test reached in its run without a mutant, and that run has to be one a plain run could have made: in a worker no mutant had been tried in, and with no test before it that failed there or ran out of time under the probes. A mutant that a test let through can leave the module as no plain run has it, and the tests after it then go another way. In vue such a mutant left an effect active; the one test that fails on `else if (true)` for `else if (__DEV__ && !failSilently)` returned before that line with no mutant on, so its file was not among those the mutant had to pass, and the mutant was reported as survived without ever having been run with it. Files with a test measured in such a worker get a pass with no mutant tried, in which every test has its run; rounds that give only some tests a run, the failed ones their second or those a lost worker left out, used to count as that pass and no longer do. A test that fails with no mutant on is left out of that pass, as it is left out of the runs of the whole file, so that the tests after it are seen as those runs will have them: 27 tests of hono's `streaming.test.tsx` fail under this tool every time, and a test of vue that checks how long a chain of computed values takes fails under the probes more often than not. There are two such passes, and one more whenever a test has since been found to fail. A file that still has a test without such a run is run with every mutant that is left, and the report names it; none of the fifteen scopes checked ends with one. In these runs a loop is not stopped for being long. The count of iterations that ends a loop while tests try mutants only says the loop is longer than it was: a mutant can send it over three million elements that it is through with in milliseconds, and the suite passes. Past its count, a loop goes on until it has also kept the process busy for a second without a pause, or twice what the file takes; a run that waits without using the processor at all, on something a mutant keeps from happening while the file loads, is ended by the clock. A worker that is gone without a word counts as a failure once it has happened twice. Two failures in a row are made within milliseconds of each other, and on a machine that is busy at that moment both can be the machine's: on a 4-core CI runner a test of hono that sleeps a second and checks the time it logged failed twice for a mutant in a router it has nothing to do with, which was the wrong verdict there from the start. So where no test of the file ever failed with the mutant while trying it, the failures being all there is, one of them has to be made in a round of its own, one run at a time with nothing else running. Where a copy of a file ended without a verdict, one more is made with no mutant on, and a file such copies fail twice or do not get through is run in started workers from then on: on macOS the system ends a copy that touches what a native module set up in another thread, hundreds of times over in vite, and each is a run to make again. That saves runs and proves nothing about the copies that pass. A test that fails a file's run with a mutant and passes the next run of the same file with the same mutant fails for reasons of its own, a wait on the clock on a busy machine for one; what such a test fails is not counted, as a verdict or as a lead, and the report names it. A run that such a test ended never reached the tests after it, so its mutant is run again without that test rather than reported as survived. The report is made from these runs alone: what a test found is nowhere in it, and a lead whose record was lost with its worker is tried again rather than taken on trust.
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

Nothing is published yet. The intended shape is one package per platform (`npm/`, in the layout `napi create-npm-dirs` makes), each an optional dependency of the tool so that a package manager installs the one that fits and nobody needs a compiler. Node refuses to run TypeScript sources under `node_modules`, so the package holds JavaScript: `pnpm build` compiles `src/` to `dist/`, and packing does that first. `pnpm test:packed` packs the tool and the addon's package for the platform, installs both next to Vitest into a copy of the fixture project outside the repository, and runs the installed command: every mutant has to come out as from the sources, with runs made in copies, which only happens when the addon is found through its package. The workflow below does that on every platform. By hand the packed tool was also run on immer (Vitest 3) and ufo (Vitest 4), and agreed with the ground truth on every mutant: installed, the code that runs inside the workers is loaded by Node itself and not through Vite, as it is from the sources. One thing is missing: the root package does not list the six as optional dependencies, which it cannot before they are on the registry; that is for the step that publishes to write in.

`.github/workflows/native.yml` builds and tests all six on every push: macOS on arm64 and x64, Linux with glibc and with musl on both. On each, the tests of this repository pass with copies on, and every verdict on the fixture project is checked against the project's own suite (see Checking the verdicts).

On Windows there is no addon and every run is made in a worker started for it. The same workflow runs the tests and the checks of the fixtures on a `windows-2025` runner with Node 24; one test of the fixture, which sends its own process a signal, is left out there. ufo `all` was run there once by hand, on 9 October 2026, and its 746 verdicts agreed with the stored ground truth. No other scope has been run on Windows, `--changed` has not, and nothing has been timed there. Before it was first run there the tool reported every mutant as not covered and ended as if all were well: it compared the path of its runner with the one Vitest hands back, letter for letter, and Vitest writes the separators its own way.

### Around that

14. **Results carry over between runs, on request.** With `--incremental`, a test file's results are reused when every module it loaded last time, its snapshot file, the lock files, the config and the limits are unchanged, and no mutant is new to it. Only the other test files run again. What a test reads from disk in other ways is not tracked, which is why this is opt-in. Which test detected each mutant is remembered separately, under the mutant's file, kind and the text of its line, and survives whatever else changes: on the next run that test gets the mutant first. That only changes the order, so it cannot change a verdict.
15. **Workers are replaced before they use too much memory.** Thousands of repeats accumulate whatever a test leaks, and before Vitest 5 the mock registry keeps every `vi.fn()` alive. Mocks created during an attempt are held weakly, and a worker whose live heap or resident size passes a limit hands its work over to another.
16. **The mutated source is what Vitest loads, not a rewrite of what it loaded.** Other plugins change the source before a transform sees it, `import.meta.env` for one, and the places the mutants were put no longer line up; a transform that then leaves the file alone makes every mutant in it look unreached.
17. **Vitest is kept from giving up.** An error Vitest cannot serialise, an assertion holding a revoked proxy for one, makes it abandon the test, and before Vitest 4 the rest of the suite with it; errors thrown under a mutant are reduced to their message first, and what still gets through is detected and left to a fresh worker. The pool of Vitest 3 answers a worker that ended itself by sending it a teardown message, takes the failed send for another error of that worker, and loops on that for the rest of the run while every other worker waits for it; sends to a worker that is gone are dropped.

## Benchmark

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

Apple M6 (12 cores, 32 GB), Node 24.21.0. StrykerJS was run once, this tool as often as times are shown. The times of this tool were taken before a loop in a whole-file run had to keep the process busy for a second to count as endless; that rule adds about a second of one core for every such mutant, which on this machine took es-toolkit `array` from 24 s to 34 s and hono `router` from 35 s to 40 s.

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

### The three targets added last

Chosen for shapes the first nine do not have, and each run for the first time found something. The last three rows came later, one run each. Two to four runs each on the same machine; the check against the suite is of a sample, spread evenly over the mutants.

| Target and scope | Mutants | This tool | Against the suite | StrykerJS |
|---|---|---|---|---|
| vue `reactivity`: `packages/reactivity/src` | 1,675 | 115 s | 400 checked: 386 agree, none wrong, 14 not judged | does not start: a test fails in its first run |
| solid `reactive`: `src/reactive` | 1,560 | 803 s | 300 checked: 296 agree, none wrong, 4 not judged | 212.3 s, not comparable: see below |
| svelte `sources`: one file of the runtime | 244 | 3,265 s | 69 checked, every survivor among them: all agree | does not start |
| Effect `data`: three modules that nearly every test file imports | 1,507 | 599 s | 40 checked: all agree | not run |
| shiki `transformers`: `packages/transformers/src` | 1,037 | 56 s | 100 checked: 97 agree, none wrong, 3 not judged | not run |
| unocss `core`: `packages-engine/core/src/utils` | 650 | 1 s | 40 checked: all agree | not run |

What they showed, each fixed:

- **The run without the mutant after a failure with it had no limits of its own.** In vue a mutant left a dependency graph built wrong, and the run that was to show whether the test still passes took a billion loop iterations; the worker was silent for over a minute and Vitest gave up on it without stopping it, so the tool never ended. In svelte the same run waited on a promise nothing would settle, for the half minute the project gives a test, hundreds of times. That run is held to the limits of the run with the mutant.
- **Probes make a tight loop some 25 times slower.** A test of solid that takes 0.3 s ran out of its 5 s on its unmutated run and was left out as failing without any mutant. Such a run is made again without probes, and every mutant in the code it reached then counts as one that can change it. Reads of a property written with a dot no longer go through one shared `o[k]` per file, which took solid from 524 s to 474 s.
- **A mutant that leaves a test failing for good** was one more mutant nobody detected, and every test reaching it gave up a worker to it before any file was run: 50 rounds on solid and four files given up on. It is a lead for a whole-file run, like a failure the test did not repeat without the mutant.
- **A test whose unmutated run failed was tried again in a worker where tests before it had tried mutants,** and failed again on what they left. In a file with such a test nothing tries a mutant in that round.
- **A send to a worker that had just died** ended the main process on Vitest 4; **a worker that does not end when asked** kept Vitest waiting at the very end until Node ended the process without a report; **a project's own worker arguments** (`--expose-gc`) were replaced by the tool's.

On solid StrykerJS ran 93 of the 484 tests and reported 420 mutants as covered by none; this tool detects 195 of those and has 102 survive. Its 212 s are for a quarter of the work, and the 103 mutants on which the two disagree between detected and not were not checked against the suite one by one. No time of StrykerJS on these three targets is one to compare with.

Effect is slow for another reason than the rest. Its 146 surviving mutants are in modules that some 300 test files load, and a mutant survives only once it has passed every one of them: 4,800 of the 8,000 whole-file runs and three fifths of their time. It took 1,810 s while the files were tried cheapest first, see item 8 above. Another part goes to 163 runs made with nothing else running, for mutants that fail a file's run without the test that failed having failed on them while trying them; Effect runs every test concurrently, and tests trying mutants there give fewer leads than elsewhere. unocss is fast because there is next to nothing to run: the tests of the package load it as built, and all but eleven of the mutants are covered by no test.

svelte took 941 s before any of this and takes 3,265 s: its two big test files are among those whose runs fail each other, so they run one process at a time, and two rounds of that are 1,385 s and 954 s. Sixteen of its tests used to be left out as failing by chance, and thirteen mutants were reported as killed that the suite passes with; none is now.

solid takes more than twice what it took before the last of those rules (350 s): its tests cannot be run again in a worker, so tests trying mutants say little there, 203 mutants rest on runs of whole files alone, and each gets its run with nothing else running, 1.6 s apiece and one at a time. A project like that pays the full price of the rule.

solid and svelte are slow for the reason excalidraw is: one or two test files that take seconds, run whole for every mutant not caught early (solid: 222 runs of a file that takes 3 s instrumented).

In vue, 13 of the 14 mutants not judged fail the suite: code that only runs while a module loads is not run here (Limits), and in a library that builds its tables at load that is about one mutant in thirty.

### On hosted CI runners

`.github/workflows/bench.yml` runs the same scopes on GitHub's Linux (x64, 4 cores) and macOS (arm64, 3 cores) runners. One run each, in seconds, from the run of 6 October 2026; every report of this tool agreed with the stored ground truth on both. With a third or a quarter of the cores the times are five to nine times those above, for both tools.

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

The first run of this workflow, with a third more workers than cores, reported one or two mutants of hono as killed that the suite passes with: tests that wait on the clock failed twice in a row on the overloaded runner. See Limits, tests that fail now and then.

### Checking the verdicts

`bench/truth.ts` writes each mutant of a report into the source, in parentheses where it stands for an expression and only where that parses to the same tree around it, runs Vitest, and compares: a mutant counts as agreeing when the suite fails or hangs and the report says Killed or Timeout, or the suite passes and the report says anything else. Three things are checked with it:

- **The fixture project, on every push and every platform.** `pnpm test:truth` runs the whole suite of `fixtures/basic` for each of its 143 mutants. The first time it ran it found two defects no assertion had been written for: mutants in code that only cleanup hooks reach were reported as not covered, and a mutant that ended the process left every mutant of its test file pending. Two reviews then named traps the fixture did not have, and the check confirmed six of them as defects, each now a fixture: code only `afterAll` or the teardown of a shared fixture reaches (reported as static), tests with `retry` or `repeats` and tests that skip themselves (not covered), a loop that a mutant makes long but not endless (timeout), a loop in `beforeAll` counted against the tests' share (timeout), and a file that never finishes loading with a mutant, where the tool itself did not end.
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
| vue `reactivity` | the 182 survivors | 181 | 1 real miss, since closed: the mutant was never run with the file that fails on it (item 8 above). The 400 entries kept for CI did not have it |

What the same check found before each of the steps under Deciding existed:

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

## Tuning

| Option | Default | Effect |
|---|---|---|
| `--max-workers` | the number of processors | More than that and tests that wait on the clock fail on a machine that is behind; a third more gave wrong verdicts on hosted CI runners. |
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

- **Copies made after the file has loaded for mutants whose code runs while it loads but could change nothing there,** going by the probes of an unmutated run of the same file, with the copied process checking that its own load evaluated the same sites. Effect was what it was for: 42,000 of its whole-file runs are copies made before the file loads, 275 ms each against 40 ms, because the mutated modules run as every test file loads. It changed nothing: 42,148 such copies after, and no fewer on immer, jotai or vue. The mutants that survive there are of kinds the probes do not follow, a string or a function put in place of another, and a function defined as a module loads is a different function with the mutant on, whatever a probe could say. The verdicts were unchanged on five scopes; the fixture written for it (`limit`) is kept.
- **Making the second run of a failure with no other run of the file under way,** so that a file whose runs always fail each other would show a failure and then a pass. The second runs of a file then stand in one line: 67 s to 85 s on immer, 354 s to 462 s on solid, run in turn with the version before. And it did not reach the one place such failures were seen, in workers started for a run, whose second run comes a round later.
- **A copy with no mutant for every file before its copies are believed.** One run per file and kind of copy, and a file whose copy failed once by chance lost a round of runs: 7–17% on vue under load. It showed no wrong verdict anywhere. Such a copy is made only where one was lost.
- **Running a file in started workers after one failed unmutated copy.** On a busy machine one test failing by chance in that copy took a file of vue out of copying for the rest of the run, 10–30% of the whole time. It takes two such failures.
- **Seeing a failure twice in a round of its own.** With the rule that a lead only settles a failure of its own test, the second run first went to the next round: 110 s to 135–142 s on query, 54 s to 63–65 s on immer, 35 s to 40 s on es-toolkit, though only 6–27% of the detected mutants needed one. A round for a handful of runs costs what its slowest takes. Made on the spot by the worker that was copied, query is back at 109 s; immer stays at 61 s and es-toolkit at 40 s, which is what the rule costs where many mutants fail an earlier test of the file than the one that gave the lead.
- **Going on to the lead's test after another test failed,** so that one run would do: slower again, 147–155 s on query and 68–70 s on immer. The run that stops at the first failure and is made twice is cheaper than the one that goes on.
- **No more trials for a test file whose workers found no lead in a round** (10 s of trials or more). svelte `sources` took 941 s with it and 941 s and 1,205 s without, and four lighter scopes did not change. svelte varies by a quarter between identical runs, so nothing is shown either way, and the rule is not kept.
- **Copies for mutants a test's own limits ended.** A mutant whose loop count or timer ended a test has not blocked a process, so its whole-file run could be a copy like any other. But in that run the loop goes on until it has kept the process busy for a second, and a worker makes its copies one after another: ufo's twelve such mutants took the run from 6.4 s to 9 s. They get workers started for them, which wait side by side.
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
- **A lock left by a worker that was stopped is cleared by its process id.** Where the system gives that id to a new process before the next look, a tenth of a second later, the lock stays and the run does not end. No verdict comes of it. It has not been seen; Windows hands ids out again sooner than the others.
- **Copies of a worker need `fork()`** and the addon for the platform; elsewhere the tool starts a worker per run. A copy shares what the worker had open when it was made: its random number seed, its standard streams, its channel to the main process. Code that kept the process id while the file loaded has the worker's. Where a copy is stopped in the middle of a message to the main process, the rest of the worker's run on that channel is lost and the run does not end; a copy sends none of the long ones. On macOS a copy that blocks outlives a worker that dies before it; on Linux the kernel stops it. Workers run V8 single-threaded when they are to be copied, which makes the tests themselves somewhat slower.
- **Type tests are not run.** Vitest can run a type checker next to the tests, and a mutant that only breaks types fails such a run with every test passing. Type checking is switched off here, as StrykerJS does without its checker plugin.
- **A test file is the unit.** A whole-file run reproduces what a mutant does within one file's run. What tests in one file leave for another file, a `globalSetup`, a server or a file on disk, is outside it. Nor is anything done about two different test files that get in each other's way, over a port or a path both use. A plain run puts files side by side too, so a suite that passes stands the pairs Vitest happens to make; here there are many more runs of other files next to any one. Three ways to a wrong verdict are left by that, none of them seen in the scopes checked against ground truth: a test fails on another file's hold of a port while it tries a mutant, passes without the mutant once the port is free, and fails the same way in the run of its file, and the mutant counts as killed; another file leaves something behind that is not tracked by git, and the run made with nothing else running fails on it as well; a run of another file writes what the mutant should have kept a test from finding, and the file passes. Recording what each run writes and listens on was considered and left: it would change the functions the tests call, would not see what a child process or a native module does, and a path two files share says nothing about harm. What tells is the check that exists: `bench/truth.ts` on a sample of killed and surviving mutants, one run at a time.
- **Tests that are retried, repeated or expected to fail are not asked to try mutants.** A test with `retry` or `repeats` set, or declared with `test.fails`, runs as the project has it, and so does what is left of a test that skips itself; the mutants they reach are settled by whole-file runs alone, as are those in code only `beforeAll`, `afterAll` or a shared fixture reaches.
- **One test file runs in many processes at once,** which a plain run never does. Tests that listen on a port, or write files next to themselves, then get in each other's way. A file in which a run failed and another run with the same mutant passed is taken to be such a file: from then on nothing of it runs in two processes at once, and what ran side by side until then is run again, the runs that passed as well, since a run can pass on what another wrote. Only a test that fails and passes with nothing else of the file under way is left out as failing by chance. A file that nothing but such tests gave away goes back to running side by side: a test that sleeps a second and checks the clock gets in nobody's way, and its file, run one process at a time, took a second a run (hono `utils`). A file whose runs fail each other every time shows no pass to go by, and every mutant in it looks killed. So where a mutant failed twice without a lead, two runs of the file are started at one moment with no mutant on, and if either fails the file is treated the same way. And a lead counts for what it is only when one worker had the file to itself, as in the first round, in a later round that gives the file one worker, or in a file that runs one process at a time: tests trying mutants side by side can fail each other into a lead, and the run of the file that is to check it can fail the same way. A lead from a later round names the file to run and no more, which costs a second run for those mutants: 7% of the time on jotai, 10% on immer, 20% on query. What is left: two runs started together need not meet at the port or the lock they would fight over, and a file with nothing but passing runs and leads of the first round is never asked. The report names the files run one at a time. All of this is per test file. Two test files that share a port or a fixture are run side by side by a plain run as well, but not hundreds of times over, and nothing here sees them fail each other or keeps them apart. That comes too late where the damage stays. vite has tests that rewrite a fixture under version control and put it back when the test ends; two runs at once read each other's half-written state and leave the file broken for every run after them, the tool's own and the project's. After a run on vite two such fixtures differ from the repository. A project whose tests change files they share is not one this tool can judge. What it does is say so: files under version control that do not hold what they held before the run are named in the report, also those someone was already changing, and on vite that is how the run ends. It is also said at the end of the round in which it first happens.
- **Tests that fail now and then.** A failure counts in the test that had failed with the mutant while trying it, or when it has been seen twice, one of the two with nothing else running. A test that failed and passed with the same mutant, nothing else of its file under way, is left out for every mutant once it has done so with mutants in two places of the code; with one, the mutant may be what made the test a matter of chance, and what the test fails for others still counts. What is left: a test that fails by chance even on a quiet machine, twice for one mutant, and the lead that is an artefact of trying a mutant in a worker together with one chance failure of the same test. A test that fails often enough to do so twice in a row before it is caught passing can still kill a mutant it has nothing to do with; the first runs on hosted CI machines, with a third more workers than processors, had one or two such verdicts among 3,000 runs of hono. The number of workers is that of the processors since. With that many workers a 4-core runner still reported one mutant of hono as killed in one run of three, a reversed comparison in a router's sort: three mutants at that place had a lead, and one run of a whole file with a lead was enough then, whichever test failed in it. A lead now only settles a failure of its own test. The report says for every detected mutant which runs and which tests it rests on (`evidence`), and the check against the suite prints that for a verdict it finds wrong; the run in question was made before that, so which test failed is not known. svelte shows the same thing at a larger scale: its two big test files compile a thousand samples to files next to them, copies of a worker that run the same file side by side fail some test now and then, and with the rule as it was 13 of the 69 mutants checked there were reported as killed that the suite passes with. With the rule as it is all 69 agree, 46 of them every mutant reported as survived; sixteen tests are named as failing by chance in that run.
- **A timeout is a judgement.** A mutant counts as timed out when one stretch of a whole-file run keeps the process busy for longer than four times what the file takes plus three seconds, a second for a loop that is past fifty times its iterations, or when the run waits for longer than five times that. A mutant that makes a test take that long and still finish, within the project's own test timeout, is called a timeout here and would pass there.
- **Code that only cleanup hooks reach gets no lead.** While tests try mutants one at a time the mutant is switched off before `afterEach` and the hooks like it, so that it cannot keep them from restoring shared state. A mutant in code that only they run is therefore settled by whole-file runs alone, one per test file whose hooks reach it.
- **Code that only runs while a module loads** and that no test or hook reaches is reported as Static and not run, as StrykerJS does with `ignoreStatic`, unless `--static` is given. That is a choice of cost, not a limit: about four in five of such mutants are detected when they are run (217 of 277 over nine targets), but each takes a run of every test file that loads the module, and one that survives goes through them all. Where such code is one mutant in a hundred the run takes no longer; in pinia and jotai, at one in twenty, half as long again; in vue, where 13 survivors are each run with 180 test files, twice as long. Every verdict it adds in ufo, zustand, immer, jotai and hono agrees with the suite. The run says how many mutants were left out.
- **Tests that only reach code when run at the same time.** Tests marked `concurrent` run one after another while what they reach is recorded; code they only get to because another test is in flight is reported as not covered.
- **`bail` is switched off,** so that one failing run does not call off the others of its round.
- **Skipped runs assume deterministic tests.** If a test takes a different path on each run, a mutant judged harmless in the unmutated run might still have changed something.
- **A mutant that changes which tests a file has** is judged by the first failure of the whole-file run, whatever the tests are then.
- **Tests that read the source from disk.** Mutants live in what Vitest serves, not in the files. A test that reads, builds or lints a source file itself sees the original.
- **Vitest projects.** Projects declared in the root config are handled. A project with a config file of its own is not run: the runner reaches it with the rest of the command line, the plugin that puts the mutants into the sources does not, and its tests would pass every mutant without meeting one. Of a test file that several projects include only the first project's run counts. Type tests run in the type checker and are not run either. What was left out is in the report with its number of test files, and the summary says that the verdicts are not those of the whole suite. Tests that load a package as it was built, as those of unocss do for the package they sit in, do not reach its sources, and mutants there are reported as covered by no test, which is what they are. Browser mode and the `vmThreads` and `vmForks` pools are not handled. The pool is forced to `forks`, and while tests try mutants one at a time, concurrent tests run one after another.
- **No StrykerJS directives.** `// Stryker disable` comments are ignored. The Regex mutator and StrykerJS's statement-removal mutator are missing.
- **Reports.** `--report` writes this tool's own JSON. `--elements` writes what [mutation-testing-elements](https://github.com/stryker-mutator/mutation-testing-elements) displays, as JSON or as a page that loads the viewer from a CDN; it names for a detected mutant the run that failed and not every test that reaches it, and a mutant reported as Static is Ignored there.

## Development

```sh
pnpm test        # unit tests and an end-to-end run against fixtures/basic
pnpm test:truth  # every verdict on fixtures/basic against the suite run with the mutant written in
pnpm test:packed # the tool packed, installed into a copy of the fixture and run from there, against a run from the sources
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
