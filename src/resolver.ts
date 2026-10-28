import * as fs from 'fs';
import * as path from 'path';

export interface CollectOptions {
  /** Workspace root, used for Python absolute imports and relative labels. */
  root: string;
  /** How many hops of imports to follow from the entry files. 0 = entry files only. */
  maxDepth: number;
  /** Hard cap on the number of files collected. */
  maxFiles: number;
  /** Reads a file's text; return undefined if unreadable. Lets callers prefer unsaved editor buffers. */
  readFile?: (filePath: string) => string | undefined;
}

export interface CollectedFile {
  path: string;
  depth: number;
  content: string;
}

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

function defaultReadFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function languageOf(filePath: string): 'js' | 'py' | undefined {
  const ext = path.extname(filePath).toLowerCase();
  if (JS_EXTS.includes(ext) || ext === '.vue' || ext === '.svelte') {
    return 'js';
  }
  if (ext === '.py' || ext === '.pyi') {
    return 'py';
  }
  return undefined;
}

/** Extracts module specifiers from JS/TS source. */
export function jsSpecifiers(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      specs.add(m[1]);
    }
  }
  return [...specs];
}

/** Strips comments and trailing commas from JSONC without touching string contents (e.g. "@/*"). */
export function parseJsonc(text: string): any {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface PathAliases {
  /** Directory that alias targets are relative to (baseUrl, or the config's own directory). */
  baseDir: string;
  paths: Record<string, string[]>;
}

const configCache = new Map<string, { mtime: number; aliases: PathAliases | undefined }>();

/** Reads `paths` from a tsconfig/jsconfig, following `extends` and `references` when it has none itself. */
function aliasesFromConfig(configPath: string, visited = new Set<string>()): PathAliases | undefined {
  if (visited.has(configPath) || !isFile(configPath)) {
    return undefined;
  }
  visited.add(configPath);
  const mtime = fs.statSync(configPath).mtimeMs;
  const cached = configCache.get(configPath);
  if (cached && cached.mtime === mtime) {
    return cached.aliases;
  }

  let aliases: PathAliases | undefined;
  try {
    const json = parseJsonc(fs.readFileSync(configPath, 'utf8'));
    const dir = path.dirname(configPath);
    const opts = json.compilerOptions ?? {};
    if (opts.paths && typeof opts.paths === 'object') {
      aliases = { baseDir: path.resolve(dir, opts.baseUrl ?? '.'), paths: opts.paths };
    } else {
      const related: string[] = [];
      for (const ext of [json.extends].flat()) {
        if (typeof ext === 'string' && ext.startsWith('.')) {
          related.push(path.resolve(dir, ext.endsWith('.json') ? ext : ext + '.json'));
        }
      }
      for (const ref of json.references ?? []) {
        if (typeof ref?.path === 'string') {
          const p = path.resolve(dir, ref.path);
          related.push(p.endsWith('.json') ? p : path.join(p, 'tsconfig.json'));
        }
      }
      for (const r of related) {
        aliases = aliasesFromConfig(r, visited);
        if (aliases) {
          break;
        }
      }
    }
  } catch {
    aliases = undefined; // malformed config: fall back to relative imports only
  }
  configCache.set(configPath, { mtime, aliases });
  return aliases;
}

/** Finds the nearest tsconfig.json/jsconfig.json between the file and the workspace root. */
function findAliases(fromFile: string, root: string): PathAliases | undefined {
  const stop = path.resolve(root);
  let dir = path.dirname(path.resolve(fromFile));
  while (true) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const aliases = aliasesFromConfig(path.join(dir, name));
      if (aliases) {
        return aliases;
      }
    }
    const parent = path.dirname(dir);
    if (dir === stop || parent === dir || !dir.startsWith(stop)) {
      return undefined;
    }
    dir = parent;
  }
}

function aliasTargets(spec: string, aliases: PathAliases): string[] {
  const out: string[] = [];
  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const star = pattern.indexOf('*');
    let captured: string | undefined;
    if (star === -1) {
      captured = spec === pattern ? '' : undefined;
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
        captured = spec.slice(prefix.length, spec.length - suffix.length);
      }
    }
    if (captured !== undefined && Array.isArray(targets)) {
      out.push(...targets.map((t) => path.resolve(aliases.baseDir, t.replace('*', captured!))));
    }
  }
  return out;
}

export function resolveJs(spec: string, fromFile: string, root?: string): string | undefined {
  if (!spec.startsWith('.') && !path.isAbsolute(spec)) {
    // Bare specifier: a tsconfig path alias like '@/lib/x', otherwise a package like 'react'.
    const aliases = root ? findAliases(fromFile, root) : undefined;
    if (!aliases) {
      return undefined;
    }
    for (const target of aliasTargets(spec, aliases)) {
      const hit = resolveJsPath(target);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }
  return resolveJsPath(path.resolve(path.dirname(fromFile), spec));
}

function resolveJsPath(base: string): string | undefined {
  const candidates: string[] = [base];
  const ext = path.extname(base);
  for (const tsExt of JS_TO_TS[ext] ?? []) {
    candidates.push(base.slice(0, -ext.length) + tsExt);
  }
  for (const e of JS_EXTS) {
    candidates.push(base + e);
  }
  for (const e of JS_EXTS) {
    candidates.push(path.join(base, 'index' + e));
  }
  return candidates.find(isFile);
}

interface PyImport {
  /** Number of leading dots; 0 = absolute import. */
  level: number;
  module: string;
  /** Names after `from x import`, which may themselves be submodules. */
  names: string[];
}

/** Extracts imports from Python source. */
export function pyImports(source: string): PyImport[] {
  const text = source.replace(/#.*$/gm, '');
  const out: PyImport[] = [];
  for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm)) {
    const names = m[3]
      .replace(/[()\\]/g, ' ')
      .split(',')
      .map((n) => n.trim().split(/\s+/)[0])
      .filter((n) => n && n !== '*');
    out.push({ level: m[1].length, module: m[2], names });
  }
  for (const m of text.matchAll(/^[ \t]*import[ \t]+([^\n]+)/gm)) {
    for (const part of m[1].split(',')) {
      const mod = part.trim().split(/\s+/)[0];
      if (mod) {
        out.push({ level: 0, module: mod, names: [] });
      }
    }
  }
  return out;
}

function pyModuleFile(baseDir: string, dotted: string): string | undefined {
  const parts = dotted ? dotted.split('.') : [];
  const p = path.join(baseDir, ...parts);
  return [p + '.py', p + '.pyi', path.join(p, '__init__.py')].find(isFile);
}

export function resolvePy(imp: PyImport, fromFile: string, root: string): string[] {
  let bases: string[];
  if (imp.level > 0) {
    let dir = path.dirname(fromFile);
    for (let i = 1; i < imp.level; i++) {
      dir = path.dirname(dir);
    }
    bases = [dir];
  } else {
    // Script directory, workspace root, and the common src/ layout.
    bases = [path.dirname(fromFile), root, path.join(root, 'src')];
  }

  const found: string[] = [];
  for (const base of bases) {
    const mod = imp.module ? pyModuleFile(base, imp.module) : undefined;
    if (mod && !mod.endsWith('__init__.py')) {
      found.push(mod);
    } else {
      if (mod) {
        found.push(mod);
      }
      // `from pkg import sub` / `from . import sub` where sub is a module.
      for (const name of imp.names) {
        const sub = pyModuleFile(base, imp.module ? `${imp.module}.${name}` : name);
        if (sub) {
          found.push(sub);
        }
      }
    }
    if (found.length > 0) {
      break;
    }
  }
  return found;
}

export function directImports(filePath: string, source: string, root: string): string[] {
  const lang = languageOf(filePath);
  let deps: string[] = [];
  if (lang === 'js') {
    deps = jsSpecifiers(source)
      .map((s) => resolveJs(s, filePath, root))
      .filter((p): p is string => p !== undefined);
  } else if (lang === 'py') {
    deps = pyImports(source).flatMap((imp) => resolvePy(imp, filePath, root));
  }
  const self = path.resolve(filePath);
  return [...new Set(deps.map((d) => path.resolve(d)))].filter(
    (d) => d !== self && !d.split(path.sep).includes('node_modules'),
  );
}

/** Breadth-first walk from the entry files through their local imports. */
export function collect(entries: string[], opts: CollectOptions): CollectedFile[] {
  const read = opts.readFile ?? defaultReadFile;
  const seen = new Set<string>();
  const result: CollectedFile[] = [];
  let frontier = entries.map((e) => path.resolve(e));

  for (let depth = 0; depth <= opts.maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      if (seen.has(file) || result.length >= opts.maxFiles) {
        continue;
      }
      seen.add(file);
      const content = read(file);
      if (content === undefined) {
        continue;
      }
      result.push({ path: file, depth, content });
      if (depth < opts.maxDepth) {
        next.push(...directImports(file, content, opts.root));
      }
    }
    frontier = next;
  }
  return result;
}
