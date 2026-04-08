import {
  ProviderItemId,
  RuntimeMode,
  TurnId,
  type ProviderUserInputAnswers,
} from "@bigcode/contracts";

import { killCodexChildProcess } from "../provider/codexAppServer";
import { type CodexUserInputAnswer } from "./codexAppServerManager.types";
import { type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Maps the T3 runtime mode to Codex approval policy and sandbox settings.
 */
export function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: "on-request" | "never";
  readonly sandbox: "workspace-write" | "danger-full-access";
} {
  if (runtimeMode === "approval-required") {
    return {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    };
  }

  return {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
export function killChildTree(child: ChildProcessWithoutNullStreams): void {
  killCodexChildProcess(child);
}

function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

export function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

export function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

export function readResumeThreadId(input: {
  readonly resumeCursor?: unknown;
  readonly threadId?: import("@bigcode/contracts").ThreadId;
  readonly runtimeMode?: RuntimeMode;
}): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

export function toTurnId(
  value: string | undefined,
): import("@bigcode/contracts").TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

export function toProviderItemId(
  value: string | undefined,
): import("@bigcode/contracts").ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}
