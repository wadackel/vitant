// Whether the project's own plugins make of a mutated file's instrumented code
// what they make of its source, as far as the modules it imports tell.

import { parseSync } from 'oxc-parser'
import type { Node } from './mutate/walk.ts'

/** The calls Vite's SSR transform turns `import` declarations and `import()` into. */
const ssrImports = new Set(['__vite_ssr_import__', '__vite_ssr_dynamic_import__'])

/**
 * The specifiers of the modules a transformed module imports: by `import` and
 * `export … from`, by `import()` with a literal, and by the calls Vite's SSR
 * transform puts in their place. Undefined where the code does not parse.
 */
export function importedModules(code: string, filename: string): Set<string> | undefined {
  const parsed = parseSync(filename.replace(/\.[^./]+$/, '.js'), code)
  if (parsed.errors.some((error) => error.severity === 'Error')) return undefined
  const found = new Set<string>()
  const literal = (node: Node) => (node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined)
  const visit = (node: Node): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (!node || typeof node !== 'object') return
    if (typeof node.type === 'string') {
      const named =
        node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ImportExpression'
          ? literal(node.source)
          : node.type === 'CallExpression' && node.callee?.type === 'Identifier' && ssrImports.has(node.callee.name)
            ? literal(node.arguments?.[0])
            : undefined
      if (named !== undefined) found.add(named)
    }
    for (const key in node) {
      if (key !== 'type' && key !== 'start' && key !== 'end') visit(node[key])
    }
  }
  visit(parsed.program)
  return found
}

/**
 * Why the instrumented code is not what the suite runs, from the outputs of
 * the same plugins for the source and for it, or undefined where nothing
 * tells them apart. A plugin that fails on the instrumented code only, or one
 * that imports a module for one of them only, has not made the same of them:
 * the React Compiler imports its runtime only into a module it could compile.
 */
export function divergence(source: string, instrumented: string | Error, filename: string): string | undefined {
  if (instrumented instanceof Error) {
    return `the project's plugins fail on its instrumented code and not on its source (${instrumented.message.split('\n')[0]}), so its tests would not run the code the suite runs`
  }
  const plain = importedModules(source, filename)
  const mutated = importedModules(instrumented, filename)
  if (!plain || !mutated) return undefined
  const only = (from: Set<string>, not: Set<string>) => [...from].filter((name) => !not.has(name)).sort()
  const sourceOnly = only(plain, mutated)
  const instrumentedOnly = only(mutated, plain)
  if (sourceOnly.length === 0 && instrumentedOnly.length === 0) return undefined
  const named = [
    ...(sourceOnly.length > 0 ? [`only its source imports ${sourceOnly.join(', ')}`] : []),
    ...(instrumentedOnly.length > 0 ? [`only its instrumented code imports ${instrumentedOnly.join(', ')}`] : []),
  ]
  return `the project's plugins do not compile its instrumented code as they compile its source (${named.join('; ')}), so its tests would not run the code the suite runs`
}
