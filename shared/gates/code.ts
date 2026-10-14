// Rules read from a script's syntax tree: type assertions, shell commands,
// warning comments, suppressed checks and skipped tests. Each is judged only on
// the lines a change adds, so old code does not block an unrelated change.

import ts from 'typescript'
import type { Finding } from '../framework.ts'
import { isScript, lineOf as gitLine, parseScript, scriptComments } from './source.ts'

export type CodeFindings = { assertions: Finding[]; shell: Finding[]; warnings: Finding[]; suppressions: Finding[] }

const CHILD_PROCESS = new Set(['child_process', 'node:child_process'])
const SHELL_CALLS = new Set(['exec', 'execSync'])
const WARNING = /\b(?:TODO|FIXME|XXX|HACK)\b/
const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck/
// A block comment that configures eslint inline, such as turning a rule off for
// the file, declaring globals or an environment.
const INLINE_CONFIG = /\/\*\s*(?:eslint|eslint-env|globals?)\s/
const TEST_FUNCTIONS = new Set(['test', 'it', 'describe', 'suite'])
const SKIPPING = new Set(['skip', 'only', 'todo'])
// Calls that assert something in a check or a test.
const ASSERTING = new Set(['check', 'assert', 'expect'])

export function codeFindings(path: string, text: string, added: ReadonlySet<number>): CodeFindings {
  const out: CodeFindings = { assertions: [], shell: [], warnings: [], suppressions: [] }
  if (!isScript(path)) return out
  const file = parseScript(path, text)
  const lineOf = (node: ts.Node) => gitLine(file, node.getStart(file))
  const at = (list: Finding[], node: ts.Node, what: string) => {
    const line = lineOf(node)
    if (added.has(line)) list.push({ path, line, text: what })
  }

  // Local names bound to child_process's exec, and to the module itself.
  const shellNames = new Set<string>()
  const modules = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!CHILD_PROCESS.has(statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (statement.importClause?.name) modules.add(statement.importClause.name.text)
    if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (SHELL_CALLS.has((element.propertyName ?? element.name).text)) {
          shellNames.add(element.name.text)
          at(out.shell, element, `imports ${element.name.text} from child_process, which runs a shell string`)
        }
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isAsExpression(node) && !(ts.isTypeReferenceNode(node.type) && node.type.getText(file) === 'const')) {
      at(out.assertions, node, `a type assertion to ${node.type.getText(file)}`)
    }
    if (ts.isTypeAssertionExpression(node)) at(out.assertions, node, `a type assertion to ${node.type.getText(file)}`)
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      if (modules.has(node.expression.text) && SHELL_CALLS.has(node.name.text)) at(out.shell, node, `${node.getText(file)}, which runs a shell string`)
      if (TEST_FUNCTIONS.has(node.expression.text) && SKIPPING.has(node.name.text)) at(out.suppressions, node, `${node.getText(file)}, a skipped or only test`)
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text
      if (name === 'shell' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) at(out.shell, node, 'shell: true')
      if (SKIPPING.has(name) && node.initializer.kind === ts.SyntaxKind.TrueKeyword) at(out.suppressions, node, `${name}: true, a skipped or only test`)
    }
    for (const child of node.getChildren(file)) visit(child)
  }
  visit(file)

  for (const comment of scriptComments(file)) {
    if (!added.has(comment.line)) continue
    if (WARNING.test(comment.text)) out.warnings.push({ path, line: comment.line, text: 'a TODO, FIXME, XXX or HACK comment' })
    const suppression = SUPPRESSION.exec(comment.text)?.[0]
    if (suppression) out.suppressions.push({ path, line: comment.line, text: `a new ${suppression}` })
    else if (INLINE_CONFIG.test(comment.text)) out.suppressions.push({ path, line: comment.line, text: 'a new inline eslint config' })
  }
  return out
}

// How many assertions a check or test makes: calls to check, assert or expect,
// and to their methods.
export function assertionCount(path: string, text: string): number {
  if (!isScript(path)) return 0
  const file = parseScript(path, text)
  let count = 0
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : null
      if (name !== null && ASSERTING.has(name)) count++
    }
    for (const child of node.getChildren(file)) visit(child)
  }
  visit(file)
  return count
}
