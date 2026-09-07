import { expect, test } from './fixtures';

interface PlaybackMetrics {
    frameRequests: number;
    seeks: number;
}

/** The 12s fixture video — see the note at the click below. */
const LONG_VIDEO_NAME = 'hf_20260122_232943_45d72e1c-68cb-41b8-bdac-e275e5c91de8.mp4';
/** Fails loudly if the pinned fixture is ever swapped for a shorter one. */
const MIN_PLAYBACK_BUDGET_SECONDS = 6;
/** Enough progress to prove the browser is driving the clock, not the editor. */
const ADVANCE_SECONDS = 0.3;

declare global {
    var miniEditorPlaybackMetrics: PlaybackMetrics;
}

test('mini editor native viewing and fullscreen do not schedule editor frames or seek playback', async ({ editorCurrent }) => {
    const { page } = editorCurrent;
    await page.evaluate(() => {
        globalThis.miniEditorPlaybackMetrics = { frameRequests: 0, seeks: 0 };
        const isPreview = (media: HTMLMediaElement) =>
            media.closest('[data-testid="mini-editor-preview"]') !== null;
        const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
        HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
            if (isPreview(this)) globalThis.miniEditorPlaybackMetrics.frameRequests++;
            return requestFrame.call(this, callback);
        };
        const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        if (!currentTime?.set || !currentTime.get) throw new Error('Missing media time accessor');
        const setTime = currentTime.set;
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
            ...currentTime,
            set(value: number) {
                if (isPreview(this)) globalThis.miniEditorPlaybackMetrics.seeks++;
                setTime.call(this, value);
            },
        });
    });

    // Proving the editor stays out of the way takes real playback on both
    // sides of the fullscreen transition, and the spec may not seek to buy
    // itself room — a seek is one of the things it asserts never happens. So
    // it pins the longest fixture video by name: on a short one, playback ends
    // mid-test and the polls below wait on a clock that has already stopped.
    const card = await editorCurrent.assetBrowser.getAssetByName(LONG_VIDEO_NAME);
    await card.getByRole('button', { name: 'Preview video', exact: true }).click();
    const video = page.locator('[data-testid="mini-editor-preview"] video');
    await expect(video).toBeVisible();
    await expect(page.getByTestId('mini-editor-controls')).toHaveCount(0);
    await expect
        .poll(() => video.evaluate((media: HTMLVideoElement) => media.duration))
        .toBeGreaterThan(MIN_PLAYBACK_BUDGET_SECONDS);

    await video.evaluate((media: HTMLVideoElement) => media.play());
    await expect.poll(() => video.evaluate((media: HTMLVideoElement) => media.currentTime)).toBeGreaterThan(ADVANCE_SECONDS);
    expect(await page.evaluate(() => globalThis.miniEditorPlaybackMetrics)).toEqual({ frameRequests: 0, seeks: 0 });

    await video.evaluate((media: HTMLVideoElement) => media.requestFullscreen());
    await expect.poll(() => video.evaluate((media) => document.fullscreenElement === media)).toBe(true);
    const enteredAt = await video.evaluate((media: HTMLVideoElement) => media.currentTime);
    await expect
        .poll(() => video.evaluate((media: HTMLVideoElement) => media.currentTime))
        .toBeGreaterThan(enteredAt + ADVANCE_SECONDS);
    await video.evaluate((media: HTMLVideoElement) => media.pause());
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    expect(await page.evaluate(() => globalThis.miniEditorPlaybackMetrics)).toEqual({ frameRequests: 0, seeks: 0 });
});
