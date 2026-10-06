import { parseSync } from 'oxc-parser'
import { convertsOperands, isPlainName, isPlainRead, mutationsOf, type NodeMutation } from './mutators.ts'
import { type Node, walk } from './walk.ts'

/** Name of the global object that instrumented code reads at runtime. */
export const RUNTIME_GLOBAL = '__vitant__'

export interface Position {
  /** 1-based. */
  line: number
  /** 0-based, in UTF-16 code units. */
  column: number
}

export interface Mutant {
  id: number
  site: number
  mutator: string
  replacement: string
  start: number
  end: number
  loc: { start: Position; end: Position }
  /**
   * Whether the unmutated run records if this mutant would have changed a
   * value. An untracked mutant counts as changing behaviour wherever it runs.
   */
  tracked: boolean
}

export interface InstrumentResult {
  code: string
  mutants: Mutant[]
  siteCount: number
  /** Mutations that had no position where a runtime switch could be placed. */
  unplaced: number
}

export interface InstrumentOptions {
  /** First site id to assign; ids are global across files. */
  siteBase: number
  /** First mutant id to assign. */
  mutantBase: number
  /** Only keep mutants whose code lies entirely on these 1-based lines. */
  lines?: ReadonlySet<number>
}

/** `loop` sites carry no mutants; they only bound how long a loop may spin. */
type SiteKind = 'loop' | 'expr' | 'block' | 'case'

interface Site {
  kind: SiteKind
  start: number
  end: number
  /** Where the switched region begins for `block` and `case` sites. */
  bodyStart: number
  /** The name an anonymous arrow function takes from where it stands, which it would lose once wrapped. */
  name?: string
  /** Operand ranges when the site is a binary expression whose operands are probed separately. */
  operands?: { left: [number, number]; right: [number, number]; operator: string }
  /**
   * Callee and argument ranges when the site is a call the probe makes
   * itself: of a function that may be a built-in whose result depends on
   * nothing but its arguments. `receiver` is the global the function is a
   * property of.
   */
  call?: { callee: [number, number]; args: [number, number][]; receiver?: string }
  /** The block is the body of a function. */
  functionBody?: boolean
  /**
   * Object range and key, a name or a range, when the site is a property read
   * inside a condition that a mutant replaces. The read goes through a check
   * that it runs no getter.
   */
  read?: { object: [number, number]; key: string | [number, number] }
  /** Whether the site reports an operand that the operator had to convert. */
  guard?: boolean
  /** The name, when the site reads what may be a global inside such a condition. */
  global?: string
  /** Whether evaluating the site inside such a condition counts as something that may have run code. */
  mark?: boolean
  /** Whether only the truthiness of the site's value is observed. */
  test: boolean
  mutations: NodeMutation[]
  children: Site[]
  id: number
  firstMutant: number
  plan?: ProbePlan
  /** Whether the enclosing site's probe decides if this site's mutants changed anything. */
  deferred: boolean
}

/** What a site's probe works out during the unmutated run. */
interface ProbePlan {
  /** Indexes of the site's own mutations whose value the probe computes. */
  own: number[]
  /**
   * Per operand or argument, the mutants below it whose effect this probe
   * carries on. Absent when the probe only looks at the site's own value.
   */
  feeds?: Feed[]
}

interface Feed {
  /** The input is a site that hands over the values its mutants would have produced. */
  shadows: boolean
  /** Mutants that replace the input with a literal. */
  literals: { id: number; text: string }[]
}

function inputsOf(site: Site): [number, number][] {
  if (site.operands) return [site.operands.left, site.operands.right]
  return site.call?.args ?? []
}

function inputSite(site: Site, range: [number, number]): Site | undefined {
  return site.children.find(
    (child) => child.kind === 'expr' && child.start === range[0] && child.end === range[1],
  )
}

const namespaces = new Set(['Math', 'Number', 'Array', 'Object'])

const statementLists = new Set(['Program', 'BlockStatement', 'StaticBlock', 'SwitchCase'])

const wrappers = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion'])

/**
 * Whether evaluating the node itself, apart from its operands, can do nothing
 * but produce a value or throw.
 */
function isTransparent(node: Node, ancestors: readonly Node[]): boolean {
  switch (node.type) {
    case 'ThisExpression':
    case 'LogicalExpression':
    case 'ConditionalExpression':
      return true
    case 'Literal':
      return node.regex === undefined
    case 'TemplateLiteral':
      return node.expressions.length === 0
    case 'UnaryExpression':
      // `typeof` of a name that may be a global cannot go through the check
      // other names get: reading an undeclared one there would throw.
      if (node.operator === 'typeof' && node.argument.type === 'Identifier') {
        return isPlainName(node.argument.name, ancestors)
      }
      return ['!', 'typeof', 'void'].includes(node.operator)
    case 'BinaryExpression':
      return node.operator === '===' || node.operator === '!=='
    case 'ArrayExpression':
      return node.elements.every((element: Node | null) => element !== null && element.type !== 'SpreadElement')
    case 'ObjectExpression':
      return node.properties.every(
        (property: Node) =>
          property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed,
      )
    default:
      return wrappers.has(node.type)
  }
}

const testParents = new Set([
  'IfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ConditionalExpression',
])

// `__vitant_is` is `Object.is`, which a test could replace. Shadow lists are
// chains of `{k: mutant, v: value, n: next}` rather than arrays: adding to an
// array goes through whatever a test has put on `Array.prototype`, an
// accessor at an index for one, and an object literal's own properties do not.
const probeHelpers = [
  'function __vitant_is(x,y){return x===y?x!==0||1/x===1/y:x!==x&&y!==y}',
  'function __vitant_plain(v){return v===null||typeof v!=="object"&&typeof v!=="function"}',
  `function __vitant_mark(s){for(;s;s=s.n)${RUNTIME_GLOBAL}.i[s.k]=1}`,
  `function __vitant_markTruthy(s,o){for(;s;s=s.n)if(!s.v!==!o)${RUNTIME_GLOBAL}.i[s.k]=1}`,
  // Counts a read that may have run code: an accessor, a proxy, or a key that
  // had to be converted. Primitives are looked up from their prototype.
  `function __vitant_get(o,k){var R=${RUNTIME_GLOBAL};if(R.a<0){if(!__vitant_plain(k))R.v++;else if(o!==null&&o!==void 0)` +
    '__vitant_data(R,__vitant_plain(o)?R.O(R.B(o)):o,k)}return o[k]}',
  // For a property written with a dot the read itself stays where it was
  // written: one shared `o[k]` for every property of every object of a file
  // is the slowest read there is, and it is made on each evaluation,
  // mutant or not.
  `function __vitant_at(o,k){var R=${RUNTIME_GLOBAL};if(R.a<0&&o!==null&&o!==void 0)` +
    '__vitant_data(R,__vitant_plain(o)?R.O(R.B(o)):o,k);return o}',
  // The same check for a name that may be a property of the global object.
  `function __vitant_name(k,v){var R=${RUNTIME_GLOBAL};if(R.a<0)__vitant_data(R,R.g,k);return v}`,
  'function __vitant_data(R,p,k){for(;p!==null;p=R.O(p)){if(R.P(p)){R.v++;break}var d=R.G(p,k);if(d){if(d.get)R.v++;break}}}',
].join('\n')

function replacesSite(site: Site, mutation: NodeMutation): boolean {
  return mutation.start === site.start && mutation.end === site.end
}

/**
 * Decides, children first, which mutants the unmutated run can clear. A
 * mutant's changed value is followed through enclosing arithmetic,
 * comparisons and `Math` calls for as long as nothing else could have
 * observed it; it counts only if it still differs where the chain ends.
 */
function planProbes(site: Site, tracked: Set<number>): void {
  for (const child of site.children) planProbes(child, tracked)
  if (site.kind !== 'expr') return
  const own: number[] = []
  site.mutations.forEach((mutation, index) => {
    const kind = mutation.probe?.kind
    if (!replacesSite(site, mutation)) return
    if (kind === 'constant' || (kind === 'operator' && site.operands)) own.push(index)
  })
  const inputs = inputsOf(site)
  const feeds = inputs.map((range): Feed => {
    const child = inputSite(site, range)
    if (!child) return { shadows: false, literals: [] }
    const literals = child.mutations.flatMap((mutation, index) =>
      mutation.probe?.kind === 'literal' && replacesSite(child, mutation)
        ? [{ id: child.firstMutant + index, text: mutation.replacement }]
        : [],
    )
    return { shadows: child.plan?.feeds !== undefined, literals }
  })
  const fed = feeds.some((feed) => feed.shadows || feed.literals.length > 0)
  if (own.length === 0 && !fed && !site.guard) return
  site.plan = { own, feeds: site.operands || fed || (site.call && site.guard) ? feeds : undefined }
  for (const index of own) tracked.add(site.firstMutant + index)
  if (!site.plan.feeds) return
  feeds.forEach((feed, index) => {
    for (const literal of feed.literals) tracked.add(literal.id)
    if (feed.shadows) inputSite(site, inputs[index])!.deferred = true
  })
}

const expressionTypes = new Set([
  'ArrayExpression',
  'ArrowFunctionExpression',
  'AssignmentExpression',
  'AwaitExpression',
  'BinaryExpression',
  'CallExpression',
  'ChainExpression',
  'ClassExpression',
  'ConditionalExpression',
  'FunctionExpression',
  'Identifier',
  'ImportExpression',
  'JSXElement',
  'JSXFragment',
  'Literal',
  'LogicalExpression',
  'MemberExpression',
  'MetaProperty',
  'NewExpression',
  'ObjectExpression',
  'SequenceExpression',
  'TaggedTemplateExpression',
  'TemplateLiteral',
  'ThisExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'UnaryExpression',
  'UpdateExpression',
  'YieldExpression',
])

/** The name the language gives an anonymous function that is the `key` child of `parent`. */
function givenName(parent: Node, key: string): string | undefined {
  const nameOf = (node: Node): string | undefined =>
    node.type === 'Identifier'
      ? node.name
      : node.type === 'PrivateIdentifier'
        ? `#${node.name}`
        : node.type === 'Literal' && node.regex === undefined && node.bigint === undefined
          ? String(node.value)
          : undefined
  switch (parent.type) {
    case 'VariableDeclarator':
      return key === 'init' && parent.id.type === 'Identifier' ? parent.id.name : undefined
    case 'AssignmentExpression':
      return key === 'right' && parent.left.type === 'Identifier' && ['=', '||=', '&&=', '??='].includes(parent.operator)
        ? parent.left.name
        : undefined
    case 'AssignmentPattern':
      return key === 'right' && parent.left.type === 'Identifier' ? parent.left.name : undefined
    case 'Property':
    case 'PropertyDefinition': {
      if (key !== 'value' || parent.computed) return undefined
      const name = nameOf(parent.key)
      // `__proto__: value` sets the prototype and names nothing.
      return parent.type === 'Property' && name === '__proto__' ? undefined : name
    }
    case 'ExportDefaultDeclaration':
      return 'default'
    default:
      return undefined
  }
}

function isChainLink(node: Node): boolean {
  return (
    node.type === 'MemberExpression' ||
    node.type === 'CallExpression' ||
    node.type === 'TSNonNullExpression'
  )
}

/**
 * Whether `node` can be wrapped in a parenthesized conditional without
 * changing what the surrounding code means.
 */
function canPlaceExpression(node: Node, parent: Node, key: string, grandparent?: Node): boolean {
  switch (parent.type) {
    case 'MemberExpression':
      if (key === 'object') return !isChainLink(node)
      return parent.computed
    case 'CallExpression':
      // `(a?.b)()` still calls with `a` as `this`; a conditional in its place would not.
      return !(key === 'callee' && (isChainLink(node) || node.type === 'ChainExpression'))
    case 'TSNonNullExpression':
      return !isChainLink(node)
    case 'ChainExpression':
    case 'TaggedTemplateExpression':
    case 'UpdateExpression':
    case 'ArrayPattern':
    case 'ObjectPattern':
    case 'RestElement':
    case 'JSXElement':
    case 'JSXFragment':
    case 'JSXAttribute':
    case 'Decorator':
      return false
    case 'UnaryExpression':
      return parent.operator !== 'delete'
    case 'AssignmentExpression':
    case 'AssignmentPattern':
    case 'ForInStatement':
    case 'ForOfStatement':
      return key !== 'left'
    case 'VariableDeclarator':
      return key !== 'id'
    case 'Property':
      if (key === 'key') return false
      return grandparent?.type !== 'ObjectPattern'
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'AccessorProperty':
      return key !== 'key'
    default:
      return true
  }
}

function hasLexicalDeclaration(statements: Node[]): boolean {
  return statements.some(
    (statement) =>
      statement.type === 'ClassDeclaration' ||
      statement.type === 'FunctionDeclaration' ||
      (statement.type === 'VariableDeclaration' && statement.kind !== 'var'),
  )
}

function lineStartsOf(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function positionAt(lineStarts: number[], offset: number): Position {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (lineStarts[mid] <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: offset - lineStarts[low] }
}

export function instrument(
  source: string,
  filename: string,
  options: InstrumentOptions,
): InstrumentResult | undefined {
  const parsed = parseSync(filename, source, { preserveParens: false })
  if (parsed.errors.some((error) => error.severity === 'Error')) return undefined

  const comments = parsed.comments
  const findOperator = (from: number, to: number, operator: string): number => {
    let commentIndex = 0
    for (let i = from; i <= to - operator.length; i++) {
      while (commentIndex < comments.length && comments[commentIndex].end <= i) commentIndex++
      const comment = comments[commentIndex]
      if (comment && comment.start <= i) {
        i = comment.end - 1
        continue
      }
      if (source.startsWith(operator, i)) return i
    }
    return -1
  }

  const lineStarts = lineStartsOf(source)
  const inScope = (start: number, end: number): boolean => {
    if (!options.lines) return true
    const first = positionAt(lineStarts, start).line
    const last = positionAt(lineStarts, end).line
    for (let line = first; line <= last; line++) {
      if (!options.lines.has(line)) return false
    }
    return true
  }

  const sites = new Map<string, Site>()
  const path: { node: Node; key: string | undefined }[] = []
  let unplaced = 0
  // Probes call built-ins as properties of these globals; a file that uses
  // one of the names in any other way might have its own.
  const notGlobal = new Set<string>()
  interface Condition {
    node: Node
    mutations: NodeMutation[]
    /** Something in it can run code where no count of it can be placed. */
    broken: boolean
    /** How many sealed nodes enclosed it. */
    sealedAt: number
  }
  const conditions: Condition[] = []
  /** Where expression statements in a list of statements begin. */
  const statementStarts = new Set<number>()
  /** Enclosing conditions that a tracked constant replaces. */
  const guarded: Condition[] = []
  /** Enclosing nodes below which nothing is checked: they count as a whole, or run nothing. */
  const sealed: Node[] = []

  const siteFor = (
    kind: SiteKind,
    node: Node,
    bodyStart: number,
    name?: string,
    test = false,
  ): Site => {
    const id = `${kind}:${node.start}:${node.end}`
    let site = sites.get(id)
    if (!site) {
      site = {
        kind,
        start: node.start,
        end: node.end,
        bodyStart,
        name,
        test,
        mutations: [],
        children: [],
        id: -1,
        firstMutant: -1,
        deferred: false,
      }
      sites.set(id, site)
    }
    return site
  }

  const place = (node: Node): Site | undefined => {
    if (node.type === 'BlockStatement') {
      const parent = path.at(-2)?.node
      const isFunctionBody = parent && 'params' in parent
      const directives = isFunctionBody
        ? node.body.filter(
            (statement: Node) =>
              statement.type === 'ExpressionStatement' && statement.directive != null,
          )
        : []
      const site = siteFor('block', node, directives.at(-1)?.end ?? node.start + 1)
      site.functionBody = Boolean(isFunctionBody)
      return site
    }
    if (node.type === 'SwitchCase') {
      if (hasLexicalDeclaration(node.consequent)) return undefined
      return siteFor('case', node, node.consequent[0].start)
    }
    for (let i = path.length - 1; i > 0; i--) {
      const candidate = path[i].node
      if (!expressionTypes.has(candidate.type)) return undefined
      const parent = path[i - 1].node
      if (canPlaceExpression(candidate, parent, path[i].key!, path[i - 2]?.node)) {
        return siteFor(
          'expr',
          candidate,
          candidate.start,
          candidate.type === 'ArrowFunctionExpression' ? givenName(parent, path[i].key!) : undefined,
          testParents.has(parent.type) && path[i].key === 'test',
        )
      }
    }
    return undefined
  }

  walk(
    parsed.program,
    ({ node, parent, key, ancestors }) => {
      path.push({ node, key })
      if (!parent) return
      if (
        node.type === 'ForStatement' ||
        node.type === 'WhileStatement' ||
        node.type === 'DoWhileStatement'
      ) {
        siteFor('loop', node.body, node.body.start)
      }
      if (node.type === 'ExpressionStatement' && statementLists.has(parent.type)) statementStarts.add(node.start)
      if (node.type === 'Identifier' && namespaces.has(node.name)) {
        if (parent.type !== 'MemberExpression' || key !== 'object') notGlobal.add(node.name)
      }
      const operandsOf = (binary: Node): Site['operands'] => ({
        left: [binary.left.start, binary.left.end],
        right: [binary.right.start, binary.right.end],
        operator: binary.operator,
      })
      const mutations = mutationsOf(node, { source, parent, key, ancestors, findOperator })
      if (mutations.length > 0 && inScope(node.start, node.end)) {
        const site = place(node)
        if (site) {
          site.mutations.push(...mutations)
          if (site.kind === 'expr' && node.type === 'BinaryExpression' && site.start === node.start && site.end === node.end) {
            site.operands = operandsOf(node)
          }
          if (mutations.some((mutation) => mutation.probe?.kind === 'constant')) {
            const condition = { node, mutations, broken: false, sealedAt: sealed.length }
            guarded.push(condition)
            conditions.push(condition)
          }
        } else {
          unplaced += mutations.length
        }
      }
      const callee = node.type === 'CallExpression' ? node.callee : undefined
      const receiver: string | undefined =
        callee?.type === 'MemberExpression' && !callee.optional && callee.object.type === 'Identifier'
          ? callee.object.name
          : undefined
      const callable =
        callee !== undefined &&
        !node.optional &&
        node.arguments.every((argument: Node) => argument.type !== 'SpreadElement') &&
        canPlaceExpression(node, parent, key!, ancestors.at(-2))
      const asCall = (): Site => {
        const site = siteFor('expr', node, node.start, undefined, testParents.has(parent.type) && key === 'test')
        site.call = {
          callee: [callee.start, callee.end],
          args: node.arguments.map((argument: Node) => [argument.start, argument.end]),
          receiver,
        }
        return site
      }
      // A condition inside a sealed part of another is checked for its own
      // sake; the outer one already counts that part as a whole.
      const open = guarded.filter((condition) => condition.sealedAt === sealed.length)
      if (open.length === 0) {
        // Outside a replaced condition only `Math` calls matter, for carrying
        // a changed argument through them.
        if (callable && receiver === 'Math' && node.arguments.length > 0) asCall()
        return
      }
      // A constant in place of a condition drops the evaluation of everything
      // in it, so what could run code there is checked, or counted, as it is
      // evaluated.
      if (!expressionTypes.has(node.type)) return
      if (node.type === 'Identifier') {
        const named =
          (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) ||
          (parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand)
        if (named || isPlainName(node.name, ancestors)) return
        // `{ name }` reads the name, and has no place to put the check.
        if (parent.type === 'Property' && parent.shorthand) for (const condition of open) condition.broken = true
        else siteFor('expr', node, node.start).global = node.name
      } else if (isPlainRead(node)) {
        siteFor('expr', node, node.start).read = {
          object: [node.object.start, node.object.end],
          key: node.computed ? [node.property.start, node.property.end] : node.property.name,
        }
      } else if (convertsOperands(node)) {
        const site = siteFor('expr', node, node.start)
        site.operands ??= operandsOf(node)
        site.guard = true
      } else if (callable && (callee.type === 'Identifier' || (receiver !== undefined && namespaces.has(receiver)))) {
        asCall().guard = true
      } else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
        // Creating a function runs nothing, and its body is not part of the condition.
        sealed.push(node)
      } else if (!isTransparent(node, ancestors)) {
        if (canPlaceExpression(node, parent, key!, ancestors.at(-2))) siteFor('expr', node, node.start).mark = true
        else for (const condition of open) condition.broken = true
        sealed.push(node)
      }
    },
    ({ node }) => {
      path.pop()
      if (guarded.at(-1)?.node === node) guarded.pop()
      if (sealed.at(-1) === node) sealed.pop()
    },
  )

  for (const condition of conditions) {
    if (!condition.broken) continue
    for (const mutation of condition.mutations) if (mutation.probe?.kind === 'constant') mutation.probe = undefined
  }
  for (const site of sites.values()) {
    if (!site.call?.receiver || !notGlobal.has(site.call.receiver)) continue
    // The call is made in place again, so its callee has to stay the member
    // expression it was: read through a check, the method would lose its `this`.
    const [calleeStart, calleeEnd] = site.call.callee
    for (const inner of sites.values()) {
      if (inner.start === calleeStart && inner.end === calleeEnd) inner.read = undefined
    }
    site.call = undefined
    if (site.guard) {
      site.guard = false
      site.mark = true
    }
  }
  const ordered = [...sites.values()]
    .filter((site) => site.kind === 'loop' || site.mutations.length > 0 || site.call || site.read || site.guard || site.global || site.mark)
    // A loop guard has to wrap a block site that covers the same range.
    .sort((a, b) => a.start - b.start || b.end - a.end || Number(b.kind === 'loop') - 1)
  if (ordered.every((site) => site.mutations.length === 0)) {
    return { code: source, mutants: [], siteCount: 0, unplaced }
  }

  const roots: Site[] = []
  const stack: Site[] = []
  const mutants: Mutant[] = []
  let nextMutant = options.mutantBase
  let siteCount = 0
  for (const site of ordered) {
    if (site.mutations.length > 0) site.id = options.siteBase + siteCount++
    site.firstMutant = nextMutant
    for (const mutation of site.mutations) {
      mutants.push({
        id: nextMutant++,
        site: site.id,
        mutator: mutation.mutator,
        replacement: mutation.replacement,
        start: mutation.start,
        end: mutation.end,
        loc: {
          start: positionAt(lineStarts, mutation.start),
          end: positionAt(lineStarts, mutation.end),
        },
        tracked: false,
      })
    }
    while (stack.length > 0 && stack.at(-1)!.end <= site.start) stack.pop()
    const parent = stack.at(-1)
    if (parent) parent.children.push(site)
    else roots.push(site)
    stack.push(site)
  }

  const tracked = new Set<number>()
  for (const root of roots) planProbes(root, tracked)
  for (const mutant of mutants) mutant.tracked = tracked.has(mutant.id)

  // Probes are function declarations so they exist before any module code
  // runs, including code reached through an import cycle.
  const probes: string[] = []
  let probeCount = 0
  const G = RUNTIME_GLOBAL
  const inside = (site: Site, range: [number, number]) =>
    renderRange(
      range[0],
      range[1],
      site.children.filter((child) => child.start >= range[0] && child.end <= range[1]),
    )
  const probe = (site: Site): string => {
    // Rendered at most once: rendering a child registers its probe.
    const whole = () => {
      if (site.mark) return `(${G}.v++,(${renderRange(site.start, site.end, site.children)}))`
      if (site.global) return `__vitant_name(${JSON.stringify(site.global)},${site.global})`
      if (!site.read) return renderRange(site.start, site.end, site.children)
      const { object, key } = site.read
      const dotted = typeof key === 'string' && /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(key) && source.slice(site.end - key.length - 1, site.end) === `.${key}`
      if (dotted) return `__vitant_at((${inside(site, object)}),${JSON.stringify(key)}).${key}`
      const name = typeof key === 'string' ? JSON.stringify(key) : `(${inside(site, key)})`
      return `__vitant_get((${inside(site, object)}),${name})`
    }
    const { plan } = site
    if (!plan) return whole()
    const name = `__vitant_p${probeCount++}`
    if (!plan.feeds) {
      const marks = plan.own.map((index) => {
        const constant = site.mutations[index].probe as { value: boolean; truthiness: boolean }
        const differs =
          constant.truthiness || site.test
            ? constant.value ? '!o' : 'o'
            : `o!==${constant.value}`
        return `if(${differs})I[${site.firstMutant + index}]=1;`
      })
      const all = plan.own.map((index) => `I[${site.firstMutant + index}]=`).join('')
      // `c` is the count of checked reads and conversions that may have run
      // code, taken before the condition was evaluated.
      probes.push(
        `function ${name}(c,o){${G}.b[${site.id}]--;if(${G}.a<0){var I=${G}.i;` +
          `if(${G}.v!==c){${all}1}else{${marks.join('')}}}return o}`,
      )
      return `(${G}.b[${site.id}]++,${name}(${G}.v,${whole()}))`
    }

    const inputs = inputsOf(site)
    const values = inputs.map((_, index) => `x${index}`)
    const apply = (args: string[]) =>
      site.operands
        ? `${args[0]} ${site.operands.operator} ${args[1]}`
        : `${G}.y(f,${site.call!.receiver ?? 'void 0'},[${args.join(',')}])`
    const replacing = (index: number, value: string) =>
      apply(values.map((name, at) => (at === index ? value : name)))
    const keep = (id: string) => `if(!__vitant_is(m,o))s={k:${id},v:m,n:s}`
    // An alternative can throw where the original did not, e.g. BigInt division by zero.
    const attempt = (id: string, alternative: string) =>
      `try{m=${alternative};${keep(id)}}catch{I[${id}]=1}`
    const computed: string[] = []
    const constants: string[] = []
    const constantIds: number[] = []
    const ids: (number | string)[] = []
    const inherited: string[] = []
    for (const index of plan.own) {
      const id = site.firstMutant + index
      const own = site.mutations[index].probe!
      if (own.kind === 'operator') {
        computed.push(attempt(String(id), `x0${own.operator}x1`))
        ids.push(id)
      } else if (own.kind === 'constant') {
        constants.push(`if(o!==${own.value})s={k:${id},v:${own.value},n:s};`)
        constantIds.push(id)
        ids.push(id)
      }
    }
    plan.feeds.forEach((feed, index) => {
      for (const literal of feed.literals) {
        computed.push(attempt(String(literal.id), replacing(index, `(${literal.text})`)))
        ids.push(literal.id)
      }
      if (!feed.shadows) return
      const list = `a${index}`
      computed.push(
        `for(k=${list};k;k=k.n){${attempt('k.k', replacing(index, 'k.v'))}}`,
      )
      inherited.push(`__vitant_mark(${list});`)
    })
    // Alternatives are computed only where that runs no code of the program:
    // on primitives, since an object would have its `valueOf` or `toString`
    // called once more than in the original, and through `Math` functions that
    // are still the built-in ones.
    const converts = site.operands && !['===', '!=='].includes(site.operands.operator)
    const plain = values.map((value) => `__vitant_plain(${value})`)
    const pure = site.call
      ? `(${G}.A(f)||${[`${G}.N(f)`, ...plain].join('&&')})`
      : converts
        ? plain.join('&&')
        : 'true'
    const dropsEvaluation = constantIds.length > 0
    if (dropsEvaluation) {
      computed.push(
        `if(${G}.v!==c){${constantIds.map((id) => `I[${id}]=`).join('')}1}else{${constants.join('')}}`,
      )
    }
    const impure =
      `${ids.map((id) => `I[${id}]=`).join('')}${ids.length ? '1;' : ''}${inherited.join('')}` +
      (site.guard ? `${G}.v++;` : '')
    const all = [
      ...plan.own.map((index) => site.firstMutant + index),
      ...plan.feeds.flatMap((feed) => feed.literals.map((literal) => literal.id)),
    ]
    // Where the original throws, a mutant might not, and code that catches
    // the error would then take another path.
    const thrown = `if(${G}.a<0){var I=${G}.i;${all.map((id) => `I[${id}]=`).join('')}${all.length ? '1;' : ''}${inherited.join('')}}throw e`
    const end = site.deferred ? `${G}.s=s` : site.test ? '__vitant_markTruthy(s,o)' : '__vitant_mark(s)'
    const body =
      `${dropsEvaluation ? `${G}.b[${site.id}]--;` : ''}${site.mark ? `${G}.v++;` : ''}` +
      `try{var o=${apply(values)}}catch(e){${thrown}}if(${G}.a<0){var I=${G}.i,s=null,m,k;` +
      `if(${pure}){${computed.join('')}}else{${impure}}${end}}return o`
    // A shadow argument is read right after its input is evaluated, before a
    // later input can run the same code again and overwrite it.
    const params = dropsEvaluation ? ['c'] : []
    const args = dropsEvaluation ? [`${G}.v`] : []
    if (site.call) {
      params.push('f')
      args.push(`(${inside(site, site.call.callee)})`)
    }
    inputs.forEach((range, index) => {
      params.push(values[index])
      args.push(`(${inside(site, range)})`)
      if (!plan.feeds![index].shadows) return
      params.push(`a${index}`)
      args.push(`${G}.s`)
    })
    probes.push(`function ${name}(${params.join(',')}){${body}}`)
    // A constant in place of the site also drops the evaluation of its
    // operands. The count stays up if one of them throws, which the constant
    // would not.
    const call = `${name}(${args.join(',')})`
    return dropsEvaluation ? `(${G}.b[${site.id}]++,${call})` : call
  }

  const active = `${RUNTIME_GLOBAL}.a`
  const hit = (site: Site) => `${RUNTIME_GLOBAL}.h[${site.id}]=1`
  const reached = `${RUNTIME_GLOBAL}.r=1`

  const renderRange = (from: number, to: number, children: Site[]): string => {
    let out = ''
    let cursor = from
    for (const child of children) {
      const rendered = renderSite(child)
      // Code written without semicolons relies on a statement not starting
      // with a parenthesis: wrapped in one, it would be read as a call of the
      // line before.
      const guard = rendered.startsWith('(') && child.start !== from && statementStarts.has(child.start) ? ';' : ''
      out += source.slice(cursor, child.start) + guard + rendered
      cursor = child.end
    }
    return out + source.slice(cursor, to)
  }

  const renderSite = (site: Site): string => {
    if (site.kind === 'loop') {
      return `{if(++${RUNTIME_GLOBAL}.n>${RUNTIME_GLOBAL}.l)${RUNTIME_GLOBAL}.x();${renderRange(site.start, site.end, site.children)}}`
    }
    if (site.kind === 'block') {
      // A function's body stays its body: inside a block of its own,
      // `var x` next to `function x() {}` would no longer be allowed.
      if (site.functionBody) {
        return (
          `${source.slice(site.start, site.bodyStart)}if(${active}===${site.firstMutant}){${reached};return}${hit(site)};` +
          `${renderRange(site.bodyStart, site.end - 1, site.children)}}`
        )
      }
      return (
        `${source.slice(site.start, site.bodyStart)}if(${active}===${site.firstMutant}){${reached}}else{${hit(site)};` +
        `${renderRange(site.bodyStart, site.end - 1, site.children)}}}`
      )
    }
    if (site.kind === 'case') {
      const head = site.children.filter((child) => child.end <= site.bodyStart)
      const body = site.children.filter((child) => child.start >= site.bodyStart)
      return (
        `${renderRange(site.start, site.bodyStart, head)}if(${active}===${site.firstMutant}){${reached}}else{${hit(site)};` +
        `${renderRange(site.bodyStart, site.end, body)}}`
      )
    }
    if (site.mutations.length === 0) return probe(site)
    let original = probe(site)
    // A function without a name of its own is named after the variable,
    // property or field it is the value of, but only when it stands there
    // directly. A computed property of the same name gives it back.
    const key = JSON.stringify(site.name)
    const named = (text: string) => (site.name === undefined ? `(${text})` : `({[${key}]:${text}})[${key}]`)
    let out = `(${hit(site)},${site.name === undefined ? original : named(original)})`
    for (let i = site.mutations.length - 1; i >= 0; i--) {
      const mutation = site.mutations[i]
      const mutated =
        source.slice(site.start, mutation.start) +
        mutation.replacement +
        source.slice(mutation.end, site.end)
      out = `${active}===${site.firstMutant + i}?(${reached},${named(mutated)}):${out}`
    }
    return `(${out})`
  }

  const body = renderRange(0, source.length, roots)
  const code = probes.length ? `${body}\n${probes.join('\n')}\n${probeHelpers}\n` : body
  // A construct the placement gets wrong must not take the run down with
  // it, or pass for code no test reaches: the file is left out and named.
  // The check includes what a parser alone lets through, a name declared
  // twice for one, and counts against the source, which may hold some itself.
  const errorsIn = (text: string) => parseSync(filename, text, { showSemanticErrors: true }).errors.length
  if (errorsIn(code) > errorsIn(source)) return undefined
  return {
    code,
    mutants,
    siteCount,
    unplaced,
  }
}
