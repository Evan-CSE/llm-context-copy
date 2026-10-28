import * as vscode from 'vscode';
import {
  chainAt, dropContained, qualifiedName, identifierRefs, isLibraryPath, Kind, pickDependency, Rng, Snippet, Sym,
  containsPos, containsRange,
} from './slice';

export interface CodeSnippet extends Snippet {
  text: string;
}

export interface SliceOptions {
  maxDepth: number;
  maxSnippets: number;
  includeImplementations: boolean;
  token?: vscode.CancellationToken;
}

export interface SliceResult {
  snippets: CodeSnippet[];
  /** False when no language server answered at all (e.g. Python without the Python extension). */
  providerFound: boolean;
}

const toRng = (r: vscode.Range): Rng => ({
  start: { line: r.start.line, character: r.start.character },
  end: { line: r.end.line, character: r.end.character },
});

const toRange = (r: Rng) => new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);

/** Expands a range to whole lines so snippets keep their indentation. */
function fullLines(doc: vscode.TextDocument, r: Rng): Rng {
  const endLine = r.end.character === 0 && r.end.line > r.start.line ? r.end.line - 1 : r.end.line;
  return { start: { line: r.start.line, character: 0 }, end: { line: endLine, character: doc.lineAt(endLine).text.length } };
}

function flatten(items: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined): Sym[] {
  const out: Sym[] = [];
  const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[]) => {
    for (const s of list) {
      // executeDocumentSymbolProvider returns objects that are *both* SymbolInformation and DocumentSymbol,
      // so check for the richer DocumentSymbol shape first or nested members and name ranges are lost.
      if ('selectionRange' in s) {
        out.push({ name: s.name, kind: s.kind as number as Kind, range: toRng(s.range), selectionRange: toRng(s.selectionRange) });
        walk(s.children ?? []);
      } else {
        out.push({ name: s.name, kind: s.kind as number as Kind, range: toRng(s.location.range), selectionRange: toRng(s.location.range) });
      }
    }
  };
  walk(items ?? []);
  return out;
}

export class SymbolCache {
  private cache = new Map<string, Promise<Sym[]>>();
  get(uri: vscode.Uri): Promise<Sym[]> {
    const key = uri.toString();
    if (!this.cache.has(key)) {
      this.cache.set(
        key,
        Promise.resolve(
          vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri),
        ).then(flatten, () => []),
      );
    }
    return this.cache.get(key)!;
  }
}

type Def = vscode.Location | vscode.LocationLink;
const defUri = (d: Def) => ('targetUri' in d ? d.targetUri : d.uri);
const defPos = (d: Def) => ('targetUri' in d ? (d.targetSelectionRange ?? d.targetRange).start : d.range.start);

function inWorkspace(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && !!vscode.workspace.getWorkspaceFolder(uri) && !isLibraryPath(uri.fsPath);
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Collects the root block plus every workspace definition it depends on, breadth-first.
 * Definitions come from the language server, so this works for any language with one installed.
 */
export async function sliceDependencies(
  rootDoc: vscode.TextDocument,
  rootRange: Rng,
  rootName: string,
  opts: SliceOptions,
  symbols = new SymbolCache(),
): Promise<SliceResult> {
  const root: CodeSnippet = {
    file: rootDoc.uri.fsPath, range: fullLines(rootDoc, rootRange), name: rootName, depth: 0,
    text: rootDoc.getText(toRange(fullLines(rootDoc, rootRange))),
  };
  const snippets: CodeSnippet[] = [root];
  const key = (file: string, r: Rng) => `${file}#${r.start.line}:${r.start.character}`;
  const seen = new Set([key(root.file, rootRange)]);
  let providerFound = false;
  let frontier: { doc: vscode.TextDocument; snip: CodeSnippet }[] = [{ doc: rootDoc, snip: root }];

  const covered = (file: string, r: Rng) =>
    snippets.some((s) => s.file === file && containsRange(s.range, r));

  for (let depth = 1; depth <= opts.maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const { doc, snip } of frontier) {
      if (opts.token?.isCancellationRequested || snippets.length >= opts.maxSnippets) {
        break;
      }
      const refs = identifierRefs(snip.text, snip.range.start);
      const results = await mapLimit(refs, 8, async (ref) => {
        const pos = new vscode.Position(ref.line, ref.character);
        const defs = (await vscode.commands.executeCommand<Def[]>('vscode.executeDefinitionProvider', doc.uri, pos)) ?? [];
        return { pos, defs };
      });

      for (const { pos, defs } of results) {
        if (defs.length > 0) {
          providerFound = true;
        }
        const targets = defs.filter((d) => inWorkspace(defUri(d)));
        for (const def of targets) {
          if (snippets.length >= opts.maxSnippets) {
            break;
          }
          const uri = defUri(def);
          const at = defPos(def);
          const chain = chainAt(await symbols.get(uri), at);
          const dep = pickDependency(chain);
          if (!dep) {
            continue;
          }
          // The enclosing scope of the root (e.g. selection inside a function using a local).
          if (uri.fsPath === root.file && containsRange(dep.range, root.range)) {
            continue;
          }
          // Skip adding what's already being copied (locals, params, the block itself, a shape seen earlier),
          // but still fall through to the implementation lookup below.
          const depKey = key(uri.fsPath, dep.range);
          if (!seen.has(depKey) && !covered(uri.fsPath, { start: at, end: at })) {
            seen.add(depKey);
            const depDoc = await vscode.workspace.openTextDocument(uri);
            const range = fullLines(depDoc, dep.range);
            const depSnip: CodeSnippet = { file: uri.fsPath, range, name: qualifiedName(chain, dep), depth, text: depDoc.getText(toRange(range)) };
            snippets.push(depSnip);
            next.push({ doc: depDoc, snip: depSnip });
          }

          // Calling a member through an interface hides the real logic: also take the implementations.
          // Checked even when the interface was already collected (e.g. via a type annotation).
          // A member is "inside the interface but not its name". Not every server lists members as symbols
          // (TypeScript doesn't), so this can't rely on the chain having a Method/Property child.
          const viaInterfaceMember = dep.kind === Kind.Interface && !containsPos(dep.selectionRange, at);
          if (opts.includeImplementations && viaInterfaceMember) {
            const impls = ((await vscode.commands.executeCommand<Def[]>('vscode.executeImplementationProvider', doc.uri, pos)) ?? [])
              .filter((d) => inWorkspace(defUri(d)))
              .slice(0, 3);
            for (const impl of impls) {
              const iUri = defUri(impl);
              const iChain = chainAt(await symbols.get(iUri), defPos(impl));
              const iDep = pickDependency(iChain);
              if (!iDep || seen.has(key(iUri.fsPath, iDep.range)) || snippets.length >= opts.maxSnippets) {
                continue;
              }
              seen.add(key(iUri.fsPath, iDep.range));
              const iDoc = await vscode.workspace.openTextDocument(iUri);
              const iRange = fullLines(iDoc, iDep.range);
              const iSnip: CodeSnippet = { file: iUri.fsPath, range: iRange, name: qualifiedName(iChain, iDep), depth, text: iDoc.getText(toRange(iRange)) };
              snippets.push(iSnip);
              next.push({ doc: iDoc, snip: iSnip });
            }
          }
        }
      }
    }
    frontier = next;
  }

  return { snippets: dropContained(snippets), providerFound };
}
