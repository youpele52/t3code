# Browser Tests

## Overview

Browser tests use [Vitest Browser Mode](https://vitest.dev/guide/browser/) with Playwright (Chromium) and `vitest-browser-react`. They test interactive UI components that require a real DOM, user events, and layout (e.g. menu positioning, focus, animation).

Config: `apps/web/vitest.browser.config.ts`
CI command: `bun run --cwd apps/web test:browser`
Local install: `bun run --cwd apps/web test:browser:install`

## File naming convention

| Pattern                  | Picked up by CI? | Use for                                        |
| ------------------------ | ---------------- | ---------------------------------------------- |
| `*.browser.tsx`          | Yes              | Active browser tests run in CI                 |
| `*.deferred-browser.tsx` | No               | Tests temporarily excluded from CI (see below) |

The include glob in `vitest.browser.config.ts` is:

```ts
include: ["src/components/**/*.browser.tsx"];
```

Only files ending in `.browser.tsx` are included. Files renamed to `.deferred-browser.tsx` are excluded from the CI run but remain in the repo so they can be revisited.

## Deferred tests

The following tests have been temporarily moved out of CI. Each entry notes why and what needs to happen before re-enabling it.

### `ProviderModelPicker.deferred-browser.tsx`

**File:** `apps/web/src/components/chat/provider/ProviderModelPicker.deferred-browser.tsx`

**Status:** Deferred — intermittently failing in CI (Chromium headless), passes locally.

**Failing test:** `ProviderModelPicker > dispatches the canonical slug when a model is selected`

**What it tests:** Clicks `Claude Sonnet 4.6` in a locked-provider menu and asserts that `onProviderModelChange("claudeAgent", "claude-sonnet-4-6")` is called.

**Suspected cause:** The test relies on sub-menu open/close timing and `MenuRadioGroup.onValueChange` firing synchronously after a click in headless Chromium. The exact race condition has not been fully isolated; the test passes consistently in headed local runs.

**To re-enable:**

1. Reproduce the failure reliably (run with `--repeat=20` in headless mode).
2. Fix the root cause — either a timing issue in the menu component or a missing `await` / `vi.waitFor` around the click assertion.
3. Rename the file back to `ProviderModelPicker.browser.tsx` once stable.

## Adding new browser tests

1. Create a file matching `src/components/**/*.browser.tsx`.
2. Import helpers from `vitest/browser` (`page`) and `vitest-browser-react` (`render`).
3. Always clean up rendered trees in `afterEach` or a `finally` block to avoid bleed between tests.
4. Keep assertions inside `vi.waitFor(...)` when they depend on async DOM updates.
5. Run locally before pushing: `bun run --cwd apps/web test:browser`.
