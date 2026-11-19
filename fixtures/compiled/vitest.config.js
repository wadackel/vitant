// A stand-in for a compiler such as React's: it rewrites a function only where
// it can tell what the function does, and imports its runtime only then. The
// function it can tell is one that returns an object of its parameter.
const understood = /^export function (\w+)\((\w+)\) \{\n {2}return \{ \2 \}\n\}$/m

function memo() {
  return {
    name: 'memo',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('/src/box.js')) return undefined
      const match = understood.exec(code)
      if (!match) return undefined
      const [, name, parameter] = match
      return `import { memoize } from './memoize.js'\nexport const ${name} = memoize((${parameter}) => ({ ${parameter} }))\n`
    },
  }
}

export default { plugins: [memo()], test: { include: ['test/**/*.test.js'] } }
