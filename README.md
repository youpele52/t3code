# T3 Code

T3 Code is a minimal web GUI for coding agents.

## Supported Providers

- **Codex** (OpenAI) — install [Codex CLI](https://github.com/openai/codex) and run `codex login`
- **Claude** (Anthropic) — install Claude Code and run `claude auth login`
- **Copilot** (GitHub) — authenticate via GitHub CLI or VS Code
- **OpenCode** — see [OpenCode docs](https://opencode.ai)

## Installation

### Prerequisites

Install and authenticate at least one provider:
- **Codex**: install [Codex CLI](https://github.com/openai/codex) and run `codex login`
- **Claude**: install Claude Code and run `claude auth login`
- **Copilot**: authenticate via GitHub CLI or VS Code
- **OpenCode**: see [OpenCode docs](https://opencode.ai)

### From Source

```bash
git clone https://github.com/pingdotgg/t3code.git
cd t3code
bun install
bun dev
```

### Package Managers (Coming Soon)

Homebrew, winget, and AUR packages are planned but not yet available.

## Development

This is a monorepo with a Node.js/Bun server and a React/Vite web app.

```bash
# Install dependencies
bun install

# Start full dev stack (server + web)
bun dev

# Run checks
bun fmt
bun lint
bun typecheck
bun run test
```

See [AGENTS.md](./AGENTS.md) for detailed development guidance, toolchain quirks, and architecture notes.

## Status

This project is early and evolving rapidly. Expect breaking changes.

We are not accepting contributions yet. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening issues or PRs.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

## Documentation

- [AGENTS.md](./AGENTS.md) — Development guide for contributors
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guidelines
- [docs/observability.md](./docs/observability.md) — Observability guide
