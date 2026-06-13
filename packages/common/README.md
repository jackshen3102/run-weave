# @runweave/common

`@runweave/common` is the shared frontend layer for Web and App code.

`packages/commom` is a typo. Use `packages/common`.

Move code here only when Web and App both reuse it now, or when the same change adds both callers. Shared browser styles may live here only when both frontends import the style asset.

Do not use this package for backend, Electron, CLI, protocol, DTO, persistence models, or cross-runtime contracts. Those belong in `@runweave/shared`, which is the frontend/backend shared contract package for types, protocols, DTOs, and pure TypeScript contracts used across runtimes.

Import from explicit subpaths such as `@runweave/common/terminal`. Do not add a root package export, and do not import from `@runweave/common`.
