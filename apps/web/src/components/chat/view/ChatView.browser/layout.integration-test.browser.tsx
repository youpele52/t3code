import { describe, expect, it, vi } from "vitest";

import { createChatViewBrowserTestContext } from "./context";
import { COMPACT_FOOTER_VIEWPORT, WIDE_FOOTER_VIEWPORT } from "./fixtures";
import {
  expectComposerActionsContained,
  findComposerProviderModelPicker,
  waitForButtonByText,
  waitForButtonContainingText,
  waitForElement,
} from "./dom";
import {
  createSnapshotWithPendingUserInput,
  createSnapshotWithPlanFollowUpPrompt,
} from "./scenarioFixtures";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

describe("ChatView footer layout integration", () => {
  it("keeps pending-question footer actions inside the composer after a real resize", async () => {
    const mounted = await ctx.mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();
      await waitForButtonByText("Previous");
      await waitForButtonByText("Submit answers");
      await mounted.setContainerSize(COMPACT_FOOTER_VIEWPORT);
      await expectComposerActionsContained();
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps plan follow-up footer actions fused and aligned after a real resize", async () => {
    const mounted = await ctx.mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
    });

    try {
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      const initialModelPicker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider model picker.",
      );
      const initialModelPickerOffset =
        initialModelPicker.getBoundingClientRect().left - footer.getBoundingClientRect().left;

      await waitForButtonByText("Implement");
      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await mounted.setContainerSize({ width: 440, height: WIDE_FOOTER_VIEWPORT.height });
      await expectComposerActionsContained();

      const implementButton = await waitForButtonByText("Implement");
      const implementActionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await vi.waitFor(() => {
        const implementRect = implementButton.getBoundingClientRect();
        const implementActionsRect = implementActionsButton.getBoundingClientRect();
        const compactModelPicker = findComposerProviderModelPicker();
        expect(compactModelPicker).toBeTruthy();

        const compactModelPickerOffset =
          compactModelPicker!.getBoundingClientRect().left - footer.getBoundingClientRect().left;

        expect(Math.abs(implementRect.right - implementActionsRect.left)).toBeLessThanOrEqual(1);
        expect(Math.abs(implementRect.top - implementActionsRect.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(compactModelPickerOffset - initialModelPickerOffset)).toBeLessThanOrEqual(
          1,
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
