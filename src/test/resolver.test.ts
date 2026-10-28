import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collect, jsSpecifiers, parseJsonc, pyImports } from '../resolver';
import { format } from '../format';

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-ctx-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

const rels = (root: string, files: { path: string }[]) =>
  files.map((f) => path.relative(root, f.path).split(path.sep).join('/'));

test('jsSpecifiers finds static, side-effect, dynamic and require imports', () => {
  const src = `
    import React from 'react';
    import {
      a,
      b,
    } from './multi';
    export * from "./reexport";
    import './side-effect.css';
    const lazy = import('./lazy');
    const old = require('../old');
    // import './commented-out';
    /* import './block-commented'; */
  `;
  assert.deepEqual(new Set(jsSpecifiers(src)), new Set(['react', './multi', './reexport', './side-effect.css', './lazy', '../old']));
});

test('JS/TS: follows relative imports, index files and .js -> .ts, skips packages and node_modules', () => {
  const root = fixture({
    'src/main.ts': `import { x } from './util.js';\nimport cfg from './config';\nimport 'react';\nimport y from '../node_modules/pkg/index';`,
    'src/util.ts': `export * from './helpers';`,
    'src/helpers/index.ts': `import { deep } from './deep';`,
    'src/helpers/deep.ts': `export const deep = 1;`,
    'src/config.json': `{}`,
    'node_modules/pkg/index.ts': `export default 1;`,
  });
  const out = collect([path.join(root, 'src/main.ts')], { root, maxDepth: 10, maxFiles: 50 });
  assert.deepEqual(rels(root, out), ['src/main.ts', 'src/util.ts', 'src/helpers/index.ts', 'src/helpers/deep.ts']);
});

test('maxDepth and maxFiles limit the walk', () => {
  const root = fixture({
    'a.ts': `import './b';`,
    'b.ts': `import './c';`,
    'c.ts': `export {};`,
  });
  const entry = [path.join(root, 'a.ts')];
  assert.deepEqual(rels(root, collect(entry, { root, maxDepth: 0, maxFiles: 50 })), ['a.ts']);
  assert.deepEqual(rels(root, collect(entry, { root, maxDepth: 1, maxFiles: 50 })), ['a.ts', 'b.ts']);
  assert.deepEqual(rels(root, collect(entry, { root, maxDepth: 5, maxFiles: 2 })), ['a.ts', 'b.ts']);
});

test('import cycles are visited once', () => {
  const root = fixture({ 'a.ts': `import './b';`, 'b.ts': `import './a';` });
  const out = collect([path.join(root, 'a.ts')], { root, maxDepth: 10, maxFiles: 50 });
  assert.deepEqual(rels(root, out), ['a.ts', 'b.ts']);
});

test('pyImports parses absolute, relative, aliased and parenthesised imports', () => {
  const imps = pyImports(`
import os, app.models as m
from . import utils, schemas
from ..core.db import (
    Session,  # comment
    engine,
)
from pkg import *
`);
  assert.deepEqual(imps, [
    { level: 1, module: '', names: ['utils', 'schemas'] },
    { level: 2, module: 'core.db', names: ['Session', 'engine'] },
    { level: 0, module: 'pkg', names: [] },
    { level: 0, module: 'os', names: [] },
    { level: 0, module: 'app.models', names: [] },
  ]);
});

test('Python: resolves absolute, relative and submodule imports; skips stdlib', () => {
  const root = fixture({
    'app/__init__.py': '',
    'app/main.py': `import os\nimport json\nfrom app.services import billing\nfrom .config import settings`,
    'app/config.py': `SETTINGS = {}`,
    'app/services/__init__.py': '',
    'app/services/billing.py': `from ..core import db`,
    'app/core/__init__.py': '',
    'app/core/db.py': `import sqlalchemy`,
  });
  const out = collect([path.join(root, 'app/main.py')], { root, maxDepth: 10, maxFiles: 50 });
  assert.deepEqual(rels(root, out), [
    'app/main.py',
    'app/services/__init__.py',
    'app/services/billing.py',
    'app/config.py',
    'app/core/__init__.py',
    'app/core/db.py',
  ]);
});

test('Python: src/ layout is searched for absolute imports', () => {
  const root = fixture({
    'tests/test_x.py': `from mylib.core import run`,
    'src/mylib/__init__.py': '',
    'src/mylib/core.py': `def run(): pass`,
  });
  const out = collect([path.join(root, 'tests/test_x.py')], { root, maxDepth: 2, maxFiles: 50 });
  assert.deepEqual(rels(root, out), ['tests/test_x.py', 'src/mylib/core.py']);
});

test('readFile override is used (unsaved editor buffers)', () => {
  const root = fixture({ 'a.ts': `export {};`, 'b.ts': `export const b = 1;` });
  const out = collect([path.join(root, 'a.ts')], {
    root,
    maxDepth: 2,
    maxFiles: 50,
    readFile: (p) => (p.endsWith('a.ts') ? `import './b';` : fs.readFileSync(p, 'utf8')),
  });
  assert.deepEqual(rels(root, out), ['a.ts', 'b.ts']);
});

test('format: markdown uses a fence longer than any backtick run; xml wraps files', () => {
  const root = fixture({});
  const file = { path: path.join(root, 'src', 'doc.ts'), depth: 0, content: 'const s = `x`;\n// ```inner```' };
  const md = format([file], root, 'markdown');
  assert.equal(md, '## src/doc.ts\n\n````ts\nconst s = `x`;\n// ```inner```\n````\n');
  const xml = format([file], root, 'xml');
  assert.equal(xml, '<file path="src/doc.ts">\nconst s = `x`;\n// ```inner```\n</file>\n');
});

test('parseJsonc keeps "/*" inside strings while stripping comments and trailing commas', () => {
  const cfg = parseJsonc(`{
    // line comment
    "compilerOptions": { /* block */ "paths": { "@/*": ["src/*"], }, },
  }`);
  assert.deepEqual(cfg, { compilerOptions: { paths: { '@/*': ['src/*'] } } });
});

test('JS/TS: resolves tsconfig path aliases, including via references and extends', () => {
  const root = fixture({
    // Vite-style: root config only has references; aliases live in tsconfig.app.json, which extends a base.
    'tsconfig.json': `{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }`,
    'tsconfig.app.json': `{ "extends": "./tsconfig.base.json", "compilerOptions": { /* no paths here */ } }`,
    'tsconfig.base.json': `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~utils": ["src/lib/utils.ts"] } } }`,
    'src/app/router.tsx': `import { q } from "@/lib/query";\nimport u from '~utils';\nimport { x } from '@tanstack/react-router';`,
    'src/lib/query/index.ts': `export const q = 1;`,
    'src/lib/utils.ts': `export default 1;`,
  });
  const out = collect([path.join(root, 'src/app/router.tsx')], { root, maxDepth: 2, maxFiles: 50 });
  assert.deepEqual(rels(root, out), ['src/app/router.tsx', 'src/lib/query/index.ts', 'src/lib/utils.ts']);
});

test('JS/TS: jsconfig.json paths without baseUrl are relative to the config', () => {
  const root = fixture({
    'web/jsconfig.json': `{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }`,
    'web/pages/index.js': `import Nav from '@/components/Nav';`,
    'web/components/Nav.jsx': `export default 1;`,
  });
  const out = collect([path.join(root, 'web/pages/index.js')], { root, maxDepth: 2, maxFiles: 50 });
  assert.deepEqual(rels(root, out), ['web/pages/index.js', 'web/components/Nav.jsx']);
});
