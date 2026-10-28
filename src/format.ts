import * as path from 'path';
import { CollectedFile } from './resolver';

export type OutputFormat = 'markdown' | 'xml';

const FENCE_LANG: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
  '.py': 'python', '.pyi': 'python', '.vue': 'vue', '.svelte': 'svelte',
  '.json': 'json',
};

function relLabel(file: string, root: string): string {
  const rel = path.relative(root, file);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? file : rel).split(path.sep).join('/');
}

/** A fence longer than any backtick run in the content, so nested code blocks survive. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

export function format(files: CollectedFile[], root: string, style: OutputFormat): string {
  return files
    .map((f) => {
      const label = relLabel(f.path, root);
      const body = f.content.endsWith('\n') ? f.content : f.content + '\n';
      if (style === 'xml') {
        return `<file path="${label}">\n${body}</file>`;
      }
      const fence = fenceFor(f.content);
      const lang = FENCE_LANG[path.extname(f.path).toLowerCase()] ?? '';
      return `## ${label}\n\n${fence}${lang}\n${body}${fence}`;
    })
    .join('\n\n') + '\n';
}

export interface FormattableSnippet {
  file: string;
  /** 0-based, inclusive. */
  startLine: number;
  endLine: number;
  name: string;
  text: string;
}

/** Like `format`, but for code excerpts: the heading carries line numbers and the symbol name. */
export function formatSnippets(snippets: FormattableSnippet[], root: string, style: OutputFormat): string {
  return snippets
    .map((s) => {
      const label = relLabel(s.file, root);
      const lines = `${s.startLine + 1}-${s.endLine + 1}`;
      const body = s.text.endsWith('\n') ? s.text : s.text + '\n';
      if (style === 'xml') {
        return `<snippet path="${label}" lines="${lines}" symbol="${s.name}">\n${body}</snippet>`;
      }
      const fence = fenceFor(s.text);
      const lang = FENCE_LANG[path.extname(s.file).toLowerCase()] ?? '';
      return `## ${label}:${lines} · ${s.name}\n\n${fence}${lang}\n${body}${fence}`;
    })
    .join('\n\n') + '\n';
}

/** Rough token estimate (~4 chars per token), good enough for a heads-up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
