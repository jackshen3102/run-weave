# AGENTS

`packages/common` is only for common Web/App frontend code.

If a task or plan says `packages/commom`, treat it as a typo. The real directory is `packages/common`.

## Boundary

- Put code here only when Web and App both reuse it now, or when the same change adds both Web and App callers.
- Shared browser styles may live here only when both Web and App import the style asset.
- Keep backend, Electron, CLI, protocol, DTO, persistence models, and cross-runtime contracts in `packages/shared`.
- Treat `packages/shared` as the frontend/backend shared contract package, mainly for types, protocols, DTOs, and pure TypeScript contracts used across runtimes.
- Do not move App-only UI helpers, Web-only terminal behavior, backend helpers, Electron bridge code, CLI helpers, or service contracts into this package.

## Exports

- Add explicit subpath exports only, such as `@runweave/common/terminal`.
- Do not add a root `@runweave/common` export.
- Do not import from the package root.

Before adding or moving an export, write down the Web caller and the App caller in the change description. If either caller does not exist, keep the code in its current owner.
