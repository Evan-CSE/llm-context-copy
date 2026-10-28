import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { collect, CollectedFile } from './resolver';
import { estimateTokens, format, OutputFormat } from './format';

function targetUris(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
  if (uris && uris.length > 0) {
    return uris;
  }
  if (uri) {
    return [uri];
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return active ? [active] : [];
}

function rootFor(uri: vscode.Uri): string {
  return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(uri.fsPath);
}

/** Prefer the text of open editors so unsaved edits are included. */
function readPreferringOpenDocs(filePath: string): string | undefined {
  // Windows paths are case-insensitive and VS Code lowercases the drive letter.
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === 'file' && norm(d.uri.fsPath) === norm(filePath),
  );
  if (doc) {
    return doc.getText();
  }
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

async function run(pick: boolean, uri?: vscode.Uri, uris?: vscode.Uri[]): Promise<void> {
  const targets = targetUris(uri, uris).filter((u) => u.scheme === 'file');
  if (targets.length === 0) {
    vscode.window.showWarningMessage('Import Context Copy: open or select a file first.');
    return;
  }

  const config = vscode.workspace.getConfiguration('llmContextCopy');
  const root = rootFor(targets[0]);
  let files: CollectedFile[] = collect(
    targets.map((t) => t.fsPath),
    {
      root,
      maxDepth: config.get<number>('maxDepth', 2),
      maxFiles: config.get<number>('maxFiles', 30),
      readFile: readPreferringOpenDocs,
    },
  );

  if (pick && files.length > 1) {
    const items = files.map((f) => ({
      label: path.basename(f.path),
      description: path.relative(root, f.path).split(path.sep).join('/'),
      detail: f.depth === 0 ? 'selected file' : `import depth ${f.depth} · ~${estimateTokens(f.content)} tokens`,
      picked: true,
      file: f,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: 'Files to copy as LLM context',
    });
    if (!chosen || chosen.length === 0) {
      return;
    }
    files = chosen.map((c) => c.file);
  }

  const text = format(files, root, config.get<OutputFormat>('format', 'markdown'));
  await vscode.env.clipboard.writeText(text);
  const imports = files.filter((f) => f.depth > 0).length;
  vscode.window.setStatusBarMessage(
    `$(clippy) Copied ${files.length} file(s) (${imports} via imports), ~${estimateTokens(text).toLocaleString()} tokens`,
    5000,
  );
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('llmContextCopy.copy', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      run(false, uri, uris),
    ),
    vscode.commands.registerCommand('llmContextCopy.copyPick', (uri?: vscode.Uri, uris?: vscode.Uri[]) =>
      run(true, uri, uris),
    ),
  );
}

export function deactivate(): void {}
