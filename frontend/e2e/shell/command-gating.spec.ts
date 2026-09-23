import { test, expect } from '../fixtures';

/**
 * Phase 3.2 of docs/e2e-coverage-plan.md — the half of command coverage that
 * dispatch tests miss.
 *
 * Two distinct mechanisms are at work and it is worth keeping them apart:
 *
 * - `AppMenu` renders a command item **disabled** when its `when` clause fails
 *   (`hostCommandTable.isEnabled`, AppMenu.tsx:133).
 * - The clip context menu gates by **presence**: `canExtractAudio` and
 *   `canReverseClip` decide whether the descriptor is emitted at all.
 *
 * These specs cover the presence form, which is what the clip menu actually
 * uses, plus the clip mute toggle projecting live state. Mute moved out of the
 * menu into a clip overlay badge, which is now where its label is live.
 */
test.describe('Shell command gating', () => {
    test('@smoke clip capabilities decide which commands the menu offers', async ({
        editorCurrent,
    }) => {
        const { shell, timeline, page } = editorCurrent;

        // Clip 1 is a video whose asset carries audio.
        await shell.openContextMenu(timeline.clips.nth(1));
        await expect(shell.getItem('Extract Audio')).toBeVisible();
        await expect(shell.getItem('Reverse Clip')).toBeVisible();
        await shell.closeWithEscape();

        // Clip 0 is a video with no audio track: extraction is not offered.
        await shell.openContextMenu(timeline.clips.nth(0));
        await expect(shell.getItem('Extract Audio')).toHaveCount(0);
        await expect(shell.getItem('Reverse Clip')).toBeVisible();
        await shell.closeWithEscape();

        // Clip 2 is an image: neither audio extraction nor reversal applies,
        // while clip-generic commands stay available.
        await shell.openContextMenu(timeline.clips.nth(2));
        await expect(shell.getItem('Extract Audio')).toHaveCount(0);
        await expect(shell.getItem('Reverse Clip')).toHaveCount(0);
        await expect(shell.getItem('Delete')).toBeVisible();

        await page.keyboard.press('Escape');
    });

    test('clip mute toggle projects live mute state', async ({
        editorWithClips,
    }) => {
        const { timeline } = editorWithClips;
        const muteToggle = timeline.clips
            .first()
            .locator('[data-overlay-item-id="clip-mute-toggle"]');

        await expect(muteToggle.getByTitle('Mute', { exact: true })).toBeVisible();
        await muteToggle.click();

        // The badge must reflect the new clip state, not a stale item.
        await expect(muteToggle.getByTitle('Unmute', { exact: true })).toBeVisible();
        await expect(muteToggle.getByTitle('Mute', { exact: true })).toHaveCount(0);
    });
});
