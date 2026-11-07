import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { parseSync } from 'oxc-parser'
import { walk, type Node } from './mutate/walk.ts'

const named = (node: Node, name: string): boolean => node?.type === 'Identifier' && node.name === name
const member = (node: Node, object: string, property: string): boolean => node?.type === 'MemberExpression' && !node.computed &&
  (object === 'this' ? node.object.type === 'ThisExpression' : named(node.object, object)) && named(node.property, property)
const call = (node: Node, name: string): boolean => node?.type === 'CallExpression' && named(node.callee, name)

function nodes(root: Node, match: (node: Node) => boolean): Node[] {
  const result: Node[] = []
  walk(root, ({ node }) => { if (match(node)) result.push(node) })
  return result
}

function bindings(pattern: Node): string[] {
  if (!pattern) return []
  if (pattern.type === 'Identifier') return [pattern.name]
  if (pattern.type === 'RestElement') return bindings(pattern.argument)
  if (pattern.type === 'AssignmentPattern') return bindings(pattern.left)
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(bindings)
  if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap((node: Node) => bindings(node.type === 'RestElement' ? node.argument : node.value))
  return []
}

function clockBinding(program: Node, name: string, source: string): boolean {
  const declarations = program.body.filter((node: Node) => node.type === 'VariableDeclaration' && node.kind === 'const')
    .flatMap((node: Node) => node.declarations).filter((node: Node) => named(node.id, name))
  if (declarations.length !== 1 || !declarations[0].init) return false
  const clock = source.slice(declarations[0].init.start, declarations[0].init.end).replace(/\s/g, '')
  return clock === 'Date.now' || clock === 'globalThis.performance?globalThis.performance.now.bind(globalThis.performance):Date.now'
}

function deadlineCheck(program: Node, wrapper: Node, executor: Node, invocation: Node, source: string): Node | undefined {
  const statements: Node[] = executor.body.body
  const resolve = statements.filter((node) => node.type === 'FunctionDeclaration' && named(node.id, 'resolve'))
  if (resolve.length !== 1) return undefined
  const body: Node[] = resolve[0].body.body
  const checks = body.filter((node) => node.type === 'IfStatement' && !node.alternate && node.consequent.type === 'BlockStatement' &&
    node.consequent.body.length === 2 && call(node.consequent.body[0].expression, 'rejectTimeoutError') &&
    node.consequent.body[1].type === 'ReturnStatement' && !node.consequent.body[1].argument)
  const settling = body.findIndex((node) => node.type === 'ExpressionStatement' && call(node.expression, 'resolve_'))
  if (checks.length !== 1 || settling <= body.indexOf(checks[0])) return undefined
  const check = checks[0].test
  const declarations: Node[] = statements.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations)
  const before = (node: Node) => node.end < invocation.start
  if (check.type === 'BinaryExpression' && ['>=', '>'].includes(check.operator) && named(check.right, 'timeout') &&
      check.left.type === 'BinaryExpression' && check.left.operator === '-' && named(check.left.right, 'startTime') &&
      check.left.left.type === 'CallExpression' && check.left.left.arguments.length === 0 && check.left.left.callee.type === 'Identifier') {
    const clock = check.left.left.callee.name
    const starts = wrapper.body.body.filter((node: Node) => node.type === 'VariableDeclaration').flatMap((node: Node) => node.declarations)
      .filter((node: Node) => named(node.id, 'startTime') && call(node.init, clock) && before(node))
    const timers = declarations.filter((node) => named(node.id, 'timer') && call(node.init, 'setTimeout') &&
      named(node.init.arguments[1], 'timeout') && before(node))
    return starts.length === 1 && timers.length === 1 && clockBinding(program, clock, source) ? check : undefined
  }
  if (check.type !== 'CallExpression' || !member(check.callee, 'deadline', 'exceeded') || check.arguments.length !== 0) return undefined
  const deadlines = declarations.filter((node) => named(node.id, 'deadline') && node.init?.type === 'NewExpression' &&
    named(node.init.callee, 'TaskDeadline') && named(node.init.arguments[0], 'timeout') && before(node))
  const classes = program.body.filter((node: Node) => node.type === 'ClassDeclaration' && named(node.id, 'TaskDeadline') && !node.superClass)
  if (deadlines.length !== 1 || classes.length !== 1) return undefined
  const fields: Node[] = classes[0].body.body
  const start = fields.find((node) => named(node.key, 'startTime'))
  const constructor = fields.find((node) => node.kind === 'constructor')?.value
  const method = fields.find((node) => named(node.key, 'exceeded'))
  const exceeded = method?.value
  if (!start || start.type !== 'PropertyDefinition' || start.static || !call(start.value, start.value?.callee?.name) || start.value.arguments.length !== 0 || !constructor ||
      !named(constructor.params[0], 'timeout') || !named(constructor.params[1], 'onTimeout') || !exceeded || exceeded.params.length !== 0 || exceeded.body.body.length !== 1) return undefined
  if (method.type !== 'MethodDefinition' || method.kind !== 'method' || method.static || exceeded.id) return undefined
  const elapsed = exceeded.body.body[0].argument
  if (exceeded.body.body[0].type !== 'ReturnStatement' || elapsed?.type !== 'BinaryExpression' || !['>=', '>'].includes(elapsed.operator) ||
      !call(elapsed.left, start.value.callee.name) || elapsed.left.arguments.length !== 0 || !member(elapsed.right, 'this', 'endTime') ||
      !clockBinding(program, start.value.callee.name, source)) return undefined
  const ends = nodes(classes[0], (node) => (node.type === 'AssignmentExpression' && member(node.left, 'this', 'endTime')) ||
    (node.type === 'UpdateExpression' && member(node.argument, 'this', 'endTime')))
  if (ends.length !== 1 || ends[0].type !== 'AssignmentExpression' || ends[0].operator !== '=' || ends[0].right.type !== 'BinaryExpression' || ends[0].right.operator !== '+' ||
      !member(ends[0].right.left, 'this', 'startTime') || !named(ends[0].right.right, 'timeout') ||
      !constructor.body.body.some((node: Node) => node.type === 'ExpressionStatement' && node.expression === ends[0]) ||
      nodes(classes[0], (node) => (node.type === 'AssignmentExpression' && member(node.left, 'this', 'startTime')) ||
        (node.type === 'UpdateExpression' && member(node.argument, 'this', 'startTime'))).length > 0) return undefined
  const timers = constructor.body.body.filter((node: Node) => node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression')
    .map((node: Node) => node.expression).filter((node: Node) => node.operator === '=' && member(node.left, 'this', 'timer') && call(node.right, 'setTimeout') &&
      named(node.right.arguments[0], 'onTimeout') && named(node.right.arguments[1], 'timeout'))
  return timers.length === 1 ? check : undefined
}

export function observeTimeouts(source: string): string | undefined {
  // The global hook timeout omits per-hook overrides; only this wrapper
  // owns the effective value and the point where its deadline starts.
  if (source.includes('__vitantHook')) return undefined
  const parsed = parseSync('vitest.js', source)
  if (parsed.errors.length > 0) return undefined
  const definitions: Node[] = []
  walk(parsed.program, ({ node }) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'withTimeout') definitions.push(node)
  })
  if (definitions.length !== 1) return undefined
  const definition = definitions[0]
  if (definition.params[0]?.name !== 'fn' || definition.params[1]?.name !== 'timeout' || definition.params[2]?.left?.name !== 'isHook') return undefined
  const wrappers: Node[] = []
  walk(definition.body, ({ node }) => {
    if (node.type === 'FunctionExpression' && node.id?.name === 'runWithTimeout') wrappers.push(node)
  })
  if (wrappers.length !== 1) return undefined
  if (wrappers[0].params.length !== 1 || wrappers[0].params[0].type !== 'RestElement' || !named(wrappers[0].params[0].argument, 'args')) return undefined
  const body = wrappers[0].body
  const promises = nodes(body, (node) => node.type === 'NewExpression' && named(node.callee, 'Promise'))
  if (promises.length !== 1 || promises[0].arguments.length !== 1) return undefined
  const executor = promises[0].arguments[0]
  if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(executor.type) || executor.body.type !== 'BlockStatement' ||
      executor.params.length !== 2 || !named(executor.params[0], 'resolve_') || !named(executor.params[1], 'reject_')) return undefined
  const calls: Node[] = []
  const settlements: Node[] = []
  let shadowed = false
  const protectedNames = new Set(['fn', 'timeout', 'isHook', 'args', 'resolve_', 'reject_', 'now', 'startTime', 'timer', 'deadline', 'TaskDeadline'])
  for (const statement of body.body) {
    if (statement.type !== 'VariableDeclaration') continue
    for (const declaration of statement.declarations) {
      if (named(declaration.id, 'startTime') && declaration.init?.type === 'CallExpression' && declaration.init.callee.type === 'Identifier') protectedNames.add(declaration.init.callee.name)
    }
  }
  const allowed = new Set<Node>([
    ...body.body.filter((node: Node) => node.type === 'VariableDeclaration' && node.kind === 'const')
      .flatMap((node: Node) => node.declarations).filter((node: Node) => named(node.id, 'startTime')),
    ...executor.body.body.filter((node: Node) => node.type === 'VariableDeclaration')
      .flatMap((node: Node) => node.declarations).filter((node: Node) => named(node.id, 'timer') || named(node.id, 'deadline')),
  ])
  if (definition.params.slice(3).flatMap(bindings).some((name: string) => protectedNames.has(name))) return undefined
  walk(definition.body, ({ node, parent, key, ancestors }) => {
    if (node.type === 'VariableDeclarator' && !allowed.has(node) && bindings(node.id).some((name) => protectedNames.has(name))) shadowed = true
    if (node.type === 'AssignmentExpression' && bindings(node.left).some((name) => protectedNames.has(name))) shadowed = true
    if (node.type === 'UpdateExpression' && bindings(node.argument).some((name) => protectedNames.has(name))) shadowed = true
    if (['ForOfStatement', 'ForInStatement'].includes(node.type) && bindings(node.left).some((name) => protectedNames.has(name))) shadowed = true
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
      if (node.id && protectedNames.has(node.id.name)) shadowed = true
      if (node !== executor && node !== wrappers[0] && node.params.flatMap(bindings).some((name: string) => protectedNames.has(name))) shadowed = true
    }
    if (node.type === 'Identifier' && ['resolve_', 'reject_'].includes(node.name)) {
      if (!(parent === executor && key === 'params') && !(parent?.type === 'CallExpression' && key === 'callee')) shadowed = true
    }
    if (node.type === 'Identifier' && node.name === 'fn' && ancestors.includes(wrappers[0])) {
      if (!(parent?.type === 'CallExpression' && key === 'callee')) shadowed = true
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return
    if (node.callee.name === 'eval') shadowed = true
    const owner = ancestors.findLast((node) => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type))
    if (node.callee.name === 'fn') {
      if (owner !== executor) shadowed = true
      calls.push(node)
    }
    if (node.callee.name === 'resolve_' || node.callee.name === 'reject_') {
      const valid = node.callee.name === 'resolve_' ? ['resolve'] : ['reject', 'rejectTimeoutError']
      if (owner?.type !== 'FunctionDeclaration' || !valid.includes(owner.id?.name)) shadowed = true
      settlements.push(node)
    }
  })
  if (shadowed || calls.length !== 1 || calls[0].arguments.length !== 1 || calls[0].arguments[0].type !== 'SpreadElement' ||
      calls[0].arguments[0].argument.name !== 'args' ||
      settlements.filter((node) => node.callee.name === 'resolve_').length !== 1 || !settlements.some((node) => node.callee.name === 'reject_')) return undefined
  const check = deadlineCheck(parsed.program, wrappers[0], executor, calls[0], source)
  if (!check) return undefined
  const edits: { start: number; end: number; text: string }[] = [
    { start: body.start + 1, end: body.start + 1, text: '\nconst __vitantHook = isHook ? globalThis.__vitant_hookStart?.(timeout) : undefined;\nconst __vitantInvoke = () => {\n' },
    { start: body.end - 1, end: body.end - 1, text: '\n};\nreturn __vitantHook ? __vitantHook.run(__vitantInvoke) : __vitantInvoke();\n' },
    { start: calls[0].start, end: calls[0].end, text: `(__vitantHook?.start(() => ${source.slice(check.start, check.end)}), ${source.slice(calls[0].start, calls[0].end)})` },
    ...settlements.map((node) => ({ start: node.start, end: node.end, text: `(__vitantHook?.end(), ${source.slice(node.start, node.end)})` })),
  ]
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return parseSync('vitest.js', source).errors.length === 0 ? source : undefined
}

export function writeHookObserver(vitestPackage: string, directory: string): string {
  const require = createRequire(vitestPackage)
  const manifest = JSON.parse(fs.readFileSync(vitestPackage, 'utf8'))
  const roots = [path.join(path.dirname(vitestPackage), 'dist')]
  if (manifest.dependencies?.['@vitest/runner']) roots.push(path.dirname(require.resolve('@vitest/runner')))
  const modules: Record<string, { hash: string; source: string }> = {}
  for (const root of roots) {
    for (const name of fs.globSync('**/*.js', { cwd: root })) {
      const file = path.join(root, name)
      const source = fs.readFileSync(file, 'utf8')
      if (!source.includes('function withTimeout(')) continue
      const observed = observeTimeouts(source)
      if (observed === undefined) throw new Error(`Cannot observe Vitest hook deadlines in ${file}`)
      modules[pathToFileURL(fs.realpathSync(file)).href] = { hash: createHash('sha256').update(source).digest('hex'), source: observed }
    }
  }
  if (Object.keys(modules).length !== 1) throw new Error('Expected exactly one Vitest hook timeout implementation')
  const data = path.join(directory, 'hook-modules.json')
  const preload = path.join(directory, 'hooks.cjs')
  fs.writeFileSync(data, JSON.stringify(modules))
  fs.writeFileSync(preload, `
const { registerHooks } = require('node:module')
const { createHash } = require('node:crypto')
const modules = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(data)}, 'utf8'))
globalThis.__vitant_hookPatched = false
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    const patch = modules[url]
    if (!patch) return loaded
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source ?? '').toString('utf8')
    if (createHash('sha256').update(source).digest('hex') !== patch.hash) throw new Error('Vitest hook timeout source changed before worker load')
    globalThis.__vitant_hookPatched = { module: url, hash: patch.hash }
    return { ...loaded, source: patch.source }
  },
})
`)
  return preload
}
