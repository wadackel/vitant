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
  /** Shell commands that install the project's own dependencies. */
  install: string[]
  /** Shell command that adds StrykerJS to the project. */
  installStryker: string
  /** The package to run in, for a repository that holds several. */
  dir?: string
  /** The Vitest projects to run, where the others need what the benchmark does not set up, a browser for one. */
  projects?: string[]
  /** Test file filters, as Vitest takes them, for the same reason. */
  filters?: string[]
  scopes: Record<string, Scope>
}

/** What a target adds to a Vitest command line. */
export function vitestArgs(target: Target): string[] {
  return [...(target.projects ?? []).flatMap((project) => ['--project', project]), ...(target.filters ?? [])]
}

const stryker = '@stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0'

export const targets: Record<string, Target> = {
  excalidraw: {
    repo: 'https://github.com/excalidraw/excalidraw',
    commit: 'ed10ac7dca7e40f3f4a31269b4bfba980d0db41e',
    install: ['npx -y yarn@1.22.22 install --frozen-lockfile'],
    installStryker: `npx -y yarn@1.22.22 add -W -D ${stryker}`,
    scopes: {
      math: { mutate: ['packages/math/src/**/*.ts'] },
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
    // package by its own name, which only Plug'n'Play resolves by itself;
    // the link goes in after the last Yarn command, so none of them can undo it.
    install: ['YARN_NODE_LINKER=node-modules corepack yarn install --immutable'],
    installStryker: `YARN_NODE_LINKER=node-modules corepack yarn add -D ${stryker} && ln -sfn "$PWD" node_modules/es-toolkit`,
    scopes: {
      array: { mutate: ['src/array/*.ts'] },
      all: { mutate: ['src/**/*.ts'] },
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
