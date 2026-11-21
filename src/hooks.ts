import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { parseSync } from 'oxc-parser'
import { walk, type Node } from './mutate/walk.ts'
import { HOOK_GLOBAL } from './session.ts'

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

/** `new Error(makeTimeoutMsg(isHook, timeout))`, what a late call is rejected with before Vitest 3.0.9. */
function timeoutError(node: Node): boolean {
  return node?.type === 'NewExpression' && named(node.callee, 'Error') && node.arguments.length === 1 && call(node.arguments[0], 'makeTimeoutMsg') &&
    node.arguments[0].arguments.length === 2 && named(node.arguments[0].arguments[0], 'isHook') && named(node.arguments[0].arguments[1], 'timeout')
}

const statementCall = (node: Node, name: string): boolean => node?.type === 'ExpressionStatement' && call(node.expression, name)

/** `clock() - startTime >= timeout`, with `startTime` and the timer set before the call of the hook. */
function elapsedCheck(check: Node, program: Node, wrapper: Node, declarations: Node[], before: (node: Node) => boolean, source: string): boolean {
  if (check?.type !== 'BinaryExpression' || !['>=', '>'].includes(check.operator) || !named(check.right, 'timeout') ||
      check.left.type !== 'BinaryExpression' || check.left.operator !== '-' || !named(check.left.right, 'startTime') ||
      check.left.left.type !== 'CallExpression' || check.left.left.arguments.length !== 0 || check.left.left.callee.type !== 'Identifier') return false
  const clock = check.left.left.callee.name
  const starts = wrapper.body.body.filter((node: Node) => node.type === 'VariableDeclaration').flatMap((node: Node) => node.declarations)
    .filter((node: Node) => named(node.id, 'startTime') && call(node.init, clock) && before(node))
  const timers = declarations.filter((node) => named(node.id, 'timer') && call(node.init, 'setTimeout') &&
    named(node.init.arguments[1], 'timeout') && before(node))
  return starts.length === 1 && timers.length === 1 && clockBinding(program, clock, source)
}

/**
 * Vitest 3.0.2 and 3.0.3 check the clock only in the `then` of a result
 * that is a thenable: a hook that returns no promise passes however late it
 * returns, which is not known while its body runs.
 */
function thenableCheck(program: Node, wrapper: Node, statements: Node[], declarations: Node[], invocation: Node, source: string): boolean {
  const tries = statements.filter((node) => node.type === 'TryStatement')
  if (tries.length !== 1) return false
  const [result, branch] = tries[0].block.body
  if (tries[0].block.body.length !== 2 || result.type !== 'VariableDeclaration' || result.declarations.length !== 1 ||
      !named(result.declarations[0].id, 'result') || result.declarations[0].init !== invocation) return false
  const single = (block: Node, name: string, argument: string) => block?.type === 'BlockStatement' && block.body.length === 1 &&
    statementCall(block.body[0], name) && block.body[0].expression.arguments.length === 1 && named(block.body[0].expression.arguments[0], argument)
  const caught = tries[0].handler
  if (tries[0].finalizer || !caught || !named(caught.param, 'error') || !single(caught.body, 'reject', 'error')) return false
  if (branch.type !== 'IfStatement' || !single(branch.alternate, 'resolve', 'result')) return false
  const then = branch.consequent.type === 'BlockStatement' && branch.consequent.body.length === 1 && branch.consequent.body[0].expression
  if (then?.type !== 'CallExpression' || !member(then.callee, 'result', 'then') || then.arguments.length !== 2 || !named(then.arguments[1], 'reject')) return false
  const settle = then.arguments[0]
  if (settle.type !== 'ArrowFunctionExpression' || settle.params.length !== 1 || settle.params[0].type !== 'Identifier' ||
      settle.body.type !== 'BlockStatement' || settle.body.body.length !== 1) return false
  const late = settle.body.body[0]
  if (late.type !== 'IfStatement' || late.consequent.type !== 'BlockStatement' || late.alternate?.type !== 'BlockStatement' ||
      late.consequent.body.length !== 1 || !statementCall(late.consequent.body[0], 'reject') ||
      late.consequent.body[0].expression.arguments.length !== 1 || !timeoutError(late.consequent.body[0].expression.arguments[0]) ||
      late.alternate.body.length !== 1 || !statementCall(late.alternate.body[0], 'resolve') ||
      late.alternate.body[0].expression.arguments.length !== 1 || !named(late.alternate.body[0].expression.arguments[0], settle.params[0].name)) return false
  return elapsedCheck(late.test, program, wrapper, declarations, (node) => node.end < invocation.start, source)
}

/**
 * The expression that says Vitest would fail the hook if it returned now,
 * and the `reject_` in `resolve` that settles it as late where Vitest
 * before 3.0.9 calls one there.
 */
function deadlineCheck(program: Node, wrapper: Node, executor: Node, invocation: Node, source: string): { check: string; early?: Node } | undefined {
  const statements: Node[] = executor.body.body
  const resolve = statements.filter((node) => node.type === 'FunctionDeclaration' && named(node.id, 'resolve'))
  if (resolve.length !== 1) return undefined
  const body: Node[] = resolve[0].body.body
  const declarations: Node[] = statements.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations)
  const before = (node: Node) => node.end < invocation.start
  const checks = body.filter((node) => node.type === 'IfStatement' && !node.alternate && node.consequent.type === 'BlockStatement' &&
    node.consequent.body.length === 2 && (call(node.consequent.body[0].expression, 'rejectTimeoutError') ||
      (statementCall(node.consequent.body[0], 'reject_') && node.consequent.body[0].expression.arguments.length === 1 &&
        timeoutError(node.consequent.body[0].expression.arguments[0]))) &&
    node.consequent.body[1].type === 'ReturnStatement' && !node.consequent.body[1].argument)
  const settling = body.findIndex((node) => node.type === 'ExpressionStatement' && call(node.expression, 'resolve_'))
  if (checks.length === 0 && body.length === 2 && statementCall(body[0], 'clearTimeout') && settling === 1 &&
      thenableCheck(program, wrapper, statements, declarations, invocation, source)) return { check: 'false' }
  if (checks.length !== 1 || settling <= body.indexOf(checks[0])) return undefined
  const check = checks[0].test
  const early = call(checks[0].consequent.body[0].expression, 'reject_') ? checks[0].consequent.body[0].expression : undefined
  if (elapsedCheck(check, program, wrapper, declarations, before, source)) return { check: source.slice(check.start, check.end), early }
  if (early || check.type !== 'CallExpression' || !member(check.callee, 'deadline', 'exceeded') || check.arguments.length !== 0) return undefined
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
  return timers.length === 1 ? { check: source.slice(check.start, check.end) } : undefined
}

/**
 * Vitest 3.0.0 and 3.0.1 race the call against a timer that is never
 * cleared, and a result waits for a timer of its own before it settles:
 * whether a late return fails comes from the order Node runs two expired
 * timers in, which no expression of the wrapper holds. A hook that throws
 * before it returns keeps its observation until that timer fires.
 */
function raceForm(wrapper: Node): { executor: Node; invocation: Node; settlements: Node[]; rejected: number } | undefined {
  const [statement] = wrapper.body.body
  if (wrapper.body.body.length !== 1 || statement.type !== 'ReturnStatement' || statement.argument?.type !== 'CallExpression' ||
      !member(statement.argument.callee, 'Promise', 'race') || statement.argument.arguments.length !== 1) return undefined
  const list = statement.argument.arguments[0]
  if (list.type !== 'ArrayExpression' || list.elements.length !== 2) return undefined
  const [deadline, result] = list.elements
  if (deadline?.type !== 'NewExpression' || !named(deadline.callee, 'Promise') || deadline.arguments.length !== 1) return undefined
  const executor = deadline.arguments[0]
  if (executor.type !== 'ArrowFunctionExpression' || executor.body.type !== 'BlockStatement' || executor.params.length !== 2 ||
      !named(executor.params[0], 'resolve') || !named(executor.params[1], 'reject')) return undefined
  // `var _a`, the timer, and the call of its `unref`.
  const [scratch, timer, unref] = executor.body.body
  if (executor.body.body.length !== 3 || scratch.type !== 'VariableDeclaration' || scratch.kind !== 'var' || scratch.declarations.some((node: Node) => node.init) ||
      unref.type !== 'ExpressionStatement' || !nodes(unref, (node) => named(node, 'unref')).length) return undefined
  if (timer.type !== 'VariableDeclaration' || timer.kind !== 'const' || timer.declarations.length !== 1 ||
      !named(timer.declarations[0].id, 'timer') || !call(timer.declarations[0].init, 'setTimeout') || timer.declarations[0].init.arguments.length !== 2 ||
      !named(timer.declarations[0].init.arguments[1], 'timeout')) return undefined
  const expire = timer.declarations[0].init.arguments[0]
  if (expire.type !== 'ArrowFunctionExpression' || expire.params.length !== 0 || expire.body.type !== 'BlockStatement' || expire.body.body.length !== 2 ||
      !statementCall(expire.body.body[0], 'clearTimeout') || !statementCall(expire.body.body[1], 'reject') ||
      expire.body.body[1].expression.arguments.length !== 1 || !timeoutError(expire.body.body[1].expression.arguments[0])) return undefined
  // Nothing else in the executor may settle the deadline's promise.
  if (nodes(executor.body, (node) => node.type === 'Identifier' && ['resolve', 'reject'].includes(node.name)).length !== 1) return undefined
  if (result?.type !== 'CallExpression' || result.callee.type !== 'MemberExpression' || !named(result.callee.property, 'then') || result.arguments.length !== 1) return undefined
  const started = result.callee.object
  if (started.type !== 'CallExpression' || !member(started.callee, 'Promise', 'resolve') || started.arguments.length !== 1 || !call(started.arguments[0], 'fn')) return undefined
  const settle = result.arguments[0]
  if (settle.type !== 'ArrowFunctionExpression' || settle.params.length !== 1 || settle.params[0].type !== 'Identifier' ||
      settle.body.type !== 'BlockStatement' || settle.body.body.length !== 1 || settle.body.body[0].type !== 'ReturnStatement') return undefined
  const delayed = settle.body.body[0].argument
  const wait = delayed?.type === 'NewExpression' && named(delayed.callee, 'Promise') && delayed.arguments.length === 1 && delayed.arguments[0]
  if (wait?.type !== 'ArrowFunctionExpression' || wait.params.length !== 1 || !named(wait.params[0], 'resolve') || !call(wait.body, 'setTimeout') ||
      wait.body.arguments.length !== 3 || !named(wait.body.arguments[0], 'resolve') || wait.body.arguments[1].type !== 'Literal' ||
      wait.body.arguments[1].value !== 0 || !named(wait.body.arguments[2], settle.params[0].name)) return undefined
  return { executor, invocation: started.arguments[0], settlements: [expire.body.body[1].expression, delayed], rejected: settle.end }
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
  const race = promises.length === 2 ? raceForm(wrappers[0]) : undefined
  if (!race && (promises.length !== 1 || promises[0].arguments.length !== 1)) return undefined
  const executor = race ? race.executor : promises[0].arguments[0]
  if (!race && (!['ArrowFunctionExpression', 'FunctionExpression'].includes(executor.type) || executor.body.type !== 'BlockStatement' ||
      executor.params.length !== 2 || !named(executor.params[0], 'resolve_') || !named(executor.params[1], 'reject_'))) return undefined
  const calls: Node[] = []
  const settlements: Node[] = []
  const early: Node[] = []
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
      if (owner !== (race ? wrappers[0] : executor)) shadowed = true
      calls.push(node)
    }
    if (node.callee.name === 'resolve_' || node.callee.name === 'reject_') {
      const valid = node.callee.name === 'resolve_' ? ['resolve'] : ['reject', 'rejectTimeoutError']
      if (owner?.type === 'FunctionDeclaration' && node.callee.name === 'reject_' && named(owner.id, 'resolve')) early.push(node)
      else if (owner?.type !== 'FunctionDeclaration' || !valid.includes(owner.id?.name)) shadowed = true
      settlements.push(node)
    }
  })
  if (shadowed || calls.length !== 1 || calls[0].arguments.length !== 1 || calls[0].arguments[0].type !== 'SpreadElement' ||
      calls[0].arguments[0].argument.name !== 'args') return undefined
  if (race ? settlements.length > 0 || calls[0] !== race.invocation
    : settlements.filter((node) => node.callee.name === 'resolve_').length !== 1 || !settlements.some((node) => node.callee.name === 'reject_')) return undefined
  const deadline = race ? { check: 'false', early: undefined } : deadlineCheck(parsed.program, wrappers[0], executor, calls[0], source)
  if (!deadline || early.length !== (deadline.early ? 1 : 0) || (deadline.early && early[0] !== deadline.early)) return undefined
  const edits: { start: number; end: number; text: string }[] = [
    { start: body.start + 1, end: body.start + 1, text: `\nconst __vitantHook = isHook && typeof ${HOOK_GLOBAL} !== 'undefined' ? ${HOOK_GLOBAL}.start?.(timeout) : undefined;\nconst __vitantInvoke = () => {\n` },
    { start: body.end - 1, end: body.end - 1, text: '\n};\nreturn __vitantHook ? __vitantHook.run(__vitantInvoke) : __vitantInvoke();\n' },
    { start: calls[0].start, end: calls[0].end, text: `(__vitantHook?.start(() => ${deadline.check}), ${source.slice(calls[0].start, calls[0].end)})` },
    // A handler that rethrows takes the one job the default handler would take.
    ...(race ? [{ start: race.rejected, end: race.rejected, text: ', (error) => { __vitantHook?.end(); throw error; }' }] : []),
    ...(race?.settlements ?? settlements).map((node) => ({ start: node.start, end: node.end, text: `(__vitantHook?.end(), ${source.slice(node.start, node.end)})` })),
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
const hook = require('node:vm').runInThisContext('let ${HOOK_GLOBAL} = { patched: false }; ${HOOK_GLOBAL}')
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    const patch = modules[url]
    if (!patch) return loaded
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source ?? '').toString('utf8')
    if (createHash('sha256').update(source).digest('hex') !== patch.hash) throw new Error('Vitest hook timeout source changed before worker load')
    hook.patched = { module: url, hash: patch.hash }
    return { ...loaded, source: patch.source }
  },
})
`)
  return preload
}
