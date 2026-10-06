import type { Node } from './walk.ts'

export interface NodeMutation {
  mutator: string
  /** Range of the node this mutation replaces. */
  start: number
  end: number
  replacement: string
  /**
   * How to tell, from the values the original code produced, whether this
   * mutation would have produced something else. Mutations without it are
   * assumed to change behaviour whenever their code runs.
   */
  probe?: Probe
}

export type Probe =
  /** The node is `left <operator> right` and the mutation swaps the operator. */
  | { kind: 'operator'; operator: string }
  /** The mutation replaces the node with a constant; `truthiness` when only that is observed. */
  | { kind: 'constant'; value: boolean; truthiness: boolean }
  /** The replacement is a literal, so an enclosing operator can be applied to it without running any code twice. */
  | { kind: 'literal' }

export interface MutatorContext {
  source: string
  parent: Node | undefined
  /** Property of `parent` that holds the node. */
  key: string | undefined
  ancestors: readonly Node[]
  /** Finds `operator` between two offsets, ignoring comments. */
  findOperator: (from: number, to: number, operator: string) => number
}

const arithmetic: Record<string, string> = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' }

const equality: Record<string, string[]> = {
  '<': ['<=', '>='],
  '<=': ['<', '>'],
  '>': ['>=', '<='],
  '>=': ['>', '<'],
  '==': ['!='],
  '!=': ['=='],
  '===': ['!=='],
  '!==': ['==='],
}

const logical: Record<string, string> = { '&&': '||', '||': '&&', '??': '&&' }

const assignment: Record<string, string> = {
  '+=': '-=',
  '-=': '+=',
  '*=': '/=',
  '/=': '*=',
  '%=': '*=',
  '<<=': '>>=',
  '>>=': '<<=',
  '&=': '|=',
  '|=': '&=',
  '&&=': '||=',
  '||=': '&&=',
  '??=': '&&=',
}

const booleanOperators = new Set(['!=', '!==', '&&', '<', '<=', '==', '===', '>', '>=', '||'])

const methods = new Map<string, string | null>([
  ['charAt', null],
  ['endsWith', 'startsWith'],
  ['every', 'some'],
  ['filter', null],
  ['reverse', null],
  ['slice', null],
  ['sort', null],
  ['substr', null],
  ['substring', null],
  ['toLocaleLowerCase', 'toLocaleUpperCase'],
  ['toLowerCase', 'toUpperCase'],
  ['trim', null],
  ['trimEnd', 'trimStart'],
  ['min', 'max'],
  ['setDate', 'setTime'],
  ['setFullYear', 'setMonth'],
  ['setHours', 'setMinutes'],
  ['setSeconds', 'setMilliseconds'],
  ['setUTCDate', 'setTime'],
  ['setUTCFullYear', 'setUTCMonth'],
  ['setUTCHours', 'setUTCMinutes'],
  ['setUTCSeconds', 'setUTCMilliseconds'],
])
for (const [key, value] of [...methods]) {
  if (value && key !== 'setUTCDate') methods.set(value, key)
}

function isStringNode(node: Node): boolean {
  return (
    node.type === 'TemplateLiteral' || (node.type === 'Literal' && typeof node.value === 'string')
  )
}

function text(ctx: MutatorContext, node: Node): string {
  return ctx.source.slice(node.start, node.end)
}

function swapOperator(
  ctx: MutatorContext,
  node: Node,
  from: number,
  to: number,
  operator: string,
  replacement: string,
): string | undefined {
  const at = ctx.findOperator(from, to, operator)
  if (at < 0) return undefined
  return (
    ctx.source.slice(node.start, at) + replacement + ctx.source.slice(at + operator.length, node.end)
  )
}

type Yield = [mutator: string, replacement: string, probe?: Probe]
type Mutator = (node: Node, ctx: MutatorContext) => Iterable<Yield>

const byType: Record<string, Mutator[]> = {
  BinaryExpression: [
    function* (node, ctx) {
      const replacement = arithmetic[node.operator]
      if (!replacement) return
      const left = node.left.type === 'BinaryExpression' ? node.left.right : node.left
      if (isStringNode(node.right) || isStringNode(left)) return
      const mutated = swapOperator(
        ctx,
        node,
        node.left.end,
        node.right.start,
        node.operator,
        replacement,
      )
      if (mutated) {
        yield ['ArithmeticOperator', mutated, { kind: 'operator', operator: replacement }]
      }
    },
    function* (node, ctx) {
      for (const replacement of equality[node.operator] ?? []) {
        const mutated = swapOperator(
          ctx,
          node,
          node.left.end,
          node.right.start,
          node.operator,
          replacement,
        )
        if (mutated) {
          yield ['EqualityOperator', mutated, { kind: 'operator', operator: replacement }]
        }
      }
    },
  ],
  LogicalExpression: [
    function* (node, ctx) {
      const replacement = logical[node.operator]
      if (!replacement) return
      // `??` may not stand next to `&&` or `||` without parentheses, so an
      // operand that would end up there gets them.
      const mixes = (operand: Node) =>
        operand.type === 'LogicalExpression' && (operand.operator === '??') !== (replacement === '??')
      if (mixes(node.left) || mixes(node.right)) {
        const text = (operand: Node) => {
          const source = ctx.source.slice(operand.start, operand.end)
          return mixes(operand) ? `(${source})` : source
        }
        yield ['LogicalOperator', `${text(node.left)} ${replacement} ${text(node.right)}`]
        return
      }
      const mutated = swapOperator(
        ctx,
        node,
        node.left.end,
        node.right.start,
        node.operator,
        replacement,
      )
      if (mutated) yield ['LogicalOperator', mutated]
    },
  ],
  AssignmentExpression: [
    function* (node, ctx) {
      const replacement = assignment[node.operator]
      if (!replacement) return
      if (isStringNode(node.right) && !['&&=', '||=', '??='].includes(node.operator)) return
      const mutated = swapOperator(
        ctx,
        node,
        node.left.end,
        node.right.start,
        node.operator,
        replacement,
      )
      if (mutated) yield ['AssignmentOperator', mutated]
    },
  ],
  UnaryExpression: [
    function* (node, ctx) {
      if (node.operator === '!') yield ['BooleanLiteral', text(ctx, node.argument)]
      else if (node.operator === '+') yield ['UnaryOperator', `-${text(ctx, node.argument)}`]
      else if (node.operator === '-') yield ['UnaryOperator', `+${text(ctx, node.argument)}`]
      else if (node.operator === '~') yield ['UnaryOperator', text(ctx, node.argument)]
    },
  ],
  UpdateExpression: [
    function* (node, ctx) {
      const replacement = node.operator === '++' ? '--' : '++'
      const argument = text(ctx, node.argument)
      yield ['UpdateOperator', node.prefix ? replacement + argument : argument + replacement]
    },
  ],
  Literal: [
    function* (node, ctx) {
      if (typeof node.value === 'boolean') {
        yield ['BooleanLiteral', String(!node.value), { kind: 'literal' }]
      } else if (typeof node.value === 'string' && isMutableString(node, ctx)) {
        yield [
          'StringLiteral',
          node.value.length === 0 ? '"Stryker was here!"' : '""',
          { kind: 'literal' },
        ]
      }
    },
  ],
  TemplateLiteral: [
    function* (node) {
      const empty = node.quasis.length === 1 && node.quasis[0].value.raw.length === 0
      // Emptying a template drops the evaluation of what it interpolates.
      const probe: Probe | undefined = node.expressions.length === 0 ? { kind: 'literal' } : undefined
      yield ['StringLiteral', empty ? '`Stryker was here!`' : '``', probe]
    },
  ],
  ArrayExpression: [
    function* (node) {
      yield ['ArrayDeclaration', node.elements.length ? '[]' : '["Stryker was here"]']
    },
  ],
  ObjectExpression: [
    function* (node) {
      if (node.properties.length > 0) yield ['ObjectLiteral', '{}']
    },
  ],
  ArrowFunctionExpression: [
    function* (node) {
      if (node.body.type === 'BlockStatement') return
      if (node.body.type === 'Identifier' && node.body.name === 'undefined') return
      yield ['ArrowFunction', '() => undefined']
    },
  ],
  CallExpression: [arrayConstructor, methodExpression, optionalCall],
  NewExpression: [arrayConstructor],
  MemberExpression: [
    function* (node, ctx) {
      if (!node.optional) return
      const at = ctx.findOperator(node.object.end, node.property.start, '?.')
      if (at < 0) return
      yield [
        'OptionalChaining',
        ctx.source.slice(node.start, at) +
          (node.computed ? '' : '.') +
          ctx.source.slice(at + 2, node.end),
      ]
    },
  ],
  BlockStatement: [
    function* (node, ctx) {
      if (node.body.length === 0 || isInvalidConstructorBody(node, ctx)) return
      // Emptied in the source, a block takes its `var` declarations with it,
      // and code after it that reads one fails for the name not existing. A
      // switch can only skip the block: the declarations stay. A function's
      // body keeps them to itself, so there the two are the same.
      const isFunctionBody = ctx.parent !== undefined && 'params' in ctx.parent
      if (!isFunctionBody && declaresVar(node)) return
      yield ['BlockStatement', '{}']
    },
  ],
  SwitchCase: [
    function* (node, ctx) {
      if (node.consequent.length === 0) return
      yield [
        'ConditionalExpression',
        ctx.source.slice(node.start, node.consequent[0].start).trimEnd(),
      ]
    },
  ],
}

function* arrayConstructor(node: Node): Iterable<Yield> {
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'Array') return
  const args = node.arguments.length ? '' : '[]'
  yield ['ArrayDeclaration', `${node.type === 'NewExpression' ? 'new ' : ''}Array(${args})`]
}

function* methodExpression(node: Node, ctx: MutatorContext): Iterable<Yield> {
  const { callee } = node
  if (callee.type !== 'MemberExpression' || callee.computed) return
  if (callee.property.type !== 'Identifier') return
  const replacement = methods.get(callee.property.name)
  if (replacement === undefined) return
  if (replacement === null) {
    // Sliced from the call's own start so parentheses around the receiver,
    // which the AST does not record, stay balanced.
    const receiver = ctx.source.slice(node.start, callee.property.start).trimEnd()
    yield ['MethodExpression', receiver.replace(/\??\.$/, '')]
    return
  }
  yield [
    'MethodExpression',
    ctx.source.slice(node.start, callee.property.start) +
      replacement +
      ctx.source.slice(callee.property.end, node.end),
  ]
}

function* optionalCall(node: Node, ctx: MutatorContext): Iterable<Yield> {
  if (!node.optional) return
  const at = ctx.findOperator(node.callee.end, node.end, '?.')
  if (at < 0) return
  yield ['OptionalChaining', ctx.source.slice(node.start, at) + ctx.source.slice(at + 2, node.end)]
}

function isMutableString(node: Node, ctx: MutatorContext): boolean {
  const { parent, key } = ctx
  if (!parent) return false
  switch (parent.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportDefaultDeclaration':
    case 'ImportExpression':
    case 'ImportAttribute':
    case 'ImportSpecifier':
    case 'ExportSpecifier':
    case 'TSExternalModuleReference':
    case 'JSXAttribute':
    case 'ExpressionStatement':
      return false
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'AccessorProperty':
      return key !== 'key'
    case 'CallExpression':
      return !(
        parent.callee.type === 'Identifier' &&
        (parent.callee.name === 'require' || parent.callee.name === 'Symbol')
      )
    default:
      return true
  }
}

/**
 * Emptying a derived constructor that TypeScript rewrites (parameter
 * properties, initialized fields) yields code that fails to compile rather
 * than a mutant a test could kill.
 */
/** Whether a `var` is declared under the node, outside any function inside it. */
function declaresVar(node: Node): boolean {
  if (node.type === 'VariableDeclaration' && node.kind === 'var') return true
  for (const key in node) {
    const value = node[key]
    if (key === 'type' || value === null || typeof value !== 'object') continue
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child === null || typeof child !== 'object' || typeof child.type !== 'string') continue
      if ('params' in child) continue
      if (declaresVar(child)) return true
    }
  }
  return false
}

function isInvalidConstructorBody(block: Node, ctx: MutatorContext): boolean {
  const fn = ctx.parent
  const method = ctx.ancestors.at(-2)
  if (!fn || method?.type !== 'MethodDefinition' || method.kind !== 'constructor') return false
  const classBody = ctx.ancestors.at(-3)
  const rewritten =
    fn.params.some((param: Node) => param.type === 'TSParameterProperty') ||
    classBody?.body.some((member: Node) => member.type === 'PropertyDefinition' && member.value)
  return Boolean(rewritten) && /\bsuper\s*\(/.test(ctx.source.slice(block.start, block.end))
}

function patternNames(pattern: Node | null | undefined, names: Set<string>): void {
  if (!pattern) return
  switch (pattern.type) {
    case 'Identifier':
      names.add(pattern.name)
      break
    case 'ObjectPattern':
      for (const property of pattern.properties) patternNames(property.value ?? property.argument, names)
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) patternNames(element, names)
      break
    case 'AssignmentPattern':
      patternNames(pattern.left, names)
      break
    case 'RestElement':
      patternNames(pattern.argument, names)
      break
    case 'TSParameterProperty':
      patternNames(pattern.parameter, names)
      break
  }
}

function declaredBy(statement: Node, names: Set<string>): void {
  switch (statement.type) {
    case 'VariableDeclaration':
      for (const declarator of statement.declarations) patternNames(declarator.id, names)
      break
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSEnumDeclaration':
      patternNames(statement.id, names)
      break
    case 'ImportDeclaration':
      for (const specifier of statement.specifiers) names.add(specifier.local.name)
      break
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
      if (statement.declaration) declaredBy(statement.declaration, names)
      break
  }
}

/** Names that `scope` itself binds for the code inside it. */
function bindingsOf(scope: Node): Set<string> {
  const names = new Set<string>()
  if ('params' in scope) {
    for (const param of scope.params) patternNames(param, names)
    if (scope.type === 'FunctionExpression') patternNames(scope.id, names)
  }
  const statements =
    scope.type === 'Program' || scope.type === 'BlockStatement' || scope.type === 'StaticBlock'
      ? scope.body
      : scope.type === 'SwitchStatement'
        ? scope.cases.flatMap((entry: Node) => entry.consequent)
        : []
  for (const statement of statements) declaredBy(statement, names)
  if (scope.type === 'ForStatement' && scope.init) declaredBy(scope.init, names)
  if (scope.type === 'ForInStatement' || scope.type === 'ForOfStatement') declaredBy(scope.left, names)
  if (scope.type === 'CatchClause') patternNames(scope.param, names)
  if (scope.type === 'ClassExpression' || scope.type === 'ClassDeclaration') patternNames(scope.id, names)
  return names
}

const fixedGlobals = new Set(['undefined', 'NaN', 'Infinity'])

/**
 * Whether reading the identifier can run no code: it names a binding found
 * in an enclosing scope, or one of the globals that cannot be redefined. Any
 * other name may be a global, and a global can be an accessor. A `var`
 * declared in a nested block is not found, which only errs on that side.
 */
export function isPlainName(name: string, ancestors: readonly Node[]): boolean {
  if (fixedGlobals.has(name)) return true
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (bindingsOf(ancestors[i]).has(name)) return true
  }
  return false
}

/** A property read that can be checked, as it happens, to run no getter and no proxy trap. */
export function isPlainRead(node: Node): boolean {
  return (
    node.type === 'MemberExpression' &&
    !node.optional &&
    node.object.type !== 'Super' &&
    node.property.type !== 'PrivateIdentifier'
  )
}

/** A binary operator that calls `valueOf` or `toString` on an object operand. */
export function convertsOperands(node: Node): boolean {
  return node.type === 'BinaryExpression' && !['===', '!==', 'in', 'instanceof'].includes(node.operator)
}

function* conditional(node: Node, ctx: MutatorContext): Iterable<Yield> {
  const { parent, key } = ctx
  if (!parent) return
  const constant = (value: boolean, truthiness: boolean): Yield => [
    'ConditionalExpression',
    String(value),
    { kind: 'constant', value, truthiness },
  ]
  const isLoop =
    parent.type === 'ForStatement' ||
    parent.type === 'WhileStatement' ||
    parent.type === 'DoWhileStatement'
  if (isLoop && key === 'test') {
    yield constant(false, true)
  } else if (parent.type === 'IfStatement' && key === 'test') {
    yield constant(true, true)
    yield constant(false, true)
  } else if (
    (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') &&
    booleanOperators.has(node.operator)
  ) {
    // `true || y` and `false && y` behave like replacing the whole expression,
    // which the parent already gets as its own mutant.
    if (parent.type === 'LogicalExpression' && parent.operator === '||') {
      yield constant(false, false)
    } else if (parent.type === 'LogicalExpression' && parent.operator === '&&') {
      yield constant(true, false)
    } else {
      yield constant(true, false)
      yield constant(false, false)
    }
  }
}

export function mutationsOf(node: Node, ctx: MutatorContext): NodeMutation[] {
  const result: NodeMutation[] = []
  const push = ([mutator, replacement, probe]: Yield) => {
    if (replacement !== ctx.source.slice(node.start, node.end)) {
      result.push({ mutator, start: node.start, end: node.end, replacement, probe })
    }
  }
  for (const mutator of byType[node.type] ?? []) {
    for (const mutation of mutator(node, ctx)) push(mutation)
  }
  for (const mutation of conditional(node, ctx)) push(mutation)
  return result
}
