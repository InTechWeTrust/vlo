import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './fixtures';

/**
 * Export parity (docs/pip-render-plan.md).
 *
 * `project_mask_grade` carries generated and SAM2 mattes, a painted brush
 * mask, shape masks with an effect mask, keyframed motion, a LUT grade and
 * adjustment layers. Every host that renders a whole-project export is held to
 * one set of expectations, so a feature that renders differently away from the
 * editor fails that host. Today only the editor's own export runs here; the
 * separate render window joins in phase 5.
 */

interface Sample {
    name: string;
    frame: number;
    rect: [number, number, number, number];
    rgb: [number, number, number];
    tolerance: number;
}

interface Expectations {
    frames: number;
    width: number;
    height: number;
    samples: Sample[];
}

interface ProbeResult {
    frames: number;
    width: number;
    height: number;
    colours: [number, number, number][];
}

const expectations: Expectations = JSON.parse(
    readFileSync(
        resolve(process.cwd(), '../shared/fixtures/export-parity/mask-grade-expectations.json'),
        'utf8',
    ),
);

test('the editor exports masks, LUT grades and adjustment layers as expected', async ({
    editorWithMaskGrade,
}) => {
    test.setTimeout(180000);
    const page = editorWithMaskGrade.page;
    await expect
        .poll(() => page.evaluate(() => typeof window.__vloE2E?.runProjectExportPixelProbe), {
            message: 'pixel probe missing — build/serve without VITE_E2E_DIAGNOSTICS?',
        })
        .toBe('function');

    const result = (await page.evaluate(
        (samples) => window.__vloE2E!.runProjectExportPixelProbe!({ samples }),
        expectations.samples.map(({ frame, rect }) => ({ frame, rect })),
    )) as ProbeResult;

    expect(result.frames).toBe(expectations.frames);
    expect([result.width, result.height]).toEqual([expectations.width, expectations.height]);
    const failures = expectations.samples.flatMap((sample, index) => {
        const colour = result.colours[index];
        const off = colour.some((channel, c) => Math.abs(channel - sample.rgb[c]) > sample.tolerance);
        return off ? [`${sample.name}: got ${colour.map(Math.round)}, expected ${sample.rgb} ±${sample.tolerance}`] : [];
    });
    expect(failures).toEqual([]);
});
