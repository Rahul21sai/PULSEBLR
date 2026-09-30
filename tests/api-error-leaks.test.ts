/**
 * No API route may put an error's text, or the error itself, into a response body.
 *
 * `{ error, details: err.message }` reached ~10 routes before it was removed one route at a time,
 * and a per-route fix does not stop the eleventh. On a Mongoose error that text names the model, the
 * schema path and the caller's own value, and on a driver E11000 it names the database and
 * collection. The rule every route now follows lives in lib/http/errors.ts; this is what holds the
 * tree to it.
 *
 * ── WHAT IS SCANNED ──────────────────────────────────────────────────────────────────────────
 * Every file under app/api, plus every lib module a route RE-EXPORTS its handler from (found by
 * reading the routes, so a new thin route is covered with no edit here), plus lib/http/*. Excluded:
 * lib/http/errors.ts itself, the one module whose job is to read an error and decide what a caller
 * may see. Its outputs are pinned behaviourally by tests/http-errors.test.ts instead.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────────────────────────
 * Through the TypeScript AST, not a regex, so a comment, a string literal, a property KEY named
 * `error` or a type annotation cannot trip it. A "sink" is `NextResponse.json`, `Response.json`,
 * `new NextResponse`/`new Response`, or a file-local function that passes one of its own parameters
 * into one (`json()`, `reply()`, `page()`, `jsonRpc()`). Inside a sink's arguments:
 *
 *   A. no `.message`, `.stack`, `.errmsg`, `.errorResponse` or `.keyValue` read, and no `details` key;
 *   B. a caught error, or an alias of one, is never a VALUE: not shorthand `{ error }`, not
 *      `String(err)`, not a template span. A member read such as `err.code` is judged by rule A; a
 *      test such as `err.code === 11000` is not a value; and handing the error to one of the audited
 *      helpers in lib/http/errors.ts is exactly what a route should do;
 *   C. no variable laundered from A or B (`const msg = err.message`) reaches a body.
 *
 * The tree scan asserts it SAW sinks and catch clauses in quantity, because a scanner that has
 * stopped recognising the shape finds nothing and passes — the same guard
 * tests/pipeline-updates.test.ts keeps.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface Leak {
  line: number;
  rule: 'A' | 'B' | 'C';
  text: string;
}

export interface ScanResult {
  leaks: Leak[];
  /** Response constructions seen, so an empty result can be told from a blind scanner. */
  sinks: number;
  /** Caught-error bindings seen, for the same reason. */
  catches: number;
}

const SINK_CLASSES = new Set(['NextResponse', 'Response']);
const LEAKY_PROPS = new Set(['message', 'stack', 'errmsg', 'errorResponse', 'keyValue']);
/** lib/http/errors.ts helpers that take an error and return only what a caller may see. */
const SANITISERS = new Set([
  'routeFailure',
  'rejectedFields',
  'duplicateKeyFields',
  'callerFacingMessage',
  'isSchemaRejection',
]);

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function within(node: ts.Node, scope: ts.Node): boolean {
  return node.pos >= scope.pos && node.end <= scope.end;
}

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

function propertyName(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : '';
}

/** `(x as T)`, `x!`, `(x)` → `x`. */
function unwrap(expr: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

function insideType(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpressionStatement(current) || ts.isBlock(current)) return false;
  }
  return false;
}

/** `NextResponse.json(…)`, `Response.json(…)`, `new NextResponse(…)`, `new Response(…)`. */
function isDirectSink(node: ts.Node): node is ts.CallExpression | ts.NewExpression {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const target = node.expression.expression;
    return node.expression.name.text === 'json' && ts.isIdentifier(target) && SINK_CLASSES.has(target.text);
  }
  return ts.isNewExpression(node) && ts.isIdentifier(node.expression) && SINK_CLASSES.has(node.expression.text);
}

function sinkArguments(node: ts.CallExpression | ts.NewExpression): readonly ts.Expression[] {
  return node.arguments ?? [];
}

/** Names bound by a parameter list, destructuring included. */
function parameterNames(fn: ts.SignatureDeclaration): Set<string> {
  const names = new Set<string>();
  const collect = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) collect(element.name);
  };
  for (const parameter of fn.parameters) collect(parameter.name);
  return names;
}

function functionOf(node: ts.Node): { name: string; fn: ts.FunctionLikeDeclaration } | null {
  if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name.text, fn: node };
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return { name: node.parent.name.text, fn: node };
  }
  return null;
}

/**
 * Is this occurrence of a name a VALUE flowing onward, rather than a test on it or a member read?
 * Rule B's whole precision lives here.
 */
function isValueUse(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (
    ts.isAsExpression(parent) ||
    ts.isParenthesizedExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    ts.isSatisfiesExpression(parent)
  ) {
    return isValueUse(parent);
  }
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  // A name being DECLARED (a callback's parameter, a destructured binding) is not a use of anything.
  if ((ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isVariableDeclaration(parent)) && parent.name === node) {
    return false;
  }
  if (ts.isBinaryExpression(parent)) {
    const kind = parent.operatorToken.kind;
    if (
      kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      kind === ts.SyntaxKind.EqualsEqualsToken ||
      kind === ts.SyntaxKind.ExclamationEqualsToken ||
      kind === ts.SyntaxKind.InstanceOfKeyword ||
      kind === ts.SyntaxKind.InKeyword
    ) {
      return false;
    }
  }
  if (ts.isTypeOfExpression(parent)) return false;
  if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) return false;
  if (ts.isConditionalExpression(parent) && parent.condition === node) return false;
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.some(argument => argument === node) &&
    SANITISERS.has(calleeName(parent))
  ) {
    return false;
  }
  return !insideType(node);
}

/**
 * `x.y`, `x[y]`, `(x as T).y`: a read of one of x's members. Exempt for a CAUGHT ERROR, because
 * which members of an error leak is rule A's question (`err.code` does not, `err.message` does).
 * NOT exempt for a laundered variable, because every member of `{ body: { details: err.message } }`
 * is built from the error: `failure.body` carries the text as surely as `failure` does.
 */
function isMemberRead(node: ts.Node): boolean {
  let current: ts.Node = node;
  let parent = current.parent;
  while (
    parent &&
    (ts.isAsExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isSatisfiesExpression(parent))
  ) {
    current = parent;
    parent = current.parent;
  }
  return (
    !!parent &&
    (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
    parent.expression === current
  );
}

/** Rule A: a leaky member read or a `details` key anywhere under `root`. */
function ruleAHits(root: ts.Node): ts.Node[] {
  const hits: ts.Node[] = [];
  walk(root, node => {
    if (ts.isPropertyAccessExpression(node) && LEAKY_PROPS.has(node.name.text)) hits.push(node);
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      LEAKY_PROPS.has(node.argumentExpression.text)
    ) {
      hits.push(node);
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      propertyName(node.name) === 'details'
    ) {
      hits.push(node);
    }
  });
  return hits;
}

interface Tainted {
  name: string;
  scope: ts.Node;
}

export function scanForLeaks(fileName: string, source: string): ScanResult {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;

  // ── wrappers: file-local functions that pass a parameter into a sink ──────────────────────
  const wrappers = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    walk(file, node => {
      const found = functionOf(node);
      if (!found || wrappers.has(found.name) || !found.fn.body) return;
      const params = parameterNames(found.fn);
      if (params.size === 0) return;
      let passes = false;
      walk(found.fn.body, inner => {
        if (passes) return;
        const isSink =
          isDirectSink(inner) || (ts.isCallExpression(inner) && wrappers.has(calleeName(inner)));
        if (!isSink) return;
        for (const argument of sinkArguments(inner as ts.CallExpression | ts.NewExpression)) {
          walk(argument, leaf => {
            if (ts.isIdentifier(leaf) && params.has(leaf.text) && isValueUse(leaf)) passes = true;
          });
        }
      });
      if (passes) {
        wrappers.add(found.name);
        changed = true;
      }
    });
  }

  const sinks: Array<ts.CallExpression | ts.NewExpression> = [];
  walk(file, node => {
    if (isDirectSink(node)) sinks.push(node);
    else if (ts.isCallExpression(node) && wrappers.has(calleeName(node))) sinks.push(node);
  });

  // ── caught errors: `catch (e)` and `.catch(e => …)`, with their aliases ────────────────────
  const caught: Tainted[] = [];
  walk(file, node => {
    if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
      caught.push({ name: node.variableDeclaration.name.text, scope: node.block });
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch'
    ) {
      const handler = node.arguments[0];
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const first = handler.parameters[0];
        if (first && ts.isIdentifier(first.name)) caught.push({ name: first.name.text, scope: handler.body });
      }
    }
  });
  const catches = caught.length;

  const references = (node: ts.Node, set: Tainted[]) =>
    ts.isIdentifier(node) && set.some(t => t.name === node.text && within(node, t.scope));

  // A rule-A read, or a flow out of `set`, anywhere under `expr`. `members` says whether reading a
  // member of something in `set` counts as a flow (see `isMemberRead`).
  const carriesErrorText = (expr: ts.Node, set: Tainted[], members: boolean) => {
    if (ruleAHits(expr).length > 0) return true;
    let found = false;
    walk(expr, leaf => {
      if (!found && references(leaf, set) && (isValueUse(leaf) || (members && isMemberRead(leaf)))) {
        found = true;
      }
    });
    return found;
  };

  // An ALIAS of a caught error (`const err = error as T`) is the error object itself, so it joins
  // rule B's set. Anything else computed from one, or from a rule-A read, is laundered text (rule C).
  const errors = [...caught];
  const laundered: Tainted[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    walk(file, node => {
      let name: string | null = null;
      let value: ts.Expression | undefined;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        name = node.name.text;
        value = node.initializer;
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        name = node.left.text;
        value = node.right;
      }
      if (!name || !value) return;
      const scope = node.parent?.parent?.parent ?? file;
      const known = (set: Tainted[]) => set.some(t => t.name === name && t.scope === scope);
      if (known(errors) || known(laundered)) return;
      if (references(unwrap(value), errors)) {
        errors.push({ name, scope });
        changed = true;
      } else if (carriesErrorText(value, errors, false) || carriesErrorText(value, laundered, true)) {
        laundered.push({ name, scope });
        changed = true;
      }
    });
  }

  // ── judge every sink ──────────────────────────────────────────────────────────────────────
  const leaks: Leak[] = [];
  const report = (node: ts.Node, rule: Leak['rule']) =>
    leaks.push({ line: lineOf(node), rule, text: node.getText(file).replace(/\s+/g, ' ').slice(0, 120) });

  for (const sink of sinks) {
    for (const argument of sinkArguments(sink)) {
      for (const hit of ruleAHits(argument)) report(hit, 'A');
      walk(argument, leaf => {
        if (!ts.isIdentifier(leaf)) return;
        if (references(leaf, errors) && isValueUse(leaf)) report(leaf, 'B');
        else if (references(leaf, laundered) && (isValueUse(leaf) || isMemberRead(leaf))) report(leaf, 'C');
      });
    }
  }

  return { leaks, sinks: sinks.length, catches };
}

// ── the tree ───────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const EXCLUDED = new Set(['lib/http/errors.ts']);
/** The three handler factories CLAUDE.md §18 moved out of route files. The scan must reach them. */
const KNOWN_DELEGATES = [
  'lib/http/delete-account-handler.ts',
  'lib/contacts/intake-handler.ts',
  'lib/notifications/push-test-handler.ts',
];

function tsFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(name => {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) return tsFiles(path);
    return /\.ts$/.test(name) ? [path] : [];
  });
}

/** The lib modules routes re-export a handler from: `export { POST } from '@/lib/…'`. */
function delegatedModules(routeFiles: string[]): string[] {
  const out = new Set<string>();
  for (const route of routeFiles) {
    const file = ts.createSourceFile(route, readFileSync(join(ROOT, route), 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = statement.moduleSpecifier.text;
      if (!target.startsWith('@/lib/')) continue;
      const path = `${target.slice(2)}.ts`;
      if (existsSync(join(ROOT, path))) out.add(path);
    }
  }
  return [...out];
}

function scannedFiles(): string[] {
  const routes = tsFiles('app/api');
  const all = new Set([...routes, ...delegatedModules(routes), ...tsFiles('lib/http')]);
  return [...all].filter(path => !EXCLUDED.has(path)).sort();
}

// ── tests ──────────────────────────────────────────────────────────────────────────────────

const leaksIn = (source: string) => scanForLeaks('probe.ts', source).leaks.map(l => l.rule);

describe('the leak scanner recognises the shapes it guards', () => {
  it('rule A: an error message or a `details` key in a body', () => {
    expect(leaksIn(`try {} catch (err) { return NextResponse.json({ error: err.message }, { status: 500 }); }`)).toEqual(['A']);
    expect(leaksIn(`try {} catch (e) { return NextResponse.json({ error: 'x', details: 'y' }); }`)).toEqual(['A']);
    expect(leaksIn(`const r = Response.json({ stack: (e as Error).stack });`)).toEqual(['A']);
    expect(leaksIn(`const r = new NextResponse(JSON.stringify({ reason: x['message'] }));`)).toEqual(['A']);
  });

  it('rule A: through a file-local wrapper, however it is named', () => {
    const source = `
      function reply(body: unknown, status: number) { return NextResponse.json(body, { status }); }
      function fail(err: Error) { return reply({ error: err.message }, 500); }`;
    expect(leaksIn(source)).toEqual(['A']);
  });

  it('rule B: the caught error itself, or its text, as a value in a body', () => {
    expect(leaksIn(`try {} catch (error) { return NextResponse.json({ error }, { status: 500 }); }`)).toEqual(['B']);
    expect(leaksIn(`try {} catch (e) { return new Response(String(e), { status: 500 }); }`)).toEqual(['B']);
    expect(leaksIn('try {} catch (e) { return NextResponse.json({ error: `failed: ${e}` }); }')).toEqual(['B']);
    expect(leaksIn(`try {} catch (error) { const err = error as { code?: number }; return NextResponse.json({ err }); }`)).toEqual(['B']);
    expect(leaksIn(`p.catch(err => NextResponse.json({ error: err }))`)).toEqual(['B']);
  });

  it('rule C: error text laundered through a variable', () => {
    expect(leaksIn(`try {} catch (err) { const msg = err.message; return NextResponse.json({ error: msg }); }`)).toEqual(['C']);
    expect(leaksIn(`try {} catch (e) { const body = { error: String(e) }; return NextResponse.json(body); }`)).toEqual(['C']);
    // The shape a route actually writes: build a failure object, then send ONE MEMBER of it.
    const viaMember = `try {} catch (error) {
      const failure = { status: 500, body: { error: 'x', details: (error as Error).message } };
      return NextResponse.json(failure.body, { status: failure.status });
    }`;
    expect(leaksIn(viaMember)).toEqual(['C', 'C']);
  });

  it('leaves alone what is not a leak', () => {
    const clean = `
      // details: err.message was the old shape, and a comment saying so is not a leak.
      export async function POST() {
        try {
          const text = 'details: err.message';
          return NextResponse.json({ ok: true, text, messageSent: patch.messageSent, issues: [{ field, message }] });
        } catch (error) {
          console.error('Error creating thing:', errorLogLine(error), (error as Error).message);
          if ((error as { code?: number }).code === 11000) return NextResponse.json({ error: 'Already exists' }, { status: 409 });
          if (error instanceof TypeError) return NextResponse.json({ error: 'Bad' }, { status: 400 });
          const keys = duplicateKeyFields(error);
          const failure = routeFailure(error, 'Failed to create thing');
          return NextResponse.json({ ...failure.body, clash: keys?.includes('slug') }, { status: failure.status });
        }
      }`;
    expect(leaksIn(clean)).toEqual([]);
  });

  it('counts what it saw, so a blind scanner cannot pass', () => {
    const result = scanForLeaks('probe.ts', `try {} catch (e) { return NextResponse.json({ a: 1 }); } x.catch(r => 0);`);
    expect(result.sinks).toBe(1);
    expect(result.catches).toBe(2);
  });
});

describe('no API route puts error text into a response body', () => {
  const files = scannedFiles();

  it('scans every route and the handlers routes delegate to', () => {
    expect(files).toEqual(expect.arrayContaining(KNOWN_DELEGATES));
    expect(files.filter(path => path.startsWith('app/api/')).length).toBeGreaterThanOrEqual(60);
    expect(files).not.toContain('lib/http/errors.ts');
  });

  it('finds no leak in any of them', () => {
    const leaks: string[] = [];
    let sinks = 0;
    let catches = 0;
    for (const path of files) {
      const result = scanForLeaks(path, readFileSync(join(ROOT, path), 'utf8'));
      sinks += result.sinks;
      catches += result.catches;
      for (const leak of result.leaks) leaks.push(`${path}:${leak.line} [rule ${leak.rule}] ${leak.text}`);
    }
    // Floors well under what the tree holds (measured 2026-09-30: 66 files, 430 sinks, 111 caught
    // errors), so they fail on a blind scanner and not on an ordinary refactor.
    expect(sinks).toBeGreaterThan(300);
    expect(catches).toBeGreaterThan(80);
    expect(leaks).toEqual([]);
  });
});
