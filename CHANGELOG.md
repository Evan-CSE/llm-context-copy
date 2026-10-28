# Changelog

## 0.1.0

- Initial release: copy a file (or several) plus its local imports as LLM context.
- Supports JS/TS (relative imports, `index` files, `.js` → `.ts` ESM paths, `tsconfig`/`jsconfig` path aliases) and Python (absolute, relative, `src/` layout, submodule imports).
- Markdown or XML output, configurable depth and file cap, file picker, token estimate.
