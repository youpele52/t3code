import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { isElectron } from "../config/env";
import { SidebarTrigger } from "../components/ui/sidebar";
import { useStore } from "../stores/main";
import { randomSpinnerVerb } from "../utils/copy/copy.utils";

function ChatIndexRouteView() {
  const bootstrapComplete = useStore((store) => store.bootstrapComplete);
  const [loadingVerb] = useState(() => randomSpinnerVerb());

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
          <span className="text-xs text-muted-foreground/50">No active thread</span>
        </div>
      )}

      <div className="flex flex-1 items-center justify-center">
        {!bootstrapComplete ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70">
            <span>{loadingVerb}</span>
            <span className="inline-flex items-center gap-[3px]">
              <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30 [animation-delay:200ms]" />
              <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30 [animation-delay:400ms]" />
            </span>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
