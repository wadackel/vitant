// oxc-parser returns a plain ESTree object graph; the node shapes are too
// numerous to type here and the mutators only read a handful of fields.
// oxlint-disable-next-line typescript/no-explicit-any
export type Node = any

export interface Visit {
  node: Node
  parent: Node | undefined
  key: string | undefined
  ancestors: readonly Node[]
}

/** TS wrappers that carry a runtime expression inside a type construct. */
const transparent: Record<string, string[]> = {
  TSAsExpression: ['expression'],
  TSSatisfiesExpression: ['expression'],
  TSNonNullExpression: ['expression'],
  TSTypeAssertion: ['expression'],
  TSInstantiationExpression: ['expression'],
  TSParameterProperty: ['parameter'],
  TSExportAssignment: ['expression'],
  TSModuleDeclaration: ['body'],
  TSModuleBlock: ['body'],
  TSAbstractMethodDefinition: ['value'],
  TSAbstractPropertyDefinition: ['value'],
}

const typeOnlyKeys = new Set([
  'typeAnnotation',
  'typeParameters',
  'typeArguments',
  'returnType',
  'superTypeArguments',
  'implements',
  'decorators',
])

const skipped = new Set([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'TSEnumDeclaration',
  'TSImportEqualsDeclaration',
])

function childKeys(node: Node): string[] {
  if (skipped.has(node.type) || node.declare === true) return []
  if (node.type.startsWith('TS')) return transparent[node.type] ?? []
  if (node.type === 'ExportNamedDeclaration') return ['declaration']
  if (node.type === 'ExpressionStatement' && node.directive != null) return []
  return Object.keys(node).filter((key) => !typeOnlyKeys.has(key))
}

export function walk(
  root: Node,
  enter: (visit: Visit) => void,
  leave?: (visit: Visit) => void,
): void {
  const ancestors: Node[] = []
  const visit = (node: Node, parent: Node | undefined, key: string | undefined) => {
    const current = { node, parent, key, ancestors }
    enter(current)
    ancestors.push(node)
    for (const childKey of childKeys(node)) {
      const child = node[childKey]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === 'string') visit(item, node, childKey)
        }
      } else if (child && typeof child.type === 'string') {
        visit(child, node, childKey)
      }
    }
    ancestors.pop()
    leave?.(current)
  }
  visit(root, undefined, undefined)
}
