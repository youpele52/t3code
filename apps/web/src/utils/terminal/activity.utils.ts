import type { TerminalEvent } from "@bigcode/contracts";

export function terminalRunningSubprocessFromEvent(event: TerminalEvent): boolean | null {
  switch (event.type) {
    case "activity":
      return event.hasRunningSubprocess;
    case "started":
    case "restarted":
    case "exited":
      return false;
    default:
      return null;
  }
}
