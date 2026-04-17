import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { buildPiRpcInvocation } from "./PiCli.ts";

export interface PiRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiRpcModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly reasoning?: boolean;
}

export interface PiRpcSlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly source?: "extension" | "prompt" | "skill";
  readonly sourceInfo?: {
    readonly path: string;
    readonly source: string;
    readonly scope: "user" | "project" | "temporary";
    readonly origin: "package" | "top-level";
    readonly baseDir?: string;
  };
}

export interface PiRpcSessionState {
  readonly model?: PiRpcModel | null;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
}

export type PiRpcRequestCommand =
  | { readonly type: "get_state" }
  | { readonly type: "get_messages" }
  | { readonly type: "get_available_models" }
  | { readonly type: "get_commands" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: string }
  | {
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | {
      readonly type: "steer";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
    }
  | {
      readonly type: "follow_up";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
    }
  | { readonly type: "abort" };

export type PiRpcWriteOnlyCommand =
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly value: string;
    }
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly confirmed: boolean;
    }
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly cancelled: true;
    };

export type PiRpcCommand = (PiRpcRequestCommand & { readonly id?: string }) | PiRpcWriteOnlyCommand;

export interface PiRpcResponse<TData = unknown> {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: TData;
  readonly error?: string;
}

export type PiRpcAssistantMessageEvent =
  | {
      readonly type: "start";
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "text_start";
      readonly contentIndex: number;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "text_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "text_end";
      readonly contentIndex: number;
      readonly content: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "thinking_start";
      readonly contentIndex: number;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "thinking_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "thinking_end";
      readonly contentIndex: number;
      readonly content: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "toolcall_start";
      readonly contentIndex: number;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "toolcall_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "toolcall_end";
      readonly contentIndex: number;
      readonly toolCall: Record<string, unknown>;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "done";
      readonly reason: string;
      readonly message: Record<string, unknown>;
    }
  | {
      readonly type: "error";
      readonly reason: string;
      readonly error: Record<string, unknown>;
    };

export type PiRpcExtensionUIRequest =
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "select";
      readonly title: string;
      readonly options: ReadonlyArray<string>;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "confirm";
      readonly title: string;
      readonly message: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "input";
      readonly title: string;
      readonly placeholder?: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "editor";
      readonly title: string;
      readonly prefill?: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "notify";
      readonly message: string;
      readonly notifyType?: "info" | "warning" | "error";
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setStatus";
      readonly statusKey: string;
      readonly statusText: string | undefined;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setWidget";
      readonly widgetKey: string;
      readonly widgetLines: ReadonlyArray<string> | undefined;
      readonly widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setTitle";
      readonly title: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "set_editor_text";
      readonly text: string;
    };

export type PiRpcStdoutEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end" }
  | {
      readonly type: "turn_start";
      readonly turnIndex?: number;
      readonly timestamp?: number;
    }
  | {
      readonly type: "turn_end";
      readonly turnIndex?: number;
      readonly message?: Record<string, unknown>;
      readonly toolResults?: unknown;
    }
  | {
      readonly type: "message_start";
      readonly message: Record<string, unknown>;
    }
  | {
      readonly type: "message_update";
      readonly message: Record<string, unknown>;
      readonly assistantMessageEvent?: PiRpcAssistantMessageEvent;
    }
  | {
      readonly type: "message_end";
      readonly message: Record<string, unknown>;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: Record<string, unknown>;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: Record<string, unknown>;
      readonly partialResult?: string;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result?: unknown;
      readonly isError?: boolean;
    }
  | PiRpcExtensionUIRequest;

export type PiRpcStdoutMessage = PiRpcResponse | PiRpcStdoutEvent;

export interface PiRpcProcessOptions {
  readonly binaryPath: string;
  readonly cwd?: string;
  readonly sessionFile?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PiRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly stderrTail: () => string;
  readonly request: <TData = unknown>(
    command: PiRpcRequestCommand,
    timeoutMs?: number,
  ) => Promise<PiRpcResponse<TData>>;
  readonly write: (command: PiRpcCommand) => Promise<void>;
  readonly subscribe: (listener: (message: PiRpcStdoutMessage) => void) => () => void;
  readonly stop: () => Promise<void>;
}

interface PendingResponse {
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_MAX_CHARS = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPiRpcResponse(message: unknown): message is PiRpcResponse {
  return isRecord(message) && message.type === "response" && typeof message.command === "string";
}

function describePiExit(
  command: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
): Error {
  const stderr = stderrTail.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(
    `Pi RPC process '${command}' exited (code=${code ?? "null"}, signal=${signal ?? "null"}).${detail}`,
  );
}

function nextStderrTail(previous: string, chunk: string): string {
  const next = `${previous}${chunk}`;
  return next.length > STDERR_TAIL_MAX_CHARS ? next.slice(-STDERR_TAIL_MAX_CHARS) : next;
}

function writeJsonLine(
  child: ChildProcessWithoutNullStreams,
  command: PiRpcCommand,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.stdin.writable) {
      reject(new Error("Pi RPC stdin is no longer writable."));
      return;
    }

    child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function createPiRpcProcess(options: PiRpcProcessOptions): Promise<PiRpcProcess> {
  const invocation = buildPiRpcInvocation(
    options.binaryPath,
    options.sessionFile ? ["--session", options.sessionFile] : [],
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const listeners = new Set<(message: PiRpcStdoutMessage) => void>();
  const pending = new Map<string, PendingResponse>();
  const decoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stderrTail = "";
  let closed = false;
  let exitPromise: Promise<void> | undefined;

  const rejectAllPending = (error: Error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timeout);
      entry.reject(error);
      pending.delete(id);
    }
  };

  const handleMessage = (message: PiRpcStdoutMessage) => {
    if (isPiRpcResponse(message) && typeof message.id === "string") {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        clearTimeout(entry.timeout);
        if (message.success) {
          entry.resolve(message);
        } else {
          entry.reject(new Error(message.error ?? `Pi RPC command '${message.command}' failed.`));
        }
      }
    }

    for (const listener of listeners) {
      listener(message);
    }
  };

  const handleLine = (line: string) => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.length === 0) {
      return;
    }

    try {
      const parsed = JSON.parse(trimmed) as PiRpcStdoutMessage;
      handleMessage(parsed);
    } catch {
      // Ignore malformed stdout records from Pi.
    }
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      handleLine(line);
    }
  });

  child.stdout.on("end", () => {
    stdoutBuffer += decoder.end();
    if (stdoutBuffer.length > 0) {
      handleLine(stdoutBuffer);
      stdoutBuffer = "";
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = nextStderrTail(stderrTail, chunk);
  });

  child.once("error", (error) => {
    closed = true;
    rejectAllPending(error instanceof Error ? error : new Error(String(error)));
  });

  child.once("exit", (code, signal) => {
    closed = true;
    rejectAllPending(describePiExit(invocation.command, code, signal, stderrTail));
  });

  const request = async <TData = unknown>(
    command: PiRpcRequestCommand,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<PiRpcResponse<TData>> => {
    if (closed || child.exitCode !== null) {
      throw describePiExit(invocation.command, child.exitCode, null, stderrTail);
    }

    const id = `pi-${randomUUID()}`;
    const response = await new Promise<PiRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC response to '${command.type}'.`));
      }, timeoutMs);

      pending.set(id, {
        timeout,
        resolve,
        reject,
      });

      void writeJsonLine(child, { ...command, id }).catch((error) => {
        const entry = pending.get(id);
        if (!entry) {
          return;
        }
        pending.delete(id);
        clearTimeout(entry.timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    return response as PiRpcResponse<TData>;
  };

  const write = (command: PiRpcCommand) => writeJsonLine(child, command);

  const subscribe = (listener: (message: PiRpcStdoutMessage) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const stop = async () => {
    if (exitPromise) {
      return exitPromise;
    }

    exitPromise = new Promise<void>((resolve) => {
      if (closed || child.exitCode !== null) {
        resolve();
        return;
      }

      const finish = () => {
        resolve();
      };

      child.once("exit", finish);
      child.kill("SIGTERM");

      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1_000);
    });

    return exitPromise;
  };

  return Promise.resolve({
    child,
    command: invocation.command,
    args: invocation.args,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stderrTail: () => stderrTail,
    request,
    write,
    subscribe,
    stop,
  });
}
