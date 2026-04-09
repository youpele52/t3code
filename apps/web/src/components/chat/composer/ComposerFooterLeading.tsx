import { type ComponentProps, forwardRef } from "react";
import { BotIcon, ListTodoIcon, LockIcon, LockOpenIcon } from "lucide-react";
import {
  type ProviderInteractionMode,
  type RuntimeMode,
  type ProviderKind,
} from "@bigcode/contracts";
import type { ServerProvider } from "@bigcode/contracts";
import { Button } from "../../ui/button";
import { Separator } from "../../ui/separator";
import { cn } from "~/lib/utils";
import { ProviderModelPicker } from "../provider/ProviderModelPicker";
import { CompactComposerControlsMenu } from "../common/CompactComposerControlsMenu";

type ModelOptionsByProvider = ComponentProps<typeof ProviderModelPicker>["modelOptionsByProvider"];
interface ComposerFooterLeadingProps {
  isComposerFooterCompact: boolean;
  selectedProvider: ProviderKind;
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ProviderKind | null;
  providerStatuses: readonly ServerProvider[];
  modelOptionsByProvider: ModelOptionsByProvider;
  composerProviderState: {
    modelPickerIconClassName?: string;
  };
  hasThreadStarted: boolean;
  activePlan: boolean;
  sidebarProposedPlan: boolean;
  planSidebarOpen: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  providerTraitsPicker: React.ReactNode;
  providerTraitsMenuContent: React.ReactNode;
  onProviderModelSelect: (provider: ProviderKind, model: string, subProviderID?: string) => void;
  onProviderUnlock: () => void;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
  onToggleRuntimeMode: () => void;
}

export const ComposerFooterLeading = forwardRef<HTMLDivElement, ComposerFooterLeadingProps>(
  function ComposerFooterLeading(
    {
      isComposerFooterCompact,
      selectedProvider,
      selectedModelForPickerWithCustomFallback,
      lockedProvider,
      providerStatuses,
      modelOptionsByProvider,
      composerProviderState,
      hasThreadStarted,
      activePlan,
      sidebarProposedPlan,
      planSidebarOpen,
      interactionMode,
      runtimeMode,
      providerTraitsPicker,
      providerTraitsMenuContent,
      onProviderModelSelect,
      onProviderUnlock,
      onToggleInteractionMode,
      onTogglePlanSidebar,
      onToggleRuntimeMode,
    }: ComposerFooterLeadingProps,
    ref,
  ) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex min-w-0 flex-1 items-center",
          isComposerFooterCompact
            ? "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            : "gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
        )}
      >
        {/* Provider/model picker */}
        <ProviderModelPicker
          compact={isComposerFooterCompact}
          provider={selectedProvider}
          model={selectedModelForPickerWithCustomFallback}
          lockedProvider={lockedProvider}
          providers={providerStatuses}
          modelOptionsByProvider={modelOptionsByProvider}
          {...(composerProviderState.modelPickerIconClassName
            ? { activeProviderIconClassName: composerProviderState.modelPickerIconClassName }
            : {})}
          onProviderModelChange={onProviderModelSelect}
          {...(hasThreadStarted ? { onProviderUnlock } : {})}
        />

        {isComposerFooterCompact ? (
          <CompactComposerControlsMenu
            activePlan={Boolean(activePlan || sidebarProposedPlan || planSidebarOpen)}
            interactionMode={interactionMode}
            planSidebarOpen={planSidebarOpen}
            runtimeMode={runtimeMode}
            traitsMenuContent={providerTraitsMenuContent}
            onToggleInteractionMode={onToggleInteractionMode}
            onTogglePlanSidebar={onTogglePlanSidebar}
            onToggleRuntimeMode={onToggleRuntimeMode}
          />
        ) : (
          <>
            {providerTraitsPicker ? (
              <>
                <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                {providerTraitsPicker}
              </>
            ) : null}

            <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

            <Button
              variant="ghost"
              className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
              size="sm"
              type="button"
              onClick={onToggleInteractionMode}
              title={
                interactionMode === "plan"
                  ? "Plan mode — click to return to normal build mode"
                  : "Default mode — click to enter plan mode"
              }
            >
              <BotIcon />
              <span className="sr-only sm:not-sr-only">
                {interactionMode === "plan" ? "Plan" : "Build"}
              </span>
            </Button>

            <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

            <Button
              variant="ghost"
              className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
              size="sm"
              type="button"
              onClick={onToggleRuntimeMode}
              title={
                runtimeMode === "full-access"
                  ? "Full access — click to require approvals"
                  : "Approval required — click for full access"
              }
            >
              {runtimeMode === "full-access" ? <LockOpenIcon /> : <LockIcon />}
              <span className="sr-only sm:not-sr-only">
                {runtimeMode === "full-access" ? "Full access" : "Supervised"}
              </span>
            </Button>

            {activePlan || sidebarProposedPlan || planSidebarOpen ? (
              <>
                <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                <Button
                  variant="ghost"
                  className={cn(
                    "shrink-0 whitespace-nowrap px-2 sm:px-3",
                    planSidebarOpen
                      ? "text-info-foreground hover:text-foreground"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  size="sm"
                  type="button"
                  onClick={onTogglePlanSidebar}
                  title={planSidebarOpen ? "Hide plan sidebar" : "Show plan sidebar"}
                >
                  <ListTodoIcon />
                  <span className="sr-only sm:not-sr-only">Plan</span>
                </Button>
              </>
            ) : null}
          </>
        )}
      </div>
    );
  },
);
