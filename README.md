# bigCode

bigCode is a coding workspace for running coding agents through a fast web UI or desktop shell.

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

### Desktop App

Install the desktop app directly from GitHub Releases.

#### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/youpele52/bigCode/main/apps/marketing/public/install.sh | sh
```

#### Windows

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/youpele52/bigCode/main/apps/marketing/public/install.ps1 | iex"
```

#### Publishing a Release

Releases are published automatically via GitHub Actions when you push a version tag:

```bash
# Create and push a version tag to trigger a release
git tag v1.0.0
git push origin v1.0.0
```

The release workflow (`.github/workflows/release.yml`) will:

1. Run quality checks (format, lint, typecheck, tests)
2. Build desktop artifacts for all platforms (macOS arm64/x64, Linux x64, Windows x64)
3. Create a GitHub Release with all binaries attached

You can also trigger a release manually via the GitHub Actions UI using `workflow_dispatch`.

**Note:** The installer scripts above require at least one published GitHub Release. If no release exists, the installer will fail with a GitHub Releases error.

See [`docs/release.md`](./docs/release.md) for detailed release workflow documentation, signing setup, and troubleshooting.

### From Source

```bash
git clone https://github.com/youpele52/bigCode.git
cd bigCode
bun install
bun dev
```

Open the web app at `http://localhost:5733`.

To run the desktop shell in development:

```bash
bun dev:desktop
```

### Package Managers (Coming Soon)

Homebrew, winget, and AUR packages are planned but not yet available.

## Development

This is a Bun monorepo with a server app, React/Vite web app, desktop shell, shared contracts, and runtime utilities.

```bash
# Install dependencies
bun install

# Start full dev stack (server + web)
bun dev

# Start desktop development
bun dev:desktop

# Start individual apps
bun dev:server
bun dev:web

# Run checks
bun fmt
bun lint
bun typecheck
bun run test
```

Desktop packaging commands:

```bash
bun dist:desktop:dmg
bun dist:desktop:dmg:arm64
bun dist:desktop:dmg:x64
bun dist:desktop:linux
bun dist:desktop:win
```

Important test note: use `bun run test`, not `bun test`.

See [AGENTS.md](./AGENTS.md) for detailed development guidance, toolchain quirks, and architecture notes.

## Status

This project is early and evolving rapidly. Expect breaking changes.

We are not accepting contributions yet. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening issues or PRs.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).

## Documentation

- [AGENTS.md](./AGENTS.md) — Development guide for contributors
- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guidelines
- [docs/observability.md](./docs/observability.md) — Observability guide
- [packages/contracts/README.md](./packages/contracts/README.md) — Contracts package import guidance
