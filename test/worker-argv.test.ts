import { expect, it } from 'vitest'
import { poolArgv } from '../src/run.ts'

const poolOptions = {
  forks: { execArgv: ['--expose-gc'] },
  threads: { execArgv: ['--no-deprecation'] },
  vmForks: { execArgv: ['--expose-gc', '--no-deprecation'] },
}

it('takes the arguments of the pool the root runs in, forks where it names none', () => {
  expect(poolArgv({ poolOptions })).toEqual({ argv: ['--expose-gc'], others: [] })
  expect(poolArgv({ pool: 'threads', poolOptions })).toEqual({ argv: ['--no-deprecation'], others: [] })
  expect(poolArgv({ pool: 'vmThreads', poolOptions })).toEqual({ argv: [], others: [] })
})

it('takes the arguments of the pools the projects run in, the root\'s only for one that extends it', () => {
  expect(poolArgv({ pool: 'threads', poolOptions, projects: [{ test: { pool: 'vmForks' } }] })).toEqual({ argv: ['--expose-gc', '--no-deprecation'], others: [] })
  expect(poolArgv({ pool: 'threads', poolOptions, projects: [{ test: {} }] })).toEqual({ argv: ['--expose-gc'], others: [] })
  expect(poolArgv({ pool: 'threads', poolOptions, projects: [{ extends: true, test: {} }] })).toEqual({ argv: ['--no-deprecation'], others: [] })
  // A project given by a path is not run by the tool.
  expect(poolArgv({ poolOptions, projects: ['packages/*', { test: { pool: 'threads' } }] })).toEqual({ argv: ['--no-deprecation'], others: [] })
})

it('counts only the projects the tool runs', () => {
  const projects = [
    { test: { name: 'client', pool: 'threads' } },
    { test: { name: 'browser', pool: 'forks', browser: { enabled: true } } },
    { test: { name: 'server', pool: 'vmForks' } },
  ]
  expect(poolArgv({ poolOptions, projects }, ['server'])).toEqual({ argv: ['--expose-gc', '--no-deprecation'], others: [] })
  expect(poolArgv({ poolOptions, projects }, ['S*'])).toEqual({ argv: ['--expose-gc', '--no-deprecation'], others: [] })
  expect(poolArgv({ poolOptions, projects }, ['!client'])).toEqual({ argv: ['--expose-gc', '--no-deprecation'], others: [] })
  expect(poolArgv({ poolOptions, projects })).toEqual({ argv: ['--no-deprecation'], others: ['vmForks'] })
  // As Vitest names them: by place where a project gives no name, and as the root where it extends it.
  const unnamed = [{ test: { pool: 'threads' } }, { test: { pool: 'vmForks' } }]
  expect(poolArgv({ poolOptions, projects: unnamed }, ['1'])).toEqual({ argv: ['--expose-gc', '--no-deprecation'], others: [] })
  const extending = { name: 'app', pool: 'vmForks', poolOptions, projects: [{ test: { name: 'node', pool: 'threads' } }, { extends: true, test: {} }] }
  expect(poolArgv(extending, ['app'])).toEqual({ argv: ['--expose-gc', '--no-deprecation'], others: [] })
  expect(poolArgv({ ...extending, browser: { enabled: true } })).toEqual({ argv: ['--no-deprecation'], others: [] })
})

it('names a project that extends a file and names no pool, whose pool that file gives', () => {
  const projects = [{ extends: './vite.config.ts', test: { name: 'unit' } }, { test: { name: 'node', pool: 'threads' } }]
  expect(poolArgv({ poolOptions, projects })).toEqual({ argv: ['--no-deprecation'], others: ['the pool of ./vite.config.ts'] })
  expect(poolArgv({ poolOptions, projects: [{ extends: './vite.config.ts', test: { pool: 'threads' } }] })).toEqual({ argv: ['--no-deprecation'], others: [] })
})

it('keeps the first project\'s arguments and names the pools given others', () => {
  const projects = [{ test: { pool: 'threads' } }, { test: {} }, { test: { pool: 'vmThreads' } }, { test: { pool: 'threads' } }]
  expect(poolArgv({ poolOptions, projects })).toEqual({ argv: ['--no-deprecation'], others: ['forks', 'vmThreads'] })
  // Pools given the same list are one list to the workers.
  expect(poolArgv({ poolOptions: { forks: { execArgv: ['-x'] }, threads: { execArgv: ['-x'] } }, projects: [{ test: { pool: 'threads' } }, { test: {} }] })).toEqual({ argv: ['-x'], others: [] })
})
