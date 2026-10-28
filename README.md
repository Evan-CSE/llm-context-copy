# Import Context Copy

Pasting one file into ChatGPT, Claude or Gemini usually isn't enough, because the model also needs the types, helpers and config that file imports. **Import Context Copy** gathers the file plus the local files it imports and puts them all on your clipboard as one prompt-ready block.

## Usage

Right-click a file (or several) in the Explorer, or right-click inside an editor:

- **Copy with Imports as LLM Context**: copies straight away.
- **Copy with Imports as LLM Context (Choose Files...)**: lets you untick files before copying.

Both commands are also in the Command Palette under `LLM Context:`. The status bar shows how many files were copied and a rough token count.

Unsaved editor changes are included.

### Output

````markdown
## src/api/user.ts

```ts
import { db } from '../db';
...
```

## src/db/index.ts
...
````

Set `llmContextCopy.format` to `xml` to get `<file path="...">…</file>` blocks instead, which suits Claude well.

## What gets followed

| Language | Followed | Skipped |
|---|---|---|
| JS / TS | `import`, `export … from`, side-effect imports, `import()`, `require()`; `index.*` files; `./x.js` → `x.ts`; `tsconfig`/`jsconfig` path aliases (`@/…`), following `extends` and `references` | Bare package imports (`react`), anything in `node_modules` |
| Python | `import a.b`, `from a import b`, relative `from ..x import y`, `from pkg import submodule`, `src/` layout | stdlib and installed packages (anything not found in the workspace) |

Imports are followed breadth-first, so the closest dependencies come first. Cycles are handled.

## Settings

| Setting | Default | Description |
|---|---|---|
| `llmContextCopy.maxDepth` | `2` | Levels of imports to follow (`0` = selected files only) |
| `llmContextCopy.maxFiles` | `30` | Maximum files included |
| `llmContextCopy.format` | `markdown` | `markdown` or `xml` |

## Limitations (v0.1)

- Monorepo workspace packages (`@myorg/shared` from another package) aren't followed.
- Works on local files only (not remote/virtual workspaces).

## Development

```sh
npm install
npm test          # compiles and runs the resolver tests
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host. Run `npm run package` to build a `.vsix`.

## License

MIT
