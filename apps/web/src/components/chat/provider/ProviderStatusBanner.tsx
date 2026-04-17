import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@bigcode/contracts";
import { XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
import { CircleAlertIcon } from "lucide-react";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  const [dismissed, setDismissed] = useState(false);
  const prevKeyRef = useRef<string | null>(null);

  // Re-show banner when the provider or its message changes
  const key = status ? `${status.provider}:${status.status}:${status.message ?? ""}` : null;
  useEffect(() => {
    if (key && key !== prevKeyRef.current) {
      setDismissed(false);
      prevKeyRef.current = key;
    }
  }, [key]);

  if (!status || status.status === "ready" || status.status === "disabled" || dismissed) {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle className="flex items-center justify-between gap-2">
          {title}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setDismissed(true)}
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current transition-opacity"
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertTitle>
        <AlertDescription className="line-clamp-3" title={status.message ?? defaultMessage}>
          {status.message ?? defaultMessage}
        </AlertDescription>
      </Alert>
    </div>
  );
});
