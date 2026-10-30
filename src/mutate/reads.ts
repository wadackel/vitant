import { parseSync } from 'oxc-parser'
import { loadReads } from './bindings.ts'
import { RUNTIME_GLOBAL } from './instrument.ts'
import { type Node, walk } from './walk.ts'

/** What a module that holds watched bindings, or passes some on, gives the modules that import it. */
export interface WatchedModule {
  /** Read sites of the watched bindings each name it exports stands for. */
  exports: Map<string, readonly number[]>
  /** Every read site behind the module. */
  all: readonly number[]
  /** Whether what its names stand for is not known: each of them then stands for all. */
  opaque?: boolean
}

export interface ReadsOptions {
  /** Read sites of the module's own watched bindings, by name, when it holds some. */
  own?: Map<string, number>
  /** Those of them whose initializers call built-ins, which are checked to be the built-ins as the module loads. */
  checked?: ReadonlySet<string>
  /** The module a specifier names, as the module graph would resolve it. */
  resolve: (specifier: string) => Promise<string | undefined>
  /** What a module gives, see `reexports`. */
  watched: (file: string) => Promise<WatchedModule | undefined>
  /** Names this module passes on that importers follow to what they stand for, see `reexports`. */
  aliased?: ReadonlySet<string>
  /** Every read site there is, for a module whose imports cannot be told. */
  everything: number[]
}

const sitesOf = (module: WatchedModule, name: string): readonly number[] => module.exports.get(name) ?? (module.opaque ? module.all : [])

/**
 * What a module gives by what it passes on: `export { a } from`, `export *`,
 * `import { a } ...; export { a }`. A re-export reads nothing as the module
 * loads (Vite makes it a getter), so an importer that reads the name reads
 * the binding behind it, and is marked so where it reads it. `aliased` names
 * what was followed; anything else the module passes on is marked as a read
 * where it loads.
 */
export async function reexports(
  source: string,
  filename: string,
  own: WatchedModule | undefined,
  resolve: (specifier: string) => Promise<string | undefined>,
  watched: (file: string) => Promise<WatchedModule | undefined>,
): Promise<(WatchedModule & { aliased: Set<string> }) | undefined> {
  let program: Node
  try {
    const parsed = parseSync(filename, source)
    if (parsed.errors.some((error) => error.severity === 'Error')) return own && { ...own, aliased: new Set() }
    program = parsed.program
  } catch {
    return own && { ...own, aliased: new Set() }
  }
  const exports = new Map(own?.exports)
  const aliased = new Set<string>()
  let opaque = own?.opaque ?? false
  /** What a module whose names are not known stands for. */
  const behind: number[] = []
  const target = async (specifier: string) => {
    const file = await resolve(specifier)
    return file === undefined ? undefined : watched(file)
  }
  const imports = new Map<string, { specifier: string; name: string }>()
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
    for (const specifier of statement.specifiers) {
      const name = specifier.type === 'ImportNamespaceSpecifier' ? '*' : specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
      imports.set(specifier.local.name, { specifier: statement.source.value, name })
    }
  }
  const pass = (as: string, sites: readonly number[]) => {
    if (sites.length === 0) return
    exports.set(as, [...new Set([...(exports.get(as) ?? []), ...sites])])
    aliased.add(as)
  }
  const nameOf = (node: Node) => (node.type === 'Identifier' ? node.name : node.value)
  for (const statement of program.body) {
    if (statement.exportKind === 'type') continue
    if (statement.type === 'ExportAllDeclaration') {
      const module = await target(statement.source.value)
      if (!module) continue
      if (statement.exported) pass(nameOf(statement.exported), module.all)
      else {
        if (module.opaque) {
          opaque = true
          behind.push(...module.all)
        }
        for (const [name, sites] of module.exports) if (name !== 'default' && !exports.has(name)) pass(name, sites)
      }
    } else if (statement.type === 'ExportNamedDeclaration' && !statement.declaration) {
      for (const specifier of statement.specifiers) {
        if (specifier.exportKind === 'type') continue
        const local = nameOf(specifier.local)
        const from = statement.source ? { specifier: statement.source.value, name: local } : imports.get(local)
        const module = from && (await target(from.specifier))
        if (module) pass(nameOf(specifier.exported), from!.name === '*' ? module.all : sitesOf(module, from!.name))
      }
    }
  }
  if (exports.size === 0 && !opaque) return undefined
  return { exports, all: [...new Set([...(own?.all ?? []), ...behind, ...[...exports.values()].flat()])], opaque, aliased }
}

const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
/** Methods of `vi` that load a module by its specifier, or say what loading it gives. */
const loaders = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock', 'requireActual', 'requireMock'])

const literal = (node: Node): string | undefined => (node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined)

/** Whether a call loads a module by a specifier: `require`, `vi.mock` and the like. */
function loads(node: Node): boolean {
  if (node.type !== 'CallExpression') return false
  const { callee } = node
  const name = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : undefined
  return name === 'require' || (callee.type === 'MemberExpression' && loaders.has(name))
}

const loadedBy = (node: Node): string | undefined => (loads(node) ? literal(node.arguments[0]) : undefined)

/**
 * The module with a mark of every read site whose binding it may read, at
 * the start of the function that would read it, or at the start of the
 * module where the read is outside any function. Marking more than is read
 * only costs runs; one read left unmarked is a mutant called survived that
 * the suite may detect, so every way of reaching a module that cannot be
 * followed by name marks all of its bindings. Returns undefined where
 * nothing is to be marked.
 */
export async function placeReads(code: string, filename: string, options: ReadsOptions): Promise<string | undefined> {
  if (options.everything.length === 0) return undefined
  let program: Node
  try {
    const parsed = parseSync(filename.replace(/\.[^./]+$/, '.jsx'), code, { preserveParens: false })
    if (parsed.errors.some((error) => error.severity === 'Error')) throw new Error('unparsable')
    program = parsed.program
  } catch {
    return mark(code, new Map([[undefined, new Set(options.everything)]]), undefined)
  }

  const specifiers = new Set<string>()
  walk(program, ({ node }) => {
    if (node.type === 'ImportExpression' && literal(node.source) !== undefined) specifiers.add(literal(node.source)!)
    if (loadedBy(node) !== undefined) specifiers.add(loadedBy(node)!)
  })
  // `walk` leaves imports out; they are what matters most here.
  for (const statement of program.body) if (statement.source) specifiers.add(statement.source.value)
  const targets = new Map<string, WatchedModule>()
  await Promise.all(
    [...specifiers].map(async (specifier) => {
      const resolved = await options.resolve(specifier)
      const module = resolved === undefined ? undefined : await options.watched(resolved)
      if (module) targets.set(specifier, module)
    }),
  )

  /** Per enclosing function (undefined for the module), the sites to mark there. */
  const marks = new Map<Node | undefined, Set<number>>()
  /** `null` for where nothing is read: a name a parameter binds. */
  const add = (at: Node | undefined | null, sites: Iterable<number>) => {
    if (at === null) return
    const set = marks.get(at) ?? new Set()
    for (const site of sites) set.add(site)
    marks.set(at, set)
  }
  const aliased = options.aliased ?? new Set<string>()
  /** Local names bound to a watched binding of another module, or to all of one. */
  const named = new Map<string, number[]>()
  // A name bound to more than one module in the file, in scopes of its own, reads all of them.
  const namespaces = new Map<string, WatchedModule[]>()
  const bind = (name: string, module: WatchedModule) => namespaces.set(name, [...(namespaces.get(name) ?? []), module])
  for (const statement of program.body) {
    const module = statement.source ? targets.get(statement.source.value) : undefined
    if (!module) continue
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportNamespaceSpecifier') bind(specifier.local.name, module)
        else {
          const imported =
            specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
          const sites = sitesOf(module, imported)
          if (sites.length > 0) named.set(specifier.local.name, [...(named.get(specifier.local.name) ?? []), ...sites])
        }
      }
    } else if (statement.type === 'ExportAllDeclaration') {
      const followed = !module.opaque && [...module.exports.keys()].every((name) => name === 'default' || aliased.has(name))
      if (statement.exported ? !aliased.has(statement.exported.name ?? statement.exported.value) : !followed) add(undefined, module.all)
    } else if (statement.type === 'ExportNamedDeclaration') {
      for (const specifier of statement.specifiers) {
        const local = specifier.local.type === 'Identifier' ? specifier.local.name : specifier.local.value
        const exported = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value
        if (!aliased.has(exported)) add(undefined, sitesOf(module, local))
      }
    }
  }
  // Vitest turns the imports of a file that mocks a module into
  // `const __vi_import_0__ = await import('…')`, and every use of a name into
  // a property of that. Such a constant is a namespace like any other; taken
  // for a read of all of the module, it made every file that mocks anything
  // read every binding it imports one of.
  // Where Vitest is given a way to wrap the import, it is
  // `await globalThis[…].wrapDynamicImport(() => import('…'))`.
  /** Per such import, what reading its result there reads: undefined where it is kept as a namespace. */
  const awaited = new Map<Node, number[] | undefined>()
  walkAll(program, (node, parent, ancestors) => {
    if (node.type !== 'ImportExpression') return
    const wrapped =
      parent?.type === 'ArrowFunctionExpression' && parent.body === node && ancestors.at(-2)?.type === 'CallExpression' &&
      ancestors.at(-2).arguments.length === 1 && ancestors.at(-2).callee.type === 'MemberExpression' && ancestors.at(-2).callee.property?.name === 'wrapDynamicImport'
    const at = wrapped ? ancestors.length - 3 : ancestors.length - 1
    const awaiting = ancestors[at]
    const declarator = ancestors[at - 1]
    const declaration = ancestors[at - 2]
    const module = targets.get(literal(node.source) ?? '')
    if (!module || awaiting?.type !== 'AwaitExpression' || declarator?.type !== 'VariableDeclarator' || declarator.init !== awaiting || declaration?.kind !== 'const') return
    if (declarator.id.type === 'Identifier') {
      bind(declarator.id.name, module)
      awaited.set(node, undefined)
    } else if (declarator.id.type === 'ObjectPattern') {
      // `const { a, b: c } = await import(...)` reads those two, there; a rest element or a computed key reads all.
      const keys = declarator.id.properties.map((property: Node) =>
        property.type === 'Property' && !property.computed ? (property.key.type === 'Identifier' ? property.key.name : literal(property.key)) : undefined,
      )
      awaited.set(node, keys.includes(undefined) ? module.all : keys.flatMap((key: string) => sitesOf(module, key)))
    }
  })
  const own = options.own ?? new Map<string, number>()
  // Reads of one watched binding inside the initializer of another are what
  // makes the second's value, and its own reads stand for them.
  const slices: [number, number][] = []
  /** Checks placed right before a declaration: what is checked has to hold where it is evaluated. */
  const checks: { at: number; text: string }[] = []
  // The instrumenter chose them by the source; here the initializers hold its switches.
  for (const statement of own.size > 0 ? program.body : []) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (declaration?.type !== 'VariableDeclaration') continue
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== 'Identifier' || !own.has(declarator.id.name) || !declarator.init) continue
      if (options.checked?.has(declarator.id.name)) {
        checks.push({ at: statement.start, text: `if(!${RUNTIME_GLOBAL}.k())${RUNTIME_GLOBAL}.h[${own.get(declarator.id.name)}]=1;` })
      }
      const deferred: [number, number][] = []
      loadReads(declarator.init, deferred)
      let from = declarator.init.start
      for (const [start, end] of deferred.sort((a, b) => a[0] - b[0])) {
        slices.push([from, start])
        from = end
      }
      slices.push([from, declarator.init.end])
    }
  }
  const inSlice = (node: Node) => slices.some(([from, to]) => node.start >= from && node.end <= to)

  /**
   * Where a read is marked: the start of the function whose body it is in.
   * A read in the parameters, in a default value or a computed key, happens
   * before the body starts and is marked where it is evaluated: the start of
   * the module is not before it, since a function declared there can be
   * called through an import cycle before the module's own code runs.
   */
  const enclosing = (node: Node, ancestors: readonly Node[]): Node | undefined | null => {
    for (let index = ancestors.length - 1; index >= 0; index--) {
      const fn = ancestors[index]
      if (!functionTypes.has(fn.type)) continue
      if (node.start >= fn.body.start && node.end <= fn.body.end) return fn
      for (let inner = index + 1; inner < ancestors.length; inner++) {
        const parent = ancestors[inner - 1]
        const slot = inner + 1 < ancestors.length ? ancestors[inner + 1] : node
        const child = ancestors[inner]
        if (child.type === 'AssignmentPattern' && slot === child.right) return { slot }
        if (child.type === 'Property' && parent.type === 'ObjectPattern' && child.computed && slot === child.key) return { slot }
      }
      // Any other name in the parameters is one they bind.
      return null
    }
    return undefined
  }
  walkAll(program, (node, parent, ancestors) => {
    if (node.type === 'ImportExpression') {
      if (awaited.has(node)) {
        add(enclosing(node, ancestors), awaited.get(node) ?? [])
        return
      }
      const specifier = literal(node.source)
      if (specifier === undefined) add(enclosing(node, ancestors), options.everything)
      else if (targets.has(specifier)) add(enclosing(node, ancestors), targets.get(specifier)!.all)
      return
    }
    // What is loaded by a specifier that is not written out can be any module.
    if (node.type === 'CallExpression' && ((node.callee.type === 'Identifier' && node.callee.name === 'eval') || (loads(node) && loadedBy(node) === undefined))) {
      add(undefined, options.everything)
      return
    }
    // `vi.mock` and the like are lifted above the imports, and a factory
    // that takes the original module reads all of it.
    const loaded = loadedBy(node)
    if (loaded !== undefined) {
      if (targets.has(loaded)) add(undefined, targets.get(loaded)!.all)
      return
    }
    if (node.type === 'MetaProperty' && parent?.type === 'MemberExpression' && parent.property?.name === 'glob') {
      add(undefined, options.everything)
      return
    }
    if (node.type !== 'Identifier' && node.type !== 'JSXIdentifier') return
    if (parent?.type === 'ImportSpecifier' || parent?.type === 'ImportDefaultSpecifier' || parent?.type === 'ImportNamespaceSpecifier') return
    // The name a module exports under is no reference: `export { schema2 as schema }`, which is what esbuild makes of `export { schema } from`.
    if (parent?.type === 'ExportSpecifier' && parent.exported === node && parent.local !== node) return
    // An imported name passed on under a name importers follow is read where they read it.
    if (parent?.type === 'ExportSpecifier' && parent.local === node && aliased.has(parent.exported.name ?? parent.exported.value)) return
    // A key of the same name reads nothing; a shorthand property's value is a node of its own.
    if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return
    if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && parent.key === node && !parent.computed) return
    // A name being declared is not read.
    if (parent?.type === 'VariableDeclarator' && parent.id === node) return
    for (const namespace of namespaces.get(node.name) ?? []) {
      const member = parent?.type === 'MemberExpression' && parent.object === node ? parent : undefined
      const key = member && (member.computed ? literal(member.property) : member.property.name)
      add(enclosing(node, ancestors), key === undefined ? namespace.all : sitesOf(namespace, key))
    }
    const sites = named.get(node.name) ?? []
    const ownSite = own.get(node.name)
    if (ownSite !== undefined) {
      const exported = parent?.type === 'ExportSpecifier' && !ancestors.at(-2)?.source
      if (!exported && !inSlice(node)) add(enclosing(node, ancestors), [ownSite])
    }
    if (sites.length > 0) add(enclosing(node, ancestors), sites)
  })
  return marks.size === 0 && checks.length === 0 ? undefined : mark(code, marks, program, checks)
}

/** Every node, imports and their specifiers included, with its parent and the nodes above it. */
function walkAll(program: Node, visit: (node: Node, parent: Node | undefined, ancestors: readonly Node[]) => void): void {
  const ancestors: Node[] = []
  const go = (node: Node, parent: Node | undefined) => {
    visit(node, parent, ancestors)
    ancestors.push(node)
    for (const [key, child] of Object.entries(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'typeAnnotation') continue
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item.type === 'string') go(item, node)
      } else if (child && typeof (child as Node).type === 'string') go(child, node)
    }
    ancestors.pop()
  }
  go(program, undefined)
}

function mark(code: string, marks: Map<Node | undefined, Set<number>>, program: Node | undefined, checks: { at: number; text: string }[] = []): string {
  const statement = (sites: Set<number>) => `${[...sites].map((site) => `${RUNTIME_GLOBAL}.h[${site}]=`).join('')}1;`
  const inserts = [...checks]
  for (const [fn, sites] of marks) {
    if (sites.size === 0) continue
    if (fn === undefined) {
      // On the first line, so that no line moves.
      inserts.push({ at: directivesEnd(code, program), text: statement(sites) })
    } else if (fn.slot) {
      inserts.push({ at: fn.slot.start, text: `(${statement(sites).slice(0, -1)},(` })
      inserts.push({ at: fn.slot.end, text: '))' })
    } else if (fn.body.type === 'BlockStatement') {
      inserts.push({ at: directivesEnd(code, fn.body), text: statement(sites) })
    } else {
      inserts.push({ at: fn.body.start, text: `(${statement(sites).slice(0, -1)},(` })
      inserts.push({ at: fn.body.end, text: '))' })
    }
  }
  let out = code
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, at) + text + out.slice(at)
  return out
}

/** Where code can go in a block or a program without ending its directives ("use strict"). */
function directivesEnd(code: string, block: Node | undefined): number {
  let at = block?.type === 'BlockStatement' ? block.start + 1 : code.startsWith('#!') ? code.indexOf('\n') + 1 : 0
  for (const statement of block?.body ?? []) {
    if (statement.type !== 'ExpressionStatement' || statement.directive == null) break
    at = statement.end
  }
  return at
}
