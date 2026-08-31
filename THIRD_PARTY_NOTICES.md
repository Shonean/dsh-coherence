# Third-Party Notices

This project includes third-party software. Each item below keeps its own
license terms.

## Vendored build tooling

- **`packages/typert/generator`** — copied from
  [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
  (`packages/typert/generator`, MIT License, © DeepSeek). It generates the
  Typert host/remote client faces for the `dsh-coherence` plugin at build
  time. It is a build tool only: it never ships in any published artifact or
  runs inside a user's DSH instance.

## Runtime and dev dependencies

All other dependencies are consumed from npm under their own licenses
(MIT unless noted): the `@deepseek-ai/*` DSH kernel packages and the rescoped
Cordis framework forks (`@deepseek-ai/cordis`, `@deepseek-ai/cosmokit`,
`@deepseek-ai/schemastery`, `@deepseek-ai/cordis-plugin-*`, © DeepSeek and the
Cordis ecosystem authors), `@modelcontextprotocol/sdk`, `zod`, `react`,
`react-dom`, `@testing-library/react`, `lightningcss`, `jsdom`, and the
build/test toolchain (`tsdown`, `vitest`, `oxlint`, `typescript`, `tsx`).

Run `pnpm install` and consult each package's `LICENSE` for full terms.
