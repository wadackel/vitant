import path from 'node:path'

// Projects the benchmark runs against. Each is pinned to a commit so numbers
// stay comparable between runs.

export type Scope =
  /** Globs of files to mutate, relative to the project root. */
  | { mutate: string[] }
  /** Mutate only the lines changed since this git ref, as a pull request check would. */
  | { changed: string }

export interface Target {
  repo: string
  commit: string
  /** Shell commands that install the project's own dependencies; `$VITANT_BENCH` is this directory, for files kept here. */
  install: string[]
  /** Shell command that adds StrykerJS to the project. */
  installStryker: string
  /** Files Stryker cannot copy and that the selected tests do not use. */
  strykerIgnore?: string[]
  /** Use the checkout when Stryker's sandbox cannot rewrite the project's TypeScript configuration. */
  strykerInPlace?: boolean
  /** The pool StrykerJS's Vitest runner runs the tests in, where its default, `threads`, does not run the suite. */
  strykerPool?: 'forks'
  /**
   * Start StrykerJS with `npx --force`, for a project whose `devEngines` names another package manager: npm refuses
   * to run there otherwise, and with `--force` it warns instead. Not for every target: it also hands
   * `npm_config_force=true` to the tests StrykerJS runs.
   */
  strykerForce?: boolean
  /**
   * Why StrykerJS is not run on this target, where a run of it does not end within the workflow's job: the
   * job's limit would end this tool's run with it, which comes after. `bench/run.ts` records the reason in its place.
   */
  strykerSkip?: string
  /** The package to run in, for a repository that holds several. */
  dir?: string
  /** The Vitest projects to run, where the others need what the benchmark does not set up, a browser for one. */
  projects?: string[]
  /** Test file filters, as Vitest takes them, for the same reason. */
  filters?: string[]
  /** The Vitest config file, relative to the project, where the suite is not run with the one Vitest finds by itself. */
  config?: string
  /**
   * Variables to set, or with null to remove, for the install, both tools and
   * every run of ground truth, which otherwise sets `CI`: a project's config
   * or tests can depend on them, as one that reports differently under `CI`.
   * Without `CI` Vitest writes snapshots it has not seen and passes, where
   * this tool fails: such a target takes `--update=none` in `truthArgs`
   * (Vitest 4 and later; Vitest 3 takes any value of it for `all`).
   */
  env?: Record<string, string | null>
  /**
   * Put the project's own `node_modules/.bin` first on PATH for the install,
   * both tools and every run of ground truth, as a package script does: for a
   * suite that starts a tool by its name, which neither tool nor Vitest
   * started directly would otherwise find. Unlike a package script it adds
   * none of the directories above the project, a workspace root among them.
   * `env` cannot do it, its values being fixed strings.
   */
  binOnPath?: boolean
  /**
   * Vitest arguments for ground truth alone: what the project's config turns
   * on that both tools turn off and that fails the suite by itself, as a
   * coverage threshold or a type check, or that only slows each run, as
   * coverage the config turns on.
   */
  truthArgs?: string[]
  /**
   * Minutes after which `bench/run.ts` ends a run of this tool as one that
   * hangs, where they are more than its `--limit`: for a scope whose run
   * takes most of the workflow's limit on the fastest runners, so that one
   * on a runner half as fast is still let finish.
   */
  limit?: number
  scopes: Record<string, Scope>
}

/** What a target adds to a Vitest command line, and to this tool's, which takes the same. */
export function vitestArgs(target: Target): string[] {
  return [
    ...(target.config ? ['--config', target.config] : []),
    ...(target.projects ?? []).flatMap((project) => ['--project', project]),
    ...(target.filters ?? []),
  ]
}

/** `base` with the target's variables set and removed, and with `node_modules/.bin` of the project in `dir` first on PATH where the target asks for it. */
export function targetEnv(
  target: Pick<Target, 'env' | 'binOnPath'>,
  { dir, base = process.env }: { dir: string; base?: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const [name, value] of Object.entries(target.env ?? {})) {
    if (value === null) delete env[name]
    else env[name] = value
  }
  if (target.binOnPath) {
    // A copy of Windows' environment keeps the case PATH was set with, often `Path`: reading `env.PATH` there finds nothing and drops the PATH the process had.
    const name = (process.platform === 'win32' && Object.keys(env).find((key) => key.toUpperCase() === 'PATH')) || 'PATH'
    env[name] = [path.join(dir, 'node_modules', '.bin'), env[name]].filter(Boolean).join(path.delimiter)
  }
  return env
}

const stryker = '@stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0'

// The two configs of vercel/ai's `packages/ai`, which `vitest.config.js` makes with a function it exports.
const vercelAi: Omit<Target, 'config' | 'scopes'> = {
  repo: 'https://github.com/vercel/ai',
  commit: '8ba3940d3dd1f3cd3c4365bbaec505c6ef0eb1e3',
  dir: 'packages/ai',
  install: [
    'ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@12.14.0 install --frozen-lockfile',
    // As the repository's `test` task builds first: the tests import the workspace packages from their builds,
    // and one compiles a declaration against the package's own.
    "npx -y pnpm@12.14.0 exec turbo build --filter='ai...'",
  ],
  installStryker: `cd packages/ai && npx -y pnpm@12.14.0 add -D ${stryker}`,
  // A mutant that breaks only types fails the suite's type check, which this tool does not run.
  truthArgs: ['--typecheck.enabled=false'],
}

export const targets: Record<string, Target> = {
  excalidraw: {
    repo: 'https://github.com/excalidraw/excalidraw',
    commit: 'ed10ac7dca7e40f3f4a31269b4bfba980d0db41e',
    install: ['npx -y yarn@1.22.22 install --frozen-lockfile'],
    installStryker: `npx -y yarn@1.22.22 add -W -D ${stryker}`,
    scopes: {
      math: { mutate: ['packages/math/src/**/*.ts'] },
      // A few files of the scope above: what makes it slow, in minutes.
      angle: { mutate: ['packages/math/src/angle.ts', 'packages/math/src/utils.ts'] },
      element: { mutate: ['packages/element/src/**/*.ts'] },
      // The pinned commit itself: a feature touching App.tsx and three other files.
      pr: { changed: 'HEAD~1' },
    },
  },
  // Vitest 4, node environment: hundreds of small spec files next to the functions they test.
  'es-toolkit': {
    repo: 'https://github.com/toss/es-toolkit',
    commit: '43e1118884e07cebdf1e767038f6e7f697fa27ec',
    // The project links with Plug'n'Play; this tool needs a `node_modules` to
    // put its runner in and to resolve Vitest from. The sources import the
    // package by its own name, which only Plug'n'Play resolves by itself.
    // The link for it goes one directory up: the project's config does not
    // leave `node_modules` out of its test files, and through a link inside
    // the project every one of them is found a second time, which a run in
    // a copy of the project, as StrykerJS makes, drops again and one in
    // place does not.
    install: ['YARN_NODE_LINKER=node-modules corepack yarn install --immutable'],
    installStryker: `YARN_NODE_LINKER=node-modules corepack yarn add -D ${stryker} && mkdir -p ../node_modules && ln -sfn "$PWD" ../node_modules/es-toolkit`,
    scopes: {
      array: { mutate: ['src/array/*.ts'] },
      all: { mutate: ['src/**/*.ts'] },
      // The pinned commit itself, as a pull request would be run.
      pr: { changed: 'HEAD~1' },
    },
  },
  // Vitest 5, jsdom: React components rendered with Testing Library.
  jotai: {
    repo: 'https://github.com/pmndrs/jotai',
    commit: '6abd0ae3365e02ab432fba4b6e8e6f00aafbf508',
    install: ['npx -y pnpm@11.3.0 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@11.3.0 add -D -w ${stryker}`,
    scopes: {
      vanilla: { mutate: ['src/vanilla/**/*.ts'] },
      all: { mutate: ['src/**/*.ts', 'src/**/*.tsx'] },
    },
  },
  // Vitest 5, node environment: a web framework with a test file per module and many middleware tests.
  hono: {
    repo: 'https://github.com/honojs/hono',
    commit: '08a023cbfde55b434fb0fb30fae35d42e4bf20aa',
    install: ['npx -y pnpm@12.6.0 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@12.6.0 add -D -w ${stryker}`,
    scopes: {
      router: { mutate: ['src/router/**/*.ts'] },
      utils: { mutate: ['src/utils/**/*.ts'] },
    },
  },
  // Vitest 4, jsdom: a small state library whose tests render React components.
  zustand: {
    repo: 'https://github.com/pmndrs/zustand',
    commit: 'd7a5583cffd80af515f7dfb69583c95cbdc9e2ce',
    install: ['npx -y pnpm@11.3.0 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@11.3.0 add -D -w ${stryker}`,
    scopes: {
      all: { mutate: ['src/**/*.ts'] },
    },
  },
  // Vitest 4, a package of a pnpm workspace: tests lean on fake timers.
  query: {
    repo: 'https://github.com/TanStack/query',
    commit: 'f9fe54c960ffe39affe89a7b3dd8a69e6b194fda',
    dir: 'packages/query-core',
    install: ['npx -y pnpm@12.4.2 install --frozen-lockfile'],
    installStryker: `cd packages/query-core && npx -y pnpm@12.4.2 add -D ${stryker}`,
    scopes: {
      core: { mutate: ['src/**/*.ts'] },
    },
  },
  // Vitest 4, Vue with happy-dom, one package of a workspace run from its root config.
  pinia: {
    repo: 'https://github.com/vuejs/pinia',
    commit: '98587ca465b2c45e4053548261e769cad380ba5a',
    install: ['npx -y pnpm@11.21.0 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@11.21.0 add -D -w ${stryker}`,
    scopes: {
      pinia: { mutate: ['packages/pinia/src/**/*.ts'] },
    },
  },
  // Vitest 4, node environment: one module and a handful of test files.
  ufo: {
    repo: 'https://github.com/unjs/ufo',
    commit: 'f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6',
    install: ['npx -y pnpm@10.33.2 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@10.33.2 add -D ${stryker}`,
    scopes: {
      all: { mutate: ['src/**/*.ts'] },
    },
  },
  // Vitest 2.1, older than anything else here.
  radashi: {
    repo: 'https://github.com/radashi-org/radashi',
    commit: 'f5aa29af1e950564baec17f100164625692c1285',
    install: ['npx -y pnpm@10.29.3 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@10.29.3 add -D ${stryker}`,
    scopes: {
      all: { mutate: ['src/**/*.ts'] },
    },
  },
  // Vitest 4, a monorepo run from its root config: threads as the pool, a
  // setup file whose hooks fail a test for a warning nobody asserted, one
  // project that starts its workers with `--expose-gc`. The two projects
  // left out drive a browser.
  vue: {
    repo: 'https://github.com/vuejs/core',
    commit: '4ab865a848a1da3d10fb674f857e5fff13094644',
    install: ['npx -y pnpm@12.4.2 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@12.4.2 add -D -w ${stryker}`,
    projects: ['unit', 'unit-gc', 'unit-jsdom'],
    scopes: {
      reactivity: { mutate: ['packages/reactivity/src/**/*.ts'] },
      // The pinned commit itself, as a pull request would be run.
      pr: { changed: 'HEAD~1' },
    },
  },
  // Vitest 4: two test files register over a thousand sample directories
  // each as tests, compile every sample to files next to it and import
  // those. The file left out starts a browser.
  svelte: {
    repo: 'https://github.com/sveltejs/svelte',
    commit: '10fdca7d705081cae17bf7d609d46ee6eb237d17',
    install: ['npx -y pnpm@10.33.4 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@10.33.4 add -D -w ${stryker}`,
    scopes: {
      // One file of the runtime: the two big test files run whole for every mutant that is not caught early.
      sources: { mutate: ['packages/svelte/src/internal/client/reactivity/sources.js'] },
      reactivity: { mutate: ['packages/svelte/src/internal/client/reactivity/*.js'] },
    },
  },
  // Vitest 4, one package of a workspace: every test file in one worker
  // without isolation, so what a file leaves in a module is there for the next.
  solid: {
    repo: 'https://github.com/solidjs/solid',
    commit: 'b25c557754f2ced0d86490e6dbfded9b1745b663',
    dir: 'packages/solid',
    install: ['npx -y pnpm@9.15.0 install --frozen-lockfile'],
    installStryker: `cd packages/solid && npx -y pnpm@9.15.0 add -D ${stryker}`,
    scopes: {
      reactive: { mutate: ['src/reactive/*.ts'] },
      // A few files of the scope above: what makes it slow, in minutes.
      scheduler: { mutate: ['src/reactive/scheduler.ts', 'src/reactive/observable.ts'] },
    },
  },
  // Vitest 5, a monorepo of some forty projects in one config: every test
  // runs concurrently, through an API of the library's own that runs each
  // as a fiber under a test clock.
  effect: {
    repo: 'https://github.com/Effect-TS/effect',
    commit: '2131d44bd105766994201d3ffa3e180c0d33f655',
    install: ['npx -y pnpm@11.20.0 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@11.20.0 add -D -w ${stryker}`,
    projects: ['effect'],
    scopes: {
      data: { mutate: ['packages/effect/src/Duration.ts', 'packages/effect/src/Chunk.ts', 'packages/effect/src/Option.ts'] },
      // A few files of the scope above: what makes it slow, in minutes.
      option: { mutate: ['packages/effect/src/Option.ts'] },
    },
  },
  // Vitest 5, no isolation between test files, and tests that run the
  // bundler itself: the packages have to be built before any test passes.
  // Not a target the tool can judge, see docs/limits.md: tests rewrite
  // fixtures under version control, and runs of one file side by side leave
  // them broken. `git checkout -- packages` before and after a run.
  vite: {
    repo: 'https://github.com/vitejs/vite',
    commit: '8a4c19cfc035f2dd203f2fa6d00ab9256a5e77c9',
    install: ['npx -y pnpm@12.9.1 install --frozen-lockfile', 'npx -y pnpm@12.9.1 build'],
    installStryker: `npx -y pnpm@12.9.1 add -D -w ${stryker}`,
    scopes: {
      utils: { mutate: ['packages/vite/src/node/utils.ts'] },
    },
  },
  // Vitest projects given as paths of config files, the root config among
  // them: two of the three are left out and reported. The tests of a
  // package load it as built, so most mutants of its sources are covered
  // by no test, which the suite with the mutant written in confirms.
  unocss: {
    repo: 'https://github.com/unocss/unocss',
    commit: '8ac20a464f0f36e56243ffa9df0eddb731c254da',
    install: ['npx -y pnpm@12.4.2 install --frozen-lockfile', 'npx -y pnpm@12.4.2 build'],
    installStryker: `npx -y pnpm@12.4.2 add -D -w ${stryker}`,
    scopes: {
      core: { mutate: ['packages-engine/core/src/utils/*.ts'] },
    },
  },
  // Vite plugins in the root config (WebAssembly inlined, Svelte), sources
  // of other packages reached through aliases, and snapshot files by the hundred.
  shiki: {
    repo: 'https://github.com/shikijs/shiki',
    commit: 'f7d0167873fd676fe4e190bc9b53832fba9ee01d',
    install: ['npx -y pnpm@12.8.1 install --frozen-lockfile', 'npx -y pnpm@12.8.1 build'],
    installStryker: `npx -y pnpm@12.8.1 add -D -w ${stryker}`,
    scopes: {
      transformers: { mutate: ['packages/transformers/src/**/*.ts'] },
    },
  },
  // Vitest 3.2, node environment: a few large test files.
  immer: {
    repo: 'https://github.com/immerjs/immer',
    commit: '8848a5b16938e5681a890d73de7bda24b5080498',
    install: ['npx -y yarn@1.22.22 install --frozen-lockfile'],
    installStryker: `npx -y yarn@1.22.22 add -D ${stryker}`,
    scopes: {
      all: { mutate: ['src/**/*.ts'] },
      // The pinned commit itself, as a pull request would be run.
      pr: { changed: 'HEAD~1' },
    },
  },
  // State machines and actors, with tests that wait on real timers. One of
  // sixteen projects the root config names by the path of their own configs,
  // which the tool cannot be put into: it is run from the package instead.
  xstate: {
    repo: 'https://github.com/statelyai/xstate',
    commit: 'da4c74efa441dd3a4c1d9835c42c3d1f87cdcaba',
    install: ['npx -y pnpm@10.34.5 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@10.34.5 add -D -w ${stryker}`,
    dir: 'packages/core',
    scopes: {
      core: { mutate: ['src/stateUtils.ts', 'src/StateMachine.ts'] },
    },
  },
  // Vitest 5. Every suite runs twice, once in the process and once against a
  // server on a port of its own with real requests.
  h3: {
    repo: 'https://github.com/h3js/h3',
    commit: '66cfb8a357b6285451bad498c2c40002601fae98',
    install: ['npx -y pnpm@12.3.4 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@12.3.4 add -D -w ${stryker}`,
    scopes: {
      utils: { mutate: ['src/utils/**/*.ts'] },
      // A few files of the scope above: what makes it slow, in minutes.
      session: { mutate: ['src/utils/session.ts', 'src/utils/body.ts'] },
    },
  },
  // Vitest 5, happy-dom. Debouncing, throttling and queues, tested under fake timers.
  pacer: {
    repo: 'https://github.com/TanStack/pacer',
    commit: '70ac6293e16698d728d90707b4ef0ccd71f02627',
    install: ['npx -y pnpm@12.6.0 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@12.6.0 add -D -w ${stryker}`,
    dir: 'packages/pacer',
    scopes: {
      timing: { mutate: ['src/debouncer.ts', 'src/throttler.ts', 'src/async-queuer.ts'] },
    },
  },
  // Vitest 4, jsdom, no isolation between test files: 280 small test files next to their sources.
  valibot: {
    repo: 'https://github.com/open-circle/valibot',
    commit: '2d29dbf04d272341a1e617070bd0b03eda8c4404',
    install: ['npx -y pnpm@11.5.0 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@11.5.0 add -D -w ${stryker}`,
    dir: 'library',
    scopes: {
      schemas: { mutate: ['src/schemas/**/*.ts'] },
    },
  },
  // Vitest 4, jsdom: a web application whose library code imports a Prisma
  // client generated at install, as the project's `pretest` does; the CI
  // gives it a database URL nothing connects to. A route test imports a
  // workspace package as built, so the packages are built as the CI does.
  umami: {
    repo: 'https://github.com/umami-software/umami',
    commit: 'e92fdab99508a8ed05249f6c5f07e140deab79e1',
    install: [
      'npx -y pnpm@12.3.4 install --frozen-lockfile',
      'DATABASE_URL=postgresql://user:pass@localhost:5432/dummy npx -y pnpm@12.3.4 generate:db:client',
      'npx -y pnpm@12.3.4 build:packages',
    ],
    installStryker: `npx -y pnpm@12.3.4 add -D -w ${stryker}`,
    scopes: {
      lib: { mutate: ['src/lib/**/*.ts'] },
      constants: { mutate: ['src/lib/constants.ts'] },
    },
  },
  // Vitest 5, Yarn 4: the core of a local-first application, whose tests
  // open an in-process sqlite database through a native module
  // (better-sqlite3, prebuilt in its package, so the install runs no
  // scripts) and load a grammar through a Vite plugin of the workspace.
  actual: {
    repo: 'https://github.com/actualbudget/actual',
    commit: '27290a8990ef8c24c71c581f4da08d6df020a009',
    dir: 'packages/loot-core',
    install: ['corepack yarn install --immutable'],
    installStryker: `corepack yarn workspace @actual-app/core add -D ${stryker}`,
    scopes: {
      server: { mutate: ['src/server/budget/**/*.ts', 'src/server/aql/**/*.ts'] },
    },
  },
  // Vitest 5: a NestJS server whose services are built with every
  // repository mocked through dependency injection, transformed by SWC for
  // the decorators. The config lives under `test/` and names its own root,
  // and neither tool takes a config path, so a config at the package root
  // re-exports it. The server imports two workspace packages as built,
  // which the CI builds first as well.
  immich: {
    repo: 'https://github.com/immich-app/immich',
    commit: 'be825a0518addd098166471706a64c8305cafca2',
    dir: 'server',
    install: [
      'npx -y pnpm@11.28.5 install --frozen-lockfile',
      'npx -y pnpm@11.28.5 --filter @immich/sdk --filter @immich/plugin-sdk build',
      `echo "export { default } from './test/vitest.config.mjs'" > server/vitest.config.mjs`,
    ],
    installStryker: `cd server && npx -y pnpm@11.28.5 add -D ${stryker}`,
    scopes: {
      utils: { mutate: ['src/utils/**/*.ts'] },
      services: { mutate: ['src/services/**/*.ts'] },
      album: { mutate: ['src/services/album.service.ts'] },
    },
  },
  // Vitest 5: a Next.js application with unit, jsdom and React Server
  // Components projects in one config. As the CI does: a `.env` from the
  // project's script, Redis unset, the imported workspace packages built.
  // The project runs Vitest under `dotenv`, which neither tool does, so a
  // config beside its own loads the file and re-exports it. `pnpm add` in
  // the package stalls fetching every platform's binaries: StrykerJS goes in the root.
  formbricks: {
    repo: 'https://github.com/formbricks/formbricks',
    commit: '33c0761485d709accb05da01a18fb1f67835183e',
    dir: 'apps/web',
    install: [
      'npx -y pnpm@11.7.0 install --frozen-lockfile',
      'npx -y pnpm@11.7.0 dev:setup',
      "sed -i.bak 's|^REDIS_URL=.*|REDIS_URL=|' .env && rm .env.bak",
      'npx -y pnpm@11.7.0 exec turbo run build --filter=@formbricks/ai --filter=@formbricks/logger --filter=@formbricks/database --filter=@formbricks/storage --filter=@formbricks/cache --filter=@formbricks/jobs --filter=@formbricks/surveys',
      `printf '%s\\n' 'import { config } from "dotenv";' 'config({ path: "../../.env", quiet: true });' 'export { default } from "./vite.config.mts";' > apps/web/vitest.config.mts`,
    ],
    installStryker: `npx -y pnpm@11.7.0 add -D -w ${stryker}`,
    scopes: {
      utils: { mutate: ['lib/utils/**/*.ts'] },
      validate: { mutate: ['lib/utils/validate.ts', 'lib/utils/templates.ts'] },
    },
  },
  // Vitest 3.2: a VS Code extension, its `vscode` module replaced through an
  // alias by a mock of the project's own, network calls refused by a setup
  // file and a 20-second time limit for every test. Tests look for the
  // bundle the project's `pretest` builds, so that is built at install.
  'roo-code': {
    repo: 'https://github.com/RooCodeInc/Roo-Code',
    commit: 'b867ec9145750d0ae1ff7f02d35406e9bf2a0b16',
    dir: 'src',
    install: ['npx -y pnpm@10.8.1 install --frozen-lockfile', 'npx -y pnpm@10.8.1 bundle'],
    installStryker: `cd src && npx -y pnpm@10.8.1 add -D ${stryker}`,
    scopes: {
      utils: { mutate: ['utils/**/*.ts', 'shared/**/*.ts'] },
    },
  },
  i18next: {
    repo: 'https://github.com/i18next/i18next',
    commit: '912869c0d2cd27de16a2ce30e212f61bd9f0aafe',
    install: [
      'HUSKY=0 npm ci --no-audit --no-fund',
      // Stryker's Babel 8 loads this Babel 7 build config, which Vitest does not use.
      'mv .babelrc .babelrc.build',
    ],
    installStryker: `HUSKY=0 npm install --save-dev --no-audit --no-fund ${stryker}`,
    projects: ['runtime'],
    scopes: {
      translation: { mutate: ['src/Interpolator.js', 'src/PluralResolver.js', 'src/LanguageUtils.js'] },
    },
  },
  yaml: {
    repo: 'https://github.com/eemeli/yaml',
    commit: '528ef30d6ded4bd9f2c3521b670eb2b29d503c5c',
    install: [
      'git submodule update --init --depth 1 tests/yaml-test-suite tests/json-test-suite',
      'npm ci --no-audit --no-fund',
      // Random inputs would make the suite used for ground truth differ from the one that tried the mutant.
      `node --input-type=module -e 'import fs from "node:fs"; fs.appendFileSync("tests/_setup.ts", "\\nimport * as fc from \\"fast-check\\"\\nfc.configureGlobal({ seed: 0 })\\n")'`,
    ],
    installStryker: `npm install --save-dev --no-audit --no-fund ${stryker}`,
    scopes: {
      lexer: { mutate: ['src/parse/lexer.ts'] },
    },
  },
  'date-fns': {
    repo: 'https://github.com/date-fns/date-fns',
    commit: 'a9739fb3e5384a810e90d7376446f6d84ecc5029',
    dir: 'pkgs/core',
    install: [
      'npx -y pnpm@12.17.0 install --frozen-lockfile',
      // The host's time zone would otherwise change date boundaries between local and hosted runs.
      `node --input-type=module -e 'import fs from "node:fs"; const file = "pkgs/core/vitest.config.ts"; fs.writeFileSync(file, "process.env.TZ = \\"UTC\\"\\n" + fs.readFileSync(file, "utf8"))'`,
    ],
    installStryker: `npx -y pnpm@12.17.0 add -D -w ${stryker}`,
    strykerInPlace: true,
    projects: ['main'],
    scopes: {
      dates: { mutate: ['src/parseISO/index.ts', 'src/parse/index.ts', 'src/format/index.ts'] },
    },
  },
  secretlint: {
    repo: 'https://github.com/secretlint/secretlint',
    commit: '0b4b59b07e3aab53cc7e42dedb132900342550dc',
    dir: 'packages/@secretlint/core',
    install: [
      'npx -y pnpm@10.34.9 install --frozen-lockfile',
      'npx -y pnpm@10.34.9 --filter @secretlint/core... build',
    ],
    installStryker: `npx -y pnpm@10.34.9 add -D -w ${stryker}`,
    scopes: {
      messages: {
        mutate: [
          'src/messages/filter-ignored-process.ts',
          'src/messages/filter-duplicated-process.ts',
          'src/messages/filter-mask-secrets.ts',
        ],
      },
    },
  },
  cspell: {
    repo: 'https://github.com/streetsidesoftware/cspell',
    commit: 'f9e2320e65b1b7e648e70ab7e6691b260a16b573',
    install: [
      'npx -y pnpm@12.17.0 install --frozen-lockfile',
      'npx -y pnpm@12.17.0 --filter cspell-trie-lib... build',
      // A sandbox of the package alone loses the shared dictionaries two directories above it.
      'mv vitest.config.mjs vitest.upstream.config.mjs',
      `printf '%s\\n' 'import config from "./vitest.upstream.config.mjs";' 'export default { ...config, test: { ...config.test, include: ["packages/cspell-trie-lib/**/*.{test,spec}.?(c|m)[jt]s?(x)"] } };' > vitest.config.mjs`,
    ],
    installStryker: `npx -y pnpm@12.17.0 add -D -w ${stryker}`,
    // Stryker copies this directory symlink as a file; the trie tests use other issue fixtures.
    strykerIgnore: ['test-fixtures/issues/issue-5120/.config'],
    scopes: {
      distance: { mutate: ['packages/cspell-trie-lib/src/lib/distance/levenshtein.ts', 'packages/cspell-trie-lib/src/lib/distance/weightedMaps.ts'] },
    },
  },
  commitlint: {
    repo: 'https://github.com/conventional-changelog/commitlint',
    commit: 'cbce2618bd25225d07538448de6cb3ec2ab043cc',
    install: ['HUSKY=0 npx -y pnpm@12.17.0 install --frozen-lockfile', 'npx -y pnpm@12.17.0 build'],
    // A test resolves this undeclared workspace dependency through pnpm's NODE_PATH; direct Vitest runs need the link too.
    installStryker: `HUSKY=0 npx -y pnpm@12.17.0 add -D -w ${stryker} @commitlint/config-angular@workspace:*`,
    strykerInPlace: true,
    scopes: {
      lint: { mutate: ['@commitlint/lint/src/lint.ts'] },
    },
  },
  // Vitest 5 through Vite+, jsdom: the front end of a music server, every
  // test file in a `vmThreads` pool with a memory limit, and composables
  // that hundreds of component tests reach through the stores.
  koel: {
    repo: 'https://github.com/koel/koel',
    commit: 'c2d0f0861dbc3f4642d7b54fb97445ac63714b0f',
    install: [
      'npx -y pnpm@10.32.1 install --frozen-lockfile',
      // The test data is faker's, unseeded: a mutant that leaves two songs tied
      // on a sort key orders them by random titles and fails the suite in about
      // half its runs. Each test file starts from one seed.
      `node --input-type=module -e 'import fs from "node:fs"; fs.appendFileSync("resources/assets/js/__tests__/setup.ts", "\\nimport { faker } from \\"@faker-js/faker\\"\\nfaker.seed(0)\\n")'`,
    ],
    installStryker: `npx -y pnpm@10.32.1 add -D ${stryker}`,
    // From a `--jobs` copy of ground truth, Vite refuses the `?url` import of `@koel-project/projectm-wasm`,
    // which resolves outside the copy, and `visualizers/projectm/index.spec.ts` fails as it loads in every
    // run that takes it in, the related tests of `useKoelPlus.ts` among them. Ground truth is made with `--jobs 1`.
    scopes: {
      composables: { mutate: ['resources/assets/js/composables/*.ts'] },
    },
  },
  // Vitest 4, JavaScript and JSX: a dashboard application whose tests
  // replace `process.env` and reset modules before importing them again.
  homepage: {
    repo: 'https://github.com/gethomepage/homepage',
    commit: 'a04af12df10a521090227632309a88d9d5d61685',
    install: ['npx -y pnpm@9.15.0 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@9.15.0 add -D -w ${stryker}`,
    scopes: {
      // 1,661 of the 4,708 mutants of `src/utils`. The rest, the service
      // helpers, the MCP server and the highlights above all, adds 981
      // survivors, each a run of the suite in ground truth.
      utils: { mutate: ['src/utils/{proxy,kubernetes,docker}/**/*.js', 'src/utils/contexts/*.jsx'] },
    },
  },
  // Vitest 4: a CSS compiler, its tests 1,151 inline snapshots among some
  // 5,400, through a native CSS parser (lightningcss). The root config is a
  // workspace of every package; the package has a config of its own.
  tailwindcss: {
    repo: 'https://github.com/tailwindlabs/tailwindcss',
    commit: 'b08bf83a327271dfb7e3cd485fd793da15013f7c',
    dir: 'packages/tailwindcss',
    install: ['npx -y pnpm@11.9.0 install --frozen-lockfile'],
    installStryker: `cd packages/tailwindcss && npx -y pnpm@11.9.0 add -D ${stryker}`,
    scopes: {
      parsers: { mutate: ['src/attribute-selector-parser.ts', 'src/selector-parser.ts', 'src/value-parser.ts'] },
    },
  },
  // Vitest 4: the core of an SDK, state shared through globalThis, globals
  // wrapped, and a transform plugin of the project's that runs first. A type
  // test needs the package built, and no source in the scope reaches it.
  sentry: {
    repo: 'https://github.com/getsentry/sentry-javascript',
    commit: '14e0d5683730ffd62f123e70e59e9210ed31172d',
    dir: 'packages/core',
    install: ['ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@12.11.2 install --frozen-lockfile --filter @sentry/core...'],
    installStryker: `cd packages/core && npx -y pnpm@12.11.2 add -D ${stryker}`,
    strykerInPlace: true,
    // The shared config turns coverage on, which only slows each run of ground truth.
    truthArgs: ['--coverage.enabled=false'],
    scopes: {
      // The modules of `src/utils` that four or fewer of the package's own sources import.
      utils: {
        mutate: [
          'src/utils/{anr,flushIfServerless,commitEnv,errorSpanAttribution,weightBasedFlushing,node,debounce,handleCallbackErrors,debug-ids,supports,aggregate-errors,path,node-stack-trace}.ts',
          'src/utils/{weakRef,cacheOrigin,tracePropagationTargets,cookie,ratelimit,eventbuilder,prepareEvent,tunnelDefaults,should-ignore-span,featureFlags,tunnelForward,promisebuffer}.ts',
        ],
      },
    },
  },
  lobehub: {
    repo: 'https://github.com/lobehub/lobehub',
    commit: '542398c507aad2ab1d66a4c526cee90fdf68aa5b',
    dir: 'packages/database',
    install: [
      // The workspace keeps no lockfile; a reinstall is to resolve what ground truth was made with, kept in lockfiles/.
      `node --input-type=module -e 'import fs from "node:fs"; fs.writeFileSync("pnpm-workspace.yaml", fs.readFileSync("pnpm-workspace.yaml", "utf8").replace(/^lockfile: false$/m, "lockfile: true"))'`,
      'cp "$VITANT_BENCH/lockfiles/lobehub-pnpm-lock.yaml" pnpm-lock.yaml',
      // The lifecycle scripts of the workspace's own packages stop the install, and nothing the tests load needs them.
      "ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@12.4.1 install --frozen-lockfile --filter '@lobechat/database...' --filter '@lobechat/observability-otel...' --ignore-scripts",
    ],
    installStryker: `cd packages/database && npx -y pnpm@12.4.1 add -D ${stryker}`,
    // The config aliases `@/database` to `../database/src`, and the server code
    // the tests load reaches the topic models through it: from a copy of the
    // package, StrykerJS's sandbox or a `--jobs` copy of ground truth, that is
    // not the copy's sources. Ground truth is made with `--jobs 1`.
    strykerInPlace: true,
    scopes: {
      topic: { mutate: ['src/models/topic/**/*.ts', 'src/repositories/topic*/**/*.ts'] },
    },
  },
  shopify: {
    repo: 'https://github.com/Shopify/cli',
    commit: '77013e78be8867cc6fd5cde3c7d8f19325c11751',
    dir: 'packages/cli-kit',
    install: ['ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@10.11.1 install --frozen-lockfile --filter @shopify/cli-kit...'],
    installStryker: `cd packages/cli-kit && npx -y pnpm@10.11.1 add -D ${stryker}`,
    // The package's config imports `../../configurations/vite.config`, which a copy of the package does not have.
    strykerInPlace: true,
    env: { SHOPIFY_CLI_ENV: 'development', npm_config_user_agent: 'pnpm/10.11.1' },
    scopes: {
      // Modules of `src/public/node` that one or two others import: `fs.ts` and `path.ts` are loaded by most of the 181 test files.
      node: { mutate: ['src/public/node/{git,dot-env,liquid,json-schema,dev-instance,import-extractor,archiver,github,store-auth-session,upgrade}.ts'] },
    },
  },
  promptfoo: {
    repo: 'https://github.com/promptfoo/promptfoo',
    commit: '5fac53eefdd26141a45c52ab77f533a7d30884e3',
    install: ['HUSKY=0 npm ci --no-audit --no-fund'],
    installStryker: `HUSKY=0 npm install --save-dev --no-audit --no-fund ${stryker}`,
    // StrykerJS's sandbox rewrites `tsconfig.json` through an API TypeScript 7 no longer has.
    strykerInPlace: true,
    // The version the server reports is `npm_package_version`, which `npm test` sets, or else
    // `0.0.0-development`, for which a test of the version route fails in every run.
    env: { npm_package_version: '0.125.1' },
    // Under `CI` the config stops a run at its first failing test. Where that is a test that fails by itself,
    // ground truth leaves it out and takes the run for a pass, the tests the mutant fails never having run.
    truthArgs: ['--bail=0'],
    scopes: {
      // The scoring assertions. With `xml.ts` and `sql.ts` beside them, 3,064 mutants: those two add 488 survivors, each a run of up to 159 test files in ground truth.
      assertions: { mutate: ['src/assertions/{bleu,gleu,rouge,ngrams,levenshtein,meteor,toolCallF1,trajectory}.ts'] },
    },
  },
  // Vitest 5, happy-dom: the front end of a node-graph editor, three inline
  // projects with test tags under `strictTags`, a setup that stops real
  // network requests, and two retries of a failing test under `CI`.
  comfyui: {
    repo: 'https://github.com/Comfy-Org/ComfyUI_frontend',
    commit: '3633e2613c24a74d58f8183ceef3b470a7801878',
    install: ['ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@11.28.10 install --frozen-lockfile'],
    installStryker: `HUSKY=0 npx -y pnpm@11.28.10 add -D -w ${stryker}`,
    // From StrykerJS's sandbox a test's mock of a workspace package resolves to the checkout's, and is not found.
    strykerInPlace: true,
    // From a `--jobs` copy of ground truth, `vitest related` on one store runs
    // 1,965 test files, 60 tests failing, where in the checkout it runs 6; and
    // a test's `pnpm exec` has pnpm install the workspace in the copy,
    // relinking the shared node_modules there. Ground truth is made with `--jobs 1`.
    scopes: {
      // The 13 stores that the fewest test files import, directly or not: `src/lib/litegraph/src/utils` is loaded by nearly all 2,550.
      stores: {
        mutate: [
          'src/stores/{bootstrapStore,aboutPanelStore,actionBarButtonStore,serverConfigStore,topbarBadgeStore,helpCenterStore,userStore}.ts',
          'src/stores/{nodeBookmarkStore,browserTabTitleStore,comfyRegistryStore,modelStore,assetExportStore,workflowTabActivityStore}.ts',
        ],
      },
    },
  },
  // Vitest 5, jsdom: an application built on dependency injection, through a
  // plugin of the project's for standard decorators, in projects the config
  // makes as it loads, with snapshots.
  freelens: {
    repo: 'https://github.com/freelensapp/freelens',
    commit: '2547f555b8286f515f443d6f29580597093365ae',
    install: [
      'HUSKY=0 npx -y pnpm@12.18.0 install --frozen-lockfile',
      // Tests of the extension API read these builds, and fail without them with no mutant.
      'npx -y pnpm@12.18.0 --filter @freelensapp/extensions build',
      'npx -y pnpm@12.18.0 build:fixture-extension',
      // Electron fetches its binary the first time it is loaded, and two test workers doing so at once fail each other.
      'cd packages/core && node node_modules/electron/install.js',
    ],
    installStryker: `HUSKY=0 npx -y pnpm@12.18.0 add -D -w ${stryker}`,
    // StrykerJS's sandbox rewrites `tsconfig.json` through an API TypeScript 7 no longer has.
    strykerInPlace: true,
    // As the project's `test:unit:core` script runs the package's tests.
    projects: ['@freelensapp/core'],
    env: { TZ: 'UTC' },
    // The scope's run took 7,412 to 7,824 s on a Xeon 6975P-C against the workflow's 150 minutes. A job of this tool alone stays within its six hours.
    limit: 300,
    strykerSkip: 'alone in a job on an EPYC 7763 it took 15,994 s and killed none of its 454 mutants, and with this tool after it a job passes its six hours',
    // From a `--jobs` copy of ground truth, most of the 303 test files that
    // reach one module of the scope fail as they load (10 tests run, against
    // 2,882 in the checkout). Ground truth is made with `--jobs 1`.
    scopes: {
      // The modules of `src/common/utils` that are not injectables or their registration. Every test that builds
      // the container loads every injectable through `import.meta.glob`, and these modules with them: some 300 test files reach each.
      utils: {
        mutate: [
          'packages/core/src/common/utils/{async-computed,await-lock,cluster-id-url-parsing,enum,get-error-message,get-latest-version-channel,registrator-helper,replace-observable-object,singleton,toJS,wait-for-path}.ts',
          'packages/core/src/common/utils/{add-separator,composable-responsibilities,composite,date,find-exactly-one,reactive-now,with-error-suppression}/**/*.ts',
          'packages/core/src/common/utils/{resolve-system-proxy/resolve-system-proxy-{injection-token,channel},sync-box/{channels,sync-box-injection-token}}.ts',
        ],
      },
    },
  },
  // Vitest 5: a workflow engine's expression evaluator, in four inline
  // projects: one list of test files run once for each of three engines, a
  // native isolate (isolated-vm) and QuickJS in WebAssembly among them, and a
  // `default` project for the rest.
  n8n: {
    repo: 'https://github.com/n8n-io/n8n',
    commit: '51f8cf624992e5813c31684359d95db5bf378092',
    dir: 'packages/workflow',
    install: [
      'ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@12.4.2 install --frozen-lockfile',
      "npx -y pnpm@12.4.2 exec turbo build --filter='n8n-workflow^...'",
    ],
    // The package depends on StrykerJS 10.1.1 through the workspace catalog, which refuses another version.
    installStryker: 'true',
    // In `threads` isolated-vm aborts the process when a thread that started an isolate ends.
    strykerPool: 'forks',
    // The tests that evaluate expressions run in each of three engine projects, and of a file several projects include
    // this tool counts only the first project's run: the rest and the native isolate's, which the package's StrykerJS config keeps.
    projects: ['default', 'vm-engine'],
    // Outside UTC a test of `.toDateTime` fails in each engine project with no mutant.
    env: { TZ: 'UTC' },
    scopes: {
      // With `src/expression.ts` and `src/expressions/**` beside them, 3,797 mutants, a run on a 12-core machine took 30 minutes,
      // the native evaluator's fuzz tests being run one at a time, and left 17 unconfirmed.
      proxy: { mutate: ['src/workflow-data-proxy*.ts'] },
    },
  },
  // Vitest 4, jsdom: a React application's frontend, whose tests render every
  // Storybook story of the application through `import.meta.glob` and run
  // its API client against a WebSocket mock server, msw and nock.
  headlamp: {
    repo: 'https://github.com/kubernetes-sigs/headlamp',
    commit: '696a4cdccaf365f20fd6cc1fd33d647772fcd20f',
    dir: 'frontend',
    install: ['cd frontend && HUSKY=0 npm ci --no-audit --no-fund', 'cd frontend && node make-env.js'],
    installStryker: `cd frontend && HUSKY=0 npm install --save-dev --no-audit --no-fund ${stryker}`,
    // The config turns off the retries of a failed request where `UNDER_TEST` or `VITEST` is `true`. Vitest sets `VITEST`
    // to `true`, StrykerJS's runner to `1`, and without the variable a test fails in StrykerJS's first run.
    env: { UNDER_TEST: 'true' },
    // The scope's run took 7,885 s on an EPYC 7763 against the workflow's 150 minutes.
    limit: 300,
    // From a `--jobs` copy of ground truth, Vite refuses the `?url` import of
    // a file in node_modules, which is the original's, outside the copy: two
    // of the 143 test files that reach `retry.ts` fail as they load. Ground truth is made with `--jobs 1`.
    scopes: {
      // The `.ts` modules of `src/lib/k8s/api/v2` but `useKubeObjectList.ts`, 707 mutants by itself, each of which would add a run of about
      // a minute to ground truth in the checkout alone. Each module of the scope is imported by 124 to 176 test files, components among them.
      api: { mutate: ['src/lib/k8s/api/v2/{multiplexer,hooks,webSocket,fetch,KubeList,nodeSummaryApi,retry,KubeObjectEndpoint,makeUrl}.ts'] },
    },
  },
  // Vitest 4: a schema library whose parsers compile themselves to code with
  // `new Function`, run as the repository's `test:compile` runs its tests:
  // every test of the package, with compilation on for all of them.
  zod: {
    repo: 'https://github.com/colinhacks/zod',
    commit: 'fef16cba0cf6668eb25ecc32fdfe2ce0a46f6f80',
    install: [
      // The repository's package manager is nub, which reads the workspace from `package.json` and
      // writes a pnpm lockfile pnpm does not install from frozen as it is: peers resolved to the workspace's
      // `zod` as `zod@4.6.7`, which it has no entry for, and aliases under their own names. The install adds
      // the entry. StrykerJS's `pnpm add` then resolves the workspace again, as for every target, and writes
      // those peers as links to the workspace's package; of the versions locked it drops only get-tsconfig 4.10.0.
      `printf '%s\\n' 'packages:' '  - packages/*' > pnpm-workspace.yaml`,
      `node --input-type=module -e 'import fs from "node:fs"; const s = fs.readFileSync("pnpm-lock.yaml", "utf8"); fs.writeFileSync("pnpm-lock.yaml", s.replace("\\npackages:\\n\\n", "\\npackages:\\n\\n  zod@4.6.7:\\n    resolution: {integrity: sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg==}\\n\\n").replace("\\nsnapshots:\\n\\n", "\\nsnapshots:\\n\\n  zod@4.6.7: {}\\n\\n"))'`,
      // The docs package's postinstall runs nub; nothing the tests load has a script to run.
      'HUSKY=0 npm_config_package_manager_strict=false npx -y pnpm@10.33.0 install --frozen-lockfile --ignore-scripts --config.strict-store-pkg-content-check=false',
    ],
    installStryker: `HUSKY=0 npm_config_package_manager_strict=false npx -y pnpm@10.33.0 add -D -w ${stryker} --ignore-scripts --config.strict-store-pkg-content-check=false`,
    // Stryker copies this directory symlink as a file; nothing the tests load is in it.
    strykerIgnore: ['.codex/skills'],
    // The root config's projects are the packages' and this one, each a config file of its own, which this tool does
    // not run; the package's config merges the root's, whose projects then name files from the package's directory.
    // This config has the type check off, which the root config has on.
    config: 'vitest.compile.config.ts',
    // The tests import `zod` by its name, which from a `--jobs` copy of ground truth resolves through the shared
    // node_modules to the checkout's sources, where the mutant is not. Ground truth is made with `--jobs 1`.
    scopes: {
      core: { mutate: ['packages/zod/src/v4/core/{compile,checks,util}.ts'] },
    },
  },
  // Vitest 4: the AI SDK's core package, with 993 snapshots and a type check
  // of `*.test-d.ts` files turned on, run once in node and once in the edge
  // runtime (@edge-runtime/vm), each from a config of its own.
  'vercel-ai': {
    ...vercelAi,
    config: 'vitest.node.config.js',
    scopes: {
      node: { mutate: ['src/{util,prompt}/**/!(*.test-d).ts'] },
    },
  },
  // The edge config leaves out `*.node.test.ts`.
  'vercel-ai-edge': {
    ...vercelAi,
    config: 'vitest.edge.config.js',
    scopes: {
      edge: { mutate: ['src/{util,prompt}/**/!(*.test-d).ts'] },
    },
  },
  // Vitest 5: SvelteKit's runtime, JavaScript typed through JSDoc, in two
  // inline projects, one of them in `forks` with `--expose-gc`, from a config
  // with a name of its own so that the test applications do not pick it up.
  sveltekit: {
    repo: 'https://github.com/sveltejs/kit',
    commit: 'ccd3474411a179abac03c1b8310e8c25f7a3b1ae',
    dir: 'packages/kit',
    install: ['ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@12.18.0 install --frozen-lockfile'],
    installStryker: `cd packages/kit && npx -y pnpm@12.18.0 add -D ${stryker}`,
    config: 'vitest.kit.config.js',
    strykerSkip: 'it was not through after the six hours of a job, on this scope and on all of src/runtime/server and src/utils',
    // From a `--jobs` copy of ground truth, 269 mutants failed the suite that passes with them in the checkout:
    // the tests import the package by its own name. Ground truth is made with `--jobs 1`.
    scopes: {
      // `src/utils` and the modules of `src/runtime/server` that the package's own tests reach. The rest, 3,359 mutants,
      // 2,419 of them reached by no test, mostly handle requests and render pages, which the repository tests through its test
      // applications and their servers.
      server: {
        mutate: [
          'src/utils/*.js',
          'src/runtime/server/{cookie,csrf,errors,internal,state,validate-headers}.js',
          'src/runtime/server/page/{csp,hash_bytes,serialize_data}.js',
        ],
      },
    },
  },
  // Vitest 4: a dependency bot's utilities, tested with nock, memfs and a
  // native regular expression engine (re2), coverage turned on by the config.
  renovate: {
    repo: 'https://github.com/renovatebot/renovate',
    commit: 'da9664321d4d16371084d616d2ac5c57de02e27d',
    install: ['ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@11.28.11 install --frozen-lockfile'],
    installStryker: `HUSKY=0 npx -y pnpm@11.28.11 add -D -w ${stryker}`,
    // StrykerJS's sandbox rewrites `tsconfig.json` through an API TypeScript 7 no longer has. In place, a test loads
    // StrykerJS's backup of `lib/expose.ts`, which finds no `../package.json`, and its first run fails: it does not run here.
    strykerInPlace: true,
    // The variables of the project's `vitest` script. Under `CI` the config adds reporters of its own.
    env: { NODE_ENV: 'test', GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', LOG_LEVEL: 'fatal', CI: null },
    truthArgs: ['--update=none', '--coverage.enabled=false'],
    scopes: {
      // Modules of `lib/util` whose related tests, a run of ground truth, take 75 s or less here. `check-token`, `coerce` and `emoji` are
      // reached by 383 to 396 test files and take 151 to 215 s; most of the rest of `lib/util` by over 400 files, going by their imports.
      util: { mutate: ['lib/util/{modules,split,interpolator,markdown,memoize,fingerprint,ignore,minimum-release-age,pretty-time,sample}.ts'] },
    },
  },
  // Vitest 5, plain ESM JavaScript: a git hook runner, its integration tests
  // running real git in temporary repositories and the formatter the
  // project uses, coverage held to 100% by the config.
  'lint-staged': {
    repo: 'https://github.com/lint-staged/lint-staged',
    commit: '49b5472587a6ad112bb32fe1ea3d4c324f2e2ecc',
    install: ['HUSKY=0 npm ci --no-audit --no-fund'],
    installStryker: `HUSKY=0 npm install --save-dev --no-audit --no-fund ${stryker}`,
    // StrykerJS's sandbox rewrites `tsconfig.json` through an API TypeScript 7 no longer has.
    strykerInPlace: true,
    // The integration tests start `oxfmt` by its name.
    binOnPath: true,
    // `e2e` runs the published command, `types` Vitest's type check.
    projects: ['unit', 'integration'],
    // A run of some of the test files falls short of the config's coverage thresholds and fails by that alone.
    truthArgs: ['--coverage.enabled=false'],
    // From a `--jobs` copy of ground truth, which has no `.git`, three tests fail with no mutant. Ground truth is made with `--jobs 1`.
    scopes: {
      lib: { mutate: ['lib/*.js'] },
    },
  },
  // Vitest 5: a bundler's front end, each test building fixtures with
  // rolldown into a `tests/temp` directory that runs of a test share.
  // Not a target the tool can judge, see docs/limits.md: where two runs of
  // one test meet, one empties the other's fixture, tsdown takes the
  // repository's own `package.json` for the fixture's and writes its
  // `exports` there. `git checkout -- package.json` after a run, and put
  // StrykerJS back in it with `installStryker`.
  tsdown: {
    repo: 'https://github.com/rolldown/tsdown',
    commit: 'e2e174deff987cf3e0d48eac0ef8b59f68f736c0',
    // pnpm as `devEngines` names it, 12.18.0, which the pnpm on PATH fetches and hands over to.
    install: ['pnpm install --frozen-lockfile'],
    // Tests call `process.chdir()`, which `threads` does not allow, and StrykerJS 10.0.0 takes no pool.
    installStryker: 'pnpm add -D -w @stryker-mutator/core@10.1.1 @stryker-mutator/vitest-runner@10.1.1',
    strykerPool: 'forks',
    strykerForce: true,
    scopes: {
      // The modules of `src/features` that write no files. With all of `src`, 4,031 mutants, a hosted run left 2,180 pending:
      // once the project's own `package.json` had been rewritten, a test of `packages/exe` failed to load.
      features: { mutate: ['src/features/{deps,entry,target,tsconfig,cjs,node-protocol,shebang,shims,output,report,hooks}.ts'] },
    },
  },
  // Vitest 4: a DOM implementation, tests held to 500 ms each, Node's
  // modules mocked from the setup file.
  'happy-dom': {
    repo: 'https://github.com/capricorn86/happy-dom',
    commit: '5e100dedb73111a276f75a3daff3a506e2524759',
    dir: 'packages/happy-dom',
    install: ['HUSKY=0 npm ci --no-audit --no-fund'],
    installStryker: `HUSKY=0 npm install --save-dev --no-audit --no-fund -w packages/happy-dom ${stryker}`,
    scopes: {
      // Every module of `src/css`, `src/dom` and `src/query-selector` is reached by 276 of the 304 test files, each run of ground
      // truth being a run of nearly the whole suite: the selector engine and `DOMTokenList.ts`, 1,787 of their 10,606 mutants.
      selectors: { mutate: ['src/query-selector/*.ts', 'src/dom/DOMTokenList.ts'] },
    },
  },
  // Vitest 5: an ORM's core against SQLite through better-sqlite3, in two
  // inline projects, one for legacy decorators through oxc and one for
  // standard decorators through SWC, with `isolate: false`.
  'mikro-orm': {
    repo: 'https://github.com/mikro-orm/mikro-orm',
    commit: '5f86240cf8daaaa0179b76dd9f1f3aaea145074f',
    install: [
      'HUSKY=0 corepack yarn install --immutable',
      // `test:sqlite` as a config: its filter, `sqlite.test.ts`, which StrykerJS and `vitest related` take none of, and its `npm_lifecycle_event`, without
      // which the global setup starts MongoDB, downloading it first. A variable of the target's would not do: npx, which starts StrykerJS, sets its own.
      `printf '%s\\n' 'import config from "./vitest.config.ts";' 'process.env.npm_lifecycle_event = "test:sqlite";' 'export default { ...config, test: { ...config.test, projects: config.test.projects.map((project) => ({ ...project, test: { ...project.test, include: project.test.include.map((glob) => glob.replace(/[*][.]test[.]ts$/, "*sqlite.test.ts")) } })) } };' > vitest.sqlite.config.ts`,
    ],
    installStryker: `HUSKY=0 corepack yarn add -D ${stryker}`,
    // StrykerJS's sandbox rewrites `tsconfig.json` through an API TypeScript 7 no longer has.
    strykerInPlace: true,
    config: 'vitest.sqlite.config.ts',
    scopes: {
      // With all of `unit-of-work`, `hydration` and `serialization`, 3,605 mutants, a hosted run had not ended after 150 minutes.
      core: { mutate: ['packages/core/src/unit-of-work/{ChangeSetComputer,CommitOrderCalculator,IdentityMap,ChangeSet}.ts', 'packages/core/src/{hydration/Hydrator,serialization/SerializationContext}.ts'] },
    },
  },
  // Vitest 4, jsdom: the front end of a platform for development
  // environments, its agents' pages compiled by the React Compiler (Babel),
  // in a `unit` project beside one of Storybook stories in a browser.
  coder: {
    repo: 'https://github.com/coder/coder',
    commit: '241ec8dfeafd1e01a26d18088d59fba6426682cc',
    dir: 'site',
    install: [
      'cd site && ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@12.16.1 install --frozen-lockfile',
      // With the config's vite-plugin-checker, Vitest's `forks` pool fails to start a worker after five test
      // files with `spawn EBADF`, in the plain suite as well; `threads` does not, and this tool runs every file
      // in `forks`. A config beside the project's leaves the plugin out. It also keeps the `unit` project to the
      // tests of the scope's directories: the scope's modules are reached by some 155 test files, the pages'
      // components among them, and a run of those took 228 s, against 15 s for the 41 of the directories.
      `printf '%s\\n' 'import config from "./vite.config.mts";' 'const include = ["src/pages/AgentsPage/{hooks,utils}/**/*.test.?(m)ts?(x)"];' 'export default {' '  ...config,' '  plugins: config.plugins.flat().filter((plugin) => !String(plugin?.name ?? "").includes("checker")),' '  test: { ...config.test, projects: config.test.projects.map((project) => project.test.name === "unit" ? { ...project, test: { ...project.test, include } } : project) },' '};' > site/vitest.bench.config.mts`,
    ],
    installStryker: `cd site && npx -y pnpm@12.16.1 add -D ${stryker}`,
    config: 'vitest.bench.config.mts',
    // The other project runs Storybook's stories in a browser.
    projects: ['unit'],
    // Outside UTC two tests of `timeGroups.test.ts` fail with no mutant: they compare a pinned time with local midnight.
    env: { TZ: 'UTC' },
    // From a `--jobs` copy of ground truth, Vite refuses the setup file `@testing-library/jest-dom/vitest`, which
    // resolves through the linked node_modules to the original, outside the copy, and every run fails. Ground truth is made with `--jobs 1`.
    scopes: {
      // The React Compiler compiles 17 of the 53 modules, the 16 of `hooks` and `utils/notificationWindow.ts`, 2,206 mutants,
      // from their source and gives up on their instrumented code; this tool leaves those out (docs/limits.md), and the
      // scope's verdicts are of the other 36 modules of `utils`. StrykerJS mutates all 53.
      agents: { mutate: ['src/pages/AgentsPage/{hooks,utils}/**/*.ts'] },
    },
  },
  // Vitest 5, jsdom: a Vue component library, its components written as
  // single-file components and TSX, mounted through @vue/test-utils.
  'element-plus': {
    repo: 'https://github.com/element-plus/element-plus',
    commit: '3b5d0ad35b1d309a3430b49db9be1369f0966321',
    install: ['ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HUSKY=0 CYPRESS_INSTALL_BINARY=0 npx -y pnpm@12.18.0 install --frozen-lockfile'],
    installStryker: `npx -y pnpm@12.18.0 add -D -w ${stryker}`,
    scopes: {
      table: { mutate: ['packages/components/table/src/**/*.{ts,tsx}', 'packages/hooks/use-*/*.ts'] },
    },
  },
}

/** Where the target's project is: its checkout, or the package inside it. */
export function projectDir(target: string): string {
  return path.join(workDir(target), targets[target].dir ?? '')
}

export function workDir(target: string): string {
  return process.env.VITANT_BENCH_DIR ?? path.join(import.meta.dirname, '.work', target)
}
