import type { Node } from './walk.ts'

/**
 * A top-level `const` whose value can only reach the rest of the program by
 * being read. Its initializer runs no code of the program, cannot throw, and
 * has no effect beyond the value it makes, so with a mutant in it the
 * module's evaluation differs from the unmutated one only in the values such
 * bindings hold. A run that never reads one of them is then the unmutated run
 * as far as the mutant goes (under the same determinism every skipped run
 * assumes), and does not have to be made.
 */
export interface Watched {
  name: string
  /** The initializer. */
  init: [number, number]
  /** Functions inside the initializer: their bodies do not run while it is evaluated. */
  deferred: [number, number][]
  /** Names of earlier watched bindings the initializer reads while it is evaluated. */
  reads: string[]
  /** Names other modules can import it by. */
  exportedAs: string[]
  /**
   * Whether the initializer builds a `Set` or a `Map`, freezes an object or
   * reads a property of another such binding, which runs no code of the program
   * only as long as those are the built-ins and `Object.prototype` holds what
   * it did; that is checked as the module loads.
   */
  builtins: boolean
  /**
   * Where the `const` of its declaration is, when the value can be made
   * again once the module has loaded, see `instrument`: the declaration
   * declares nothing else, nothing in the module assigns it, and nothing the
   * value is made from can have changed since, as `process.env` can.
   */
  again?: number
  /** Whether its value is a primitive by the syntax of its initializer, which nothing can change once made. */
  primitive: boolean
}

const unwrap = (node: Node): Node => {
  while (node && /^(TSAsExpression|TSSatisfiesExpression|TSNonNullExpression|TSTypeAssertion|ParenthesizedExpression)$/.test(node.type)) node = node.expression
  return node
}

const functionTypes = new Set(['ArrowFunctionExpression', 'FunctionExpression'])

/** Parameters of the helper being checked, each with the argument it was called with and the scope that argument is read in. */
type Scope = Map<string, Bound> | undefined
interface Bound {
  node: Node
  scope: Scope
}

const undefinedNode = { type: 'Identifier', name: 'undefined' }

/**
 * Whether `node` evaluates without running code of the program, throwing
 * or doing anything but make a value, for every mutant of it as well.
 * Operators convert their operands, which calls `valueOf` or `toString` on
 * an object, so they only take values that are primitive by their syntax,
 * and no BigInt, which a mutant can put under an operator that throws on it
 * (`+1n`, `1n / 0n`); `in` and `instanceof` throw on a primitive and are not
 * taken at all. A property read is taken from `process.env`, whose values are
 * strings, and of a key an earlier binding of this kind has as its own in an
 * object literal with no accessors: a mutant that empties the object leaves
 * the read to `Object.prototype`, so no key of that is taken, and that nothing
 * was added to it is checked as the module loads. A spread of an object runs
 * its getters, so it only takes a binding of this kind made by an object
 * literal that has none; a spread into an array needs an iterable and is not
 * taken. A `Map` is only taken from a list of pairs written out with at least
 * one: a mutant makes an empty list `["Stryker was here"]`, and a string is no
 * pair.
 */
function makeChecker(candidates: Map<string, Node>, shadowed: Set<string>, used: { builtins: boolean }, helpers: Map<string, Node>) {
  let depth = 0
  const resolve = (name: string, scope: Scope): Bound | undefined => {
    const bound = scope?.get(name)
    if (bound) return bound
    const init = candidates.get(name)
    return init === undefined ? undefined : { node: init, scope: undefined }
  }
  /**
   * A call of a function of the module that only returns an expression of
   * its parameters, `function f(type, opts) { return { type, ...opts } }`:
   * the expression is checked with each parameter bound to its argument, and
   * the argument read where the call is. The function's other names are the
   * module's: it is declared at its top.
   */
  const call = (node: Node, scope: Scope): boolean => {
    const { callee } = node
    const helper = callee.type === 'Identifier' && !node.optional && !scope?.has(callee.name) ? helpers.get(callee.name) : undefined
    if (!helper || depth > 4 || node.arguments.some((argument: Node) => argument.type === 'SpreadElement' || !pure(argument, scope))) return false
    const inner: Scope = new Map(helper.params.map((param: Node, index: number) => [param.name, { node: node.arguments[index] ?? undefinedNode, scope }]))
    depth++
    try {
      return pure(helper.body.body[0].argument, inner)
    } finally {
      depth--
    }
  }
  const nothing = (bound: Bound) => {
    const node = unwrap(bound.node)
    return node.type === 'Identifier' && node.name === 'undefined' && resolve('undefined', bound.scope) === undefined
  }
  const builtin = (node: Node, name: string, scope: Scope) => node.type === 'Identifier' && node.name === name && !shadowed.has(name) && !scope?.has(name)
  /** Elements that are there, none spread: a hole is read through the prototype. */
  const dense = (raw: Node, scope: Scope) => {
    const node = unwrap(raw)
    return node.type === 'ArrayExpression' && node.elements.every((element: Node) => element !== null && element.type !== 'SpreadElement' && pure(element, scope))
  }
  const isEnv = (raw: Node, scope: Scope): boolean => {
    const node = unwrap(raw)
    if (node.type !== 'MemberExpression' || node.optional) return false
    const object = unwrap(node.object)
    if (object.type !== 'MemberExpression' || object.computed || object.optional) return false
    if (!builtin(unwrap(object.object), 'process', scope) || object.property.name !== 'env') return false
    return node.computed ? unwrap(node.property).type === 'Literal' && typeof unwrap(node.property).value === 'string' : true
  }
  /** What a property read of that kind gives, or undefined for any other. */
  const member = (raw: Node, scope: Scope): Bound | undefined => {
    const node = unwrap(raw)
    if (node.type !== 'MemberExpression' || node.optional) return undefined
    const object = unwrap(node.object)
    const bound = object.type === 'Identifier' ? resolve(object.name, scope) : undefined
    const literal = bound && unwrap(bound.node)
    if (literal?.type !== 'ObjectExpression' || !literal.properties.every((p: Node) => p.type === 'Property' && p.kind === 'init' && !p.computed)) return undefined
    const key = node.computed ? (unwrap(node.property).type === 'Literal' ? unwrap(node.property).value : undefined) : node.property.name
    if (typeof key !== 'string' || key in Object.prototype) return undefined
    const own = literal.properties.findLast((p: Node) => (p.key.type === 'Identifier' ? p.key.name : String(p.key.value)) === key)
    if (!own) return undefined
    used.builtins = true
    return { node: own.value, scope: bound!.scope }
  }
  const primitive = (raw: Node, scope: Scope): boolean => {
    const node = unwrap(raw)
    const read = member(node, scope)
    if (read) return primitive(read.node, read.scope)
    switch (node.type) {
      case 'Literal':
        return node.regex === undefined && node.bigint === undefined
      case 'TemplateLiteral':
        return node.expressions.every((expression: Node) => primitive(expression, scope))
      case 'UnaryExpression':
        return node.operator !== 'delete' && (node.operator === 'typeof' || node.operator === 'void' ? pure(node.argument, scope) : primitive(node.argument, scope))
      case 'BinaryExpression':
        return node.operator !== 'in' && node.operator !== 'instanceof' && primitive(node.left, scope) && primitive(node.right, scope)
      case 'LogicalExpression':
        return primitive(node.left, scope) && primitive(node.right, scope)
      case 'ConditionalExpression':
        return pure(node.test, scope) && primitive(node.consequent, scope) && primitive(node.alternate, scope)
      case 'Identifier': {
        const bound = resolve(node.name, scope)
        return bound !== undefined && primitive(bound.node, bound.scope)
      }
      default:
        return isEnv(node, scope)
    }
  }
  const accessorFree = (bound: Bound): boolean => {
    const node = unwrap(bound.node)
    return node.type === 'ObjectExpression' && node.properties.every((p: Node) => p.type === 'Property' && p.kind === 'init')
  }
  const pure = (raw: Node, scope: Scope): boolean => {
    const node = unwrap(raw)
    switch (node.type) {
      case 'ArrowFunctionExpression':
      case 'FunctionExpression':
        return true
      case 'Literal':
        return true
      case 'Identifier':
        return resolve(node.name, scope) !== undefined || node.name === 'undefined'
      case 'ArrayExpression':
        return node.elements.every((element: Node) => element === null || (element.type !== 'SpreadElement' && pure(element, scope)))
      case 'ObjectExpression':
        return node.properties.every((property: Node) => {
          if (property.type === 'SpreadElement') {
            const argument = unwrap(property.argument)
            const bound = argument.type === 'Identifier' ? resolve(argument.name, scope) : undefined
            return bound !== undefined && (accessorFree(bound) || nothing(bound))
          }
          if (property.computed && !primitive(property.key, scope)) return false
          return property.kind !== 'init' || property.method || pure(property.value, scope)
        })
      case 'LogicalExpression':
        return pure(node.left, scope) && pure(node.right, scope)
      case 'ConditionalExpression':
        return pure(node.test, scope) && pure(node.consequent, scope) && pure(node.alternate, scope)
      case 'MemberExpression':
        return member(node, scope) !== undefined || isEnv(node, scope)
      case 'NewExpression': {
        const [entries, ...rest] = node.arguments
        const set = builtin(node.callee, 'Set', scope)
        if ((!set && !builtin(node.callee, 'Map', scope)) || rest.length > 0) return false
        if (entries !== undefined && !dense(entries, scope)) return false
        if (!set && entries !== undefined && !(unwrap(entries).elements.length > 0 && unwrap(entries).elements.every((entry: Node) => dense(entry, scope)))) return false
        used.builtins = true
        return true
      }
      case 'CallExpression': {
        if (call(node, scope)) return true
        const { callee } = node
        if (callee.type !== 'MemberExpression' || callee.computed || callee.optional || node.optional) return false
        if (!builtin(callee.object, 'Object', scope) || callee.property.name !== 'freeze') return false
        if (node.arguments.length !== 1 || node.arguments[0].type === 'SpreadElement' || !pure(node.arguments[0], scope)) return false
        used.builtins = true
        return true
      }
      default:
        return primitive(node, scope)
    }
  }
  return { pure: (node: Node) => pure(node, undefined), primitive: (node: Node) => primitive(node, undefined) }
}

/** Names an expression reads while it is evaluated, outside the functions in it. */
export function loadReads(node: Node, deferred: [number, number][]): Set<string> {
  const names = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach(visit)
    const current = value as Node
    if (typeof current.type !== 'string') return
    if (functionTypes.has(current.type)) {
      deferred.push([current.start, current.end])
      return
    }
    if (current.type === 'Identifier') names.add(current.name)
    for (const [key, child] of Object.entries(current)) if (key !== 'typeAnnotation') visit(child)
  }
  visit(node)
  return names
}

/** The module's top-level bindings of that kind, by name. */
export function watchedBindings(program: Node): Map<string, Watched> {
  const candidates = new Map<string, Node>()
  // A name the module declares or imports is not the built-in.
  const shadowed = new Set<string>()
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement
    if (declaration?.id?.type === 'Identifier') shadowed.add(declaration.id.name)
    for (const specifier of statement.type === 'ImportDeclaration' ? statement.specifiers : []) shadowed.add(specifier.local.name)
    if (declaration?.type === 'VariableDeclaration') for (const declarator of declaration.declarations) loadReads(declarator.id, []).forEach((name) => shadowed.add(name))
  }
  // A function that only returns an expression of its parameters, never assigned another value.
  const assigned = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) return value.forEach(visit)
    const node = value as Node
    if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression' || node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      loadReads(node.left ?? node.argument, []).forEach((name) => assigned.add(name))
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'type') visit(child)
  }
  visit(program)
  // A name declared twice is the last of them, or a variable that gets a value of its own.
  const declared = new Map<string, number>()
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement
    const names = declaration?.type === 'VariableDeclaration' ? declaration.declarations.flatMap((d: Node) => [...loadReads(d.id, [])]) : declaration?.id?.type === 'Identifier' ? [declaration.id.name] : []
    for (const specifier of statement.type === 'ImportDeclaration' ? statement.specifiers : []) names.push(specifier.local.name)
    for (const name of names) declared.set(name, (declared.get(name) ?? 0) + 1)
  }
  const helpers = new Map<string, Node>()
  for (const statement of program.body) {
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (declaration?.type !== 'FunctionDeclaration' || !declaration.id || declaration.async || declaration.generator || assigned.has(declaration.id.name) || declared.get(declaration.id.name) !== 1) continue
    const [only, ...more] = declaration.body?.body ?? []
    if (more.length > 0 || only?.type !== 'ReturnStatement' || !only.argument) continue
    if (declaration.params.every((param: Node) => param.type === 'Identifier')) helpers.set(declaration.id.name, declaration)
  }
  /** Names a helper's expression reads besides its parameters, those of the helpers it calls included. */
  const helperReads = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name) || !helpers.has(name)) return []
    seen.add(name)
    const helper = helpers.get(name)!
    const params = new Set(helper.params.map((param: Node) => param.name))
    const names = [...loadReads(helper.body.body[0].argument, [])].filter((read) => !params.has(read))
    return [...names, ...names.flatMap((read) => helperReads(read, seen))]
  }
  const used = { builtins: false }
  const { pure, primitive } = makeChecker(candidates, shadowed, used, helpers)
  const watched = new Map<string, Watched>()
  for (const statement of program.body) {
    const exported = statement.type === 'ExportNamedDeclaration'
    const declaration = exported ? statement.declaration : statement
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const' || declaration.declare) continue
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== 'Identifier' || !declarator.init) continue
      // Checked against the bindings declared before it: a later one is in
      // its temporal dead zone and throws.
      used.builtins = false
      if (!pure(declarator.init)) continue
      const deferred: [number, number][] = []
      const direct = [...loadReads(declarator.init, deferred)]
      const everything = [...new Set([...direct, ...direct.flatMap((name) => helperReads(name))])]
      const reads = everything.filter((name) => candidates.has(name))
      const again = declaration.declarations.length === 1 && !assigned.has(declarator.id.name) && !everything.includes('process') ? declaration.start : undefined
      candidates.set(declarator.id.name, declarator.init)
      watched.set(declarator.id.name, {
        name: declarator.id.name,
        init: [declarator.init.start, declarator.init.end],
        deferred,
        reads,
        exportedAs: exported ? [declarator.id.name] : [],
        builtins: used.builtins,
        again,
        primitive: primitive(declarator.init),
      })
    }
  }
  for (const statement of program.body) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.source || statement.declaration) continue
    for (const specifier of statement.specifiers) {
      if (specifier.local.type !== 'Identifier') continue
      const exportedName = specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value
      watched.get(specifier.local.name)?.exportedAs.push(exportedName)
    }
  }
  return watched
}

/** Per binding, itself and every watched binding whose value is made from its own while the module loads. */
export function slices(watched: Map<string, Watched>): Map<string, Set<string>> {
  const dependents = new Map<string, string[]>()
  for (const binding of watched.values()) {
    for (const read of binding.reads) dependents.set(read, [...(dependents.get(read) ?? []), binding.name])
  }
  const result = new Map<string, Set<string>>()
  for (const name of watched.keys()) {
    const slice = new Set([name])
    const queue = [name]
    while (queue.length > 0) for (const next of dependents.get(queue.pop()!) ?? []) if (!slice.has(next)) slice.add(next) && queue.push(next)
    result.set(name, slice)
  }
  return result
}

/** The watched binding a range lies in, where it lies in the part of the initializer evaluated as the module loads. */
export function bindingAt(watched: Map<string, Watched>, start: number, end: number): Watched | undefined {
  for (const binding of watched.values()) {
    if (start < binding.init[0] || end > binding.init[1]) continue
    if (binding.deferred.some(([from, to]) => start >= from && end <= to)) return undefined
    return binding
  }
  return undefined
}
