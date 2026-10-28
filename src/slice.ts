// Pure helpers for "copy a block with its dependencies". No vscode import, so they're unit-testable.

/** Mirrors vscode.SymbolKind (0-based). */
export const enum Kind {
  File = 0, Module = 1, Namespace = 2, Package = 3, Class = 4, Method = 5, Property = 6, Field = 7,
  Constructor = 8, Enum = 9, Interface = 10, Function = 11, Variable = 12, Constant = 13, String = 14,
  Number = 15, Boolean = 16, Array = 17, Object = 18, Key = 19, Null = 20, EnumMember = 21, Struct = 22,
  Event = 23, Operator = 24, TypeParameter = 25,
}

export interface Pos {
  line: number;
  character: number;
}

export interface Rng {
  start: Pos;
  end: Pos;
}

export interface Sym {
  name: string;
  kind: Kind;
  range: Rng;
  selectionRange: Rng;
}

/** Data shapes: when anything inside one is referenced, the whole shape is copied. */
const SHAPES = new Set([Kind.Interface, Kind.Enum, Kind.Struct, Kind.TypeParameter]);
const CALLABLES = new Set([Kind.Function, Kind.Method, Kind.Constructor]);
const DATA = new Set([Kind.Variable, Kind.Constant, Kind.Object]);

const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.character <= b.character);

export function containsPos(r: Rng, p: Pos): boolean {
  return before(r.start, p) && before(p, r.end);
}

export function containsRange(outer: Rng, inner: Rng): boolean {
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

/** Symbols containing `p`, outermost first. Works for flat lists too (nesting is derived from ranges). */
export function chainAt(symbols: Sym[], p: Pos): Sym[] {
  return symbols
    .filter((s) => containsPos(s.range, p))
    .sort((a, b) => (containsRange(a.range, b.range) ? -1 : containsRange(b.range, a.range) ? 1 : 0));
}

/**
 * Picks what to copy for a definition at the end of `chain` (outermost first):
 * - anything inside an interface/enum/struct/type -> the whole shape
 * - a function or method -> just it (innermost callable)
 * - a variable/field/property -> its enclosing function, else its class, else the top-level declaration
 */
export function pickDependency(chain: Sym[]): Sym | undefined {
  if (chain.length === 0) {
    return undefined;
  }
  const firstCallable = chain.findIndex((s) => CALLABLES.has(s.kind));
  const shape = chain.find((s, i) => SHAPES.has(s.kind) && (firstCallable === -1 || i < firstCallable));
  if (shape) {
    return shape;
  }
  const inner = chain[chain.length - 1];
  if (CALLABLES.has(inner.kind) || inner.kind === Kind.Class) {
    return inner;
  }
  for (let i = chain.length - 2; i >= 0; i--) {
    if (CALLABLES.has(chain[i].kind)) {
      return chain[i];
    }
  }
  const cls = [...chain].reverse().find((s) => s.kind === Kind.Class);
  if (cls) {
    return cls;
  }
  return chain.find((s) => DATA.has(s.kind)) ?? inner;
}

const CONTAINERS = new Set([Kind.Class, Kind.Interface, Kind.Struct, Kind.Enum, Kind.Namespace, Kind.Module]);

/** "ZakatRule.apply" for a method, plain "apply" for a top-level function. */
export function qualifiedName(chain: Sym[], dep: Sym): string {
  const i = chain.indexOf(dep);
  const parents = (i === -1 ? [] : chain.slice(0, i)).filter((s) => CONTAINERS.has(s.kind)).map((s) => s.name);
  return [...parents, dep.name].join('.');
}

/** The block a right-click without a selection refers to: the innermost function/method/class/shape at the cursor. */
export function pickRoot(chain: Sym[]): Sym | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    const k = chain[i].kind;
    if (CALLABLES.has(k) || SHAPES.has(k) || k === Kind.Class) {
      return chain[i];
    }
  }
  return undefined;
}

const KEYWORDS = new Set(
  (
    // JS/TS
    'abstract any as async await boolean break case catch class const constructor continue debugger declare default ' +
    'delete do else enum export extends false finally for from function get if implements import in infer instanceof ' +
    'interface keyof let module namespace never new null number object of package private protected public readonly ' +
    'return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown ' +
    'var void while with yield ' +
    // Python
    'and assert def del elif except False global is lambda None nonlocal not or pass raise True self cls print len ' +
    'range str int float bool list dict tuple ' +
    // Go / misc
    'func struct map chan go defer select fallthrough goto'
  ).split(' '),
);

export interface IdentRef extends Pos {
  name: string;
}

/**
 * Identifier positions worth asking "where is this defined?" for.
 * Each name is looked up at its first occurrence, and again at its first call site (`name(`),
 * so `add = add(a, b)` still finds the function `add` even though the first `add` is a local.
 */
export function identifierRefs(text: string, start: Pos): IdentRef[] {
  const refs: IdentRef[] = [];
  const firstSeen = new Set<string>();
  const callSeen = new Set<string>();
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const line = raw.replace(/(^|\s)(#|\/\/).*$/, '$1'); // drop line comments
    for (const m of line.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const name = m[0];
      if (KEYWORDS.has(name) || /^\d/.test(name)) {
        continue;
      }
      const isCall = /^\s*\(/.test(line.slice(m.index! + name.length));
      const pos = { line: start.line + i, character: (i === 0 ? start.character : 0) + m.index! };
      if (!firstSeen.has(name)) {
        firstSeen.add(name);
        if (isCall) {
          callSeen.add(name);
        }
        refs.push({ name, ...pos });
      } else if (isCall && !callSeen.has(name)) {
        callSeen.add(name);
        refs.push({ name, ...pos });
      }
    }
  });
  return refs;
}

export interface Snippet {
  file: string;
  range: Rng;
  name: string;
  depth: number;
}

/** Drops snippets fully contained in another snippet from the same file (e.g. a method when its class is included). */
export function dropContained<T extends Snippet>(snippets: T[]): T[] {
  return snippets.filter(
    (s, i) =>
      !snippets.some(
        (o, j) => j !== i && o.file === s.file && containsRange(o.range, s.range) &&
          // keep the earlier one when two ranges are identical
          !(containsRange(s.range, o.range) && i < j),
      ),
  );
}

/**
 * Moves a block's first line up over the comments, JSDoc and decorators directly above it,
 * which language servers leave out of a symbol's range but which often explain the code.
 */
export function leadingCommentStart(lines: string[], startLine: number): number {
  let line = startLine;
  let inBlock = false;
  while (line > 0) {
    const t = lines[line - 1].trim();
    if (inBlock) {
      line--;
      if (t.startsWith('/*')) {
        inBlock = false;
      }
    } else if (t.endsWith('*/') && !t.startsWith('/*')) {
      inBlock = true; // end of a multi-line block comment; walk up to its start
      line--;
    } else if (t.startsWith('//') || t.startsWith('#') || t.startsWith('@') || (t.startsWith('/*') && t.endsWith('*/'))) {
      line--;
    } else {
      break;
    }
  }
  return line;
}

const EXCLUDED_DIRS =['node_modules', 'site-packages', 'dist-packages', '.venv', 'venv', 'typeshed', 'lib.d.ts'];

export function isLibraryPath(filePath: string): boolean {
  const parts = filePath.split(/[\\/]/);
  return EXCLUDED_DIRS.some((d) => parts.includes(d)) || /lib\.[\w.]*\.d\.ts$/.test(filePath);
}
