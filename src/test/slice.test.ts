import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chainAt, dropContained, identifierRefs, isLibraryPath, Kind, pickDependency, pickRoot, qualifiedName, Sym } from '../slice';

const sym = (name: string, kind: Kind, l1: number, l2: number): Sym => ({
  name, kind,
  range: { start: { line: l1, character: 0 }, end: { line: l2, character: 99 } },
  selectionRange: { start: { line: l1, character: 0 }, end: { line: l1, character: name.length } },
});
const at = (line: number) => ({ line, character: 4 });

test('identifierRefs: looks up the call site too, so `add = add(a, b)` finds the function', () => {
  const refs = identifierRefs('def calculate(a, b):\n    add = add(a, b)\n    sub = sub(a, b)\n    return add * sub', { line: 10, character: 0 });
  const adds = refs.filter((r) => r.name === 'add');
  assert.deepEqual(adds.map((r) => [r.line, r.character]), [[11, 4], [11, 10]]);
  assert.ok(!refs.some((r) => r.name === 'def' || r.name === 'return'), 'keywords are skipped');
  assert.equal(refs.filter((r) => r.name === 'a').length, 1, 'non-call names are looked up once');
});

test('identifierRefs: ignores line comments and offsets the first line by the start column', () => {
  const refs = identifierRefs('foo(x) // uses bar\n# baz\nqux', { line: 3, character: 8 });
  assert.deepEqual(refs.map((r) => [r.name, r.line, r.character]), [['foo', 3, 8], ['x', 3, 12], ['qux', 5, 0]]);
});

test('chainAt orders symbols outermost first, even from a flat list', () => {
  const cls = sym('Cart', Kind.Class, 0, 20);
  const method = sym('total', Kind.Method, 5, 10);
  assert.deepEqual(chainAt([method, cls, sym('other', Kind.Function, 30, 40)], at(6)).map((s) => s.name), ['Cart', 'total']);
});

test('pickDependency: a function or method is copied on its own', () => {
  const fn = sym('add', Kind.Function, 0, 2);
  assert.equal(pickDependency([fn])?.name, 'add');
  const cls = sym('Cart', Kind.Class, 0, 20);
  const method = sym('total', Kind.Method, 5, 10);
  assert.equal(pickDependency([cls, method])?.name, 'total');
});

test('pickDependency: anything inside an interface/enum takes the whole shape', () => {
  const iface = sym('PriceRule', Kind.Interface, 0, 3);
  assert.equal(pickDependency([iface, sym('apply', Kind.Method, 1, 1)])?.name, 'PriceRule');
  assert.equal(pickDependency([iface, sym('amount', Kind.Property, 2, 2)])?.name, 'PriceRule');
  const en = sym('Waqt', Kind.Enum, 0, 6);
  assert.equal(pickDependency([en, sym('Asr', Kind.EnumMember, 3, 3)])?.name, 'Waqt');
});

test('pickDependency: properties of a top-level object take the object; fields take their class or function', () => {
  const obj = sym('KARACHI', Kind.Variable, 0, 4);
  assert.equal(pickDependency([obj, sym('asrShadowFactor', Kind.Property, 3, 3)])?.name, 'KARACHI');
  const cls = sym('Order', Kind.Class, 0, 10);
  assert.equal(pickDependency([cls, sym('total', Kind.Field, 2, 2)])?.name, 'Order');
  const init = sym('__init__', Kind.Method, 1, 5);
  assert.equal(pickDependency([cls, init, sym('rate', Kind.Variable, 3, 3)])?.name, '__init__');
});

test('pickDependency: a type literal inside a function is not treated as a shape', () => {
  const fn = sym('build', Kind.Function, 0, 10);
  assert.equal(pickDependency([fn, sym('T', Kind.TypeParameter, 0, 0)])?.name, 'build');
});

test('pickRoot: innermost function, method, class or interface at the cursor', () => {
  const cls = sym('Cart', Kind.Class, 0, 20);
  const method = sym('total', Kind.Method, 5, 10);
  const local = sym('x', Kind.Variable, 6, 6);
  assert.equal(pickRoot([cls, method, local])?.name, 'total');
  assert.equal(pickRoot([cls])?.name, 'Cart');
  assert.equal(pickRoot([sym('Money', Kind.Interface, 0, 3)])?.name, 'Money');
  assert.equal(pickRoot([sym('CONFIG', Kind.Variable, 0, 3)]), undefined);
});

test('dropContained removes a method when its whole class is also included', () => {
  const s = (name: string, l1: number, l2: number, file = 'a.ts') => ({
    file, name, depth: 1, range: { start: { line: l1, character: 0 }, end: { line: l2, character: 0 } },
  });
  assert.deepEqual(dropContained([s('total', 5, 8), s('Cart', 0, 20), s('total', 5, 8, 'b.ts')]).map((x) => `${x.file}:${x.name}`), [
    'a.ts:Cart', 'b.ts:total',
  ]);
});

test('isLibraryPath excludes installed packages and TypeScript lib files', () => {
  assert.ok(isLibraryPath('C:\\proj\\node_modules\\express\\index.d.ts'));
  assert.ok(isLibraryPath('/proj/.venv/lib/python3.12/site-packages/requests/api.py'));
  assert.ok(isLibraryPath('/vscode/extensions/typescript/lib.es2015.core.d.ts'));
  assert.ok(!isLibraryPath('/proj/src/lib/format.ts'));
});

test('qualifiedName prefixes methods with their class or interface', () => {
  const cls = sym('ZakatRule', Kind.Class, 0, 10);
  const method = sym('apply', Kind.Method, 2, 4);
  assert.equal(qualifiedName([cls, method], method), 'ZakatRule.apply');
  const fn = sym('round', Kind.Function, 12, 14);
  assert.equal(qualifiedName([fn], fn), 'round');
});
