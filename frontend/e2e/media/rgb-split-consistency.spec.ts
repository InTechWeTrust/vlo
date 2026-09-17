import { expect, test } from './fixtures';

/**
 * RGB Split preview/extraction consistency canary.
 *
 * The probe renders a coordinate-encoded image through the production filter
 * applicator in real WebGL. Channel offsets must stay fixed in clip pixels
 * across viewport zoom, pan, render-target resolution and the device texture
 * limit, and samples just beyond a viewport edge must not be cropped. A raw
 * upstream filter is the control: it must still fail, or the probe has stopped
 * measuring anything.
 */

/**
 * RGB Split is a pure translation, so a correct render differs only where
 * nearest sampling quantises clip edges differently (under 1% on SwiftShader).
 * A cropped viewport edge affects about 4% of cells in the crossing view, and
 * unscaled offsets affect nearly all of them.
 */
const MAX_RUNTIME_MISMATCH_RATIO = 0.02;
const MIN_CONTROL_MISMATCH_RATIO = 0.5;

interface RgbSplitConsistencyComparison {
    clip: string;
    view: string;
    implementation: 'runtime' | 'upstream-control';
    sharedCells: number;
    mismatchRatio: number;
}

interface RgbSplitConsistencyProbeResult {
    maxTextureSize: number;
    comparisons: RgbSplitConsistencyComparison[];
}

test.describe('rgb split render consistency', () => {
    test('keeps channel offsets in clip pixels across zoom, pan, resolution and texture limits', async ({
        editorCurrent,
    }, testInfo) => {
        test.setTimeout(180_000);
        const page = editorCurrent.page;

        await expect
            .poll(() =>
                page.evaluate(
                    () => typeof window.__vloE2E?.runRgbSplitConsistencyProbe,
                ),
            )
            .toBe('function');

        const outcome = await page.evaluate(async () => {
            try {
                const result =
                    await window.__vloE2E?.runRgbSplitConsistencyProbe?.();
                return { ok: true as const, result };
            } catch (error) {
                return { ok: false as const, error: String(error) };
            }
        });
        if (!outcome.ok) throw new Error(outcome.error);
        const result = outcome.result as RgbSplitConsistencyProbeResult;
        await testInfo.attach('rgb-split-consistency-summary.json', {
            body: JSON.stringify(result, null, 2),
            contentType: 'application/json',
        });

        for (const comparison of result.comparisons) {
            if (comparison.implementation !== 'runtime') continue;
            const label = `${comparison.clip} @ ${comparison.view}`;
            // Zero shared cells means the clip rendered blank.
            expect(comparison.sharedCells, label).toBeGreaterThan(0);
            expect(comparison.mismatchRatio, label).toBeLessThanOrEqual(
                MAX_RUNTIME_MISMATCH_RATIO,
            );
        }

        // Every zoomed control view is off by the unscaled offsets. The
        // resolution-2 view is at zoom 1, where only cropping could differ,
        // and the extreme view is blank rather than wrong.
        const controls = result.comparisons.filter(
            (comparison) =>
                comparison.implementation === 'upstream-control' &&
                !['resolution-2', 'beyond-texture-limit'].includes(
                    comparison.view,
                ),
        );
        expect(controls.length).toBeGreaterThan(0);
        for (const comparison of controls) {
            expect(
                comparison.mismatchRatio,
                `upstream control ${comparison.view} no longer detected`,
            ).toBeGreaterThanOrEqual(MIN_CONTROL_MISMATCH_RATIO);
        }
    });
});
