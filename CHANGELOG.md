# Changelog

## 0.2.1

- Copy Block with Dependencies now includes the comments, doc comments and decorators directly above each copied definition.
- README: demo GIF for Copy Block, a full limitations section, privacy note, and badges.

## 0.2.0

- New: **Copy Block with Dependencies as LLM Context** (editor right-click). Copies the function, class or interface at the cursor (or the selected lines) plus only the functions, types and constants it uses, recursively, instead of whole files.
  - Interface members called on an interface also pull in their implementations (up to 3).
  - Uses VS Code language servers: TypeScript/JavaScript built in; Python, Go, Java, C#, etc. with their extensions.
  - New settings: `blockDepth`, `maxSnippets`, `includeImplementations`.

## 0.1.1

- Explorer menu: both commands now sit together in their own section instead of being interleaved with Copy Path / Copy Relative Path.
- File picker shows paths with forward slashes on Windows, matching the copied output.

## 0.1.0

- Initial release: copy a file (or several) plus its local imports as LLM context.
- Supports JS/TS (relative imports, `index` files, `.js` → `.ts` ESM paths, `tsconfig`/`jsconfig` path aliases) and Python (absolute, relative, `src/` layout, submodule imports).
- Markdown or XML output, configurable depth and file cap, file picker, token estimate.
