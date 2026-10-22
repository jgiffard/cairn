import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { TASK_PATCH_COLUMNS } from './task-patch'

/**
 * A new PATCH field must also work alongside labelPatch. A typed route patch
 * catches direct field additions, and these guards pin the SQL allowlist to
 * that same contract instead of silently breaking combined updates later.
 */
describe('atomic label patch column contract', () => {
  it('keeps the SQL allowlist equal to the exported PATCH columns', () => {
    const sql = readFileSync('migrations/086_patch_task_labels.sql', 'utf8')
    const allowlist = /jsonb_object_keys\(p_patch\)\s+k\s+where\s+k\s+<>\s+all\(array\[([\s\S]*?)\]\)/.exec(sql)?.[1]
    expect(allowlist, 'the SQL allowlist must remain explicit for this drift guard').toBeDefined()
    const columns = [...(allowlist ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
    expect(columns.sort()).toEqual([...TASK_PATCH_COLUMNS].sort())
  })

  it('covers every key the PATCH handler assigns including replacement and derived labels', () => {
    const source = ts.createSourceFile('route.ts', readFileSync('src/app/api/v1/tasks/[ref]/route.ts', 'utf8'), ts.ScriptTarget.Latest, true)
    const columns = new Set<string>()
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = node.left
        if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) &&
            ts.isIdentifier(left.expression) && left.expression.text === 'patch') {
          if (ts.isPropertyAccessExpression(left)) columns.add(left.name.text)
          else {
            expect(ts.isStringLiteral(left.argumentExpression), 'update this guard to resolve any dynamic patch keys').toBe(true)
            if (ts.isStringLiteral(left.argumentExpression)) columns.add(left.argumentExpression.text)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
    expect([...columns].sort()).toEqual([...TASK_PATCH_COLUMNS].sort())
  })
})
