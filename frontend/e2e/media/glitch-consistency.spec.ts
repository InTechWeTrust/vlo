import { expect, test } from './fixtures';

/**
 * Glitch preview/extraction consistency canary
 * (docs/glitch-render-consistency-plan.md).
 *
 * The probe renders a coordinate-encoded image through the production filter
 * applicator in real WebGL and compares, in clip coordinates, which source
 * pixel every output pixel sampled. Glitch bands and displacement must not
 * move with viewport zoom, pan, render-target resolution or the device texture
 * limit. A raw upstream filter is the control: it must still fail, or the
 * probe has stopped measuring anything.
 */

/**
 * Band edges quantise to different output rows at different zooms; a few
 * percent of edge cells may differ. A moved or rescaled band layout differs
 * almost everywhere.
 */
const MAX_RUNTIME_MISMATCH_RATIO = 0.05;
const MIN_CONTROL_MISMATCH_RATIO = 0.5;

interface GlitchConsistencyComparison {
    clip: string;
    view: string;
    implementation: 'runtime' | 'upstream-control';
    sharedCells: number;
    mismatchRatio: number;
}

interface GlitchConsistencyProbeResult {
    maxTextureSize: number;
    independentInstancesIdentical: boolean;
    comparisons: GlitchConsistencyComparison[];
}

test.describe('glitch render consistency', () => {
    test('keeps bands in clip coordinates across zoom, pan, resolution and texture limits', async ({
        editorCurrent,
    }, testInfo) => {
        test.setTimeout(180_000);
        const page = editorCurrent.page;

        await expect
            .poll(() =>
                page.evaluate(
                    () => typeof window.__vloE2E?.runGlitchConsistencyProbe,
                ),
            )
            .toBe('function');

        const outcome = await page.evaluate(async () => {
            try {
                const result =
                    await window.__vloE2E?.runGlitchConsistencyProbe?.();
                return { ok: true as const, result };
            } catch (error) {
                return { ok: false as const, error: String(error) };
            }
        });
        if (!outcome.ok) throw new Error(outcome.error);
        const result = outcome.result as GlitchConsistencyProbeResult;
        await testInfo.attach('glitch-consistency-summary.json', {
            body: JSON.stringify(result, null, 2),
            contentType: 'application/json',
        });

        expect(result.independentInstancesIdentical).toBe(true);

        for (const comparison of result.comparisons) {
            const label = `${comparison.implementation} ${comparison.clip} @ ${comparison.view}`;
            if (comparison.implementation === 'runtime') {
                // Zero shared cells means the clip rendered blank.
                expect(comparison.sharedCells, label).toBeGreaterThan(0);
                expect(comparison.mismatchRatio, label).toBeLessThanOrEqual(
                    MAX_RUNTIME_MISMATCH_RATIO,
                );
            }
        }

        const controlMismatches = result.comparisons.filter(
            (comparison) =>
                comparison.implementation === 'upstream-control' &&
                comparison.view !== 'beyond-texture-limit',
        );
        expect(controlMismatches.length).toBeGreaterThan(0);
        for (const comparison of controlMismatches) {
            expect(
                comparison.mismatchRatio,
                `upstream control ${comparison.view} no longer detected`,
            ).toBeGreaterThanOrEqual(MIN_CONTROL_MISMATCH_RATIO);
        }
    });
});
