import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from './fixtures';
import { installApiMock } from '../mocks/apiMock';
import { installWebSocketMock } from '../mocks/websocketMock';

/**
 * Export parity (docs/pip-render-plan.md).
 *
 * `project_mask_grade` carries generated and SAM2 mattes, a painted brush
 * mask, shape masks with an effect mask, keyframed motion, a LUT grade and
 * adjustment layers. Every host that renders a whole-project export is held to
 * one set of expectations, so a feature that renders differently away from the
 * editor fails that host. The editor's own export runs here, and so does a
 * detached render in a fresh page: the separate render window's code path,
 * minus the window, which phase 5 adds.
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
    audio: { peak: number; tolerance: number };
    samples: Sample[];
}

interface ProbeResult {
    frames: number;
    width: number;
    height: number;
    colours: [number, number, number][];
    audioPeak: number | null;
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

    expectMatchesExpectations(result);
});

test('a fresh realm renders the captured document as the editor does', async ({
    editorWithMaskGrade,
    browser,
}, testInfo) => {
    test.setTimeout(240000);
    const page = editorWithMaskGrade.page;
    await expect
        .poll(() => page.evaluate(() => typeof window.__vloE2E?.captureDetachedRenderProbeInput), {
            message: 'detached render probe missing — build/serve without VITE_E2E_DIAGNOSTICS?',
        })
        .toBe('function');
    const input = await page.evaluate(() => window.__vloE2E!.captureDetachedRenderProbeInput!());

    // No project opened: its own module graph, stores and an empty asset
    // library. Everything the render reads has to come from the document and
    // the files handed over with it. A context of its own, so opening it does
    // not send the editor to the background mid-test.
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    const fresh = await context.newPage();
    try {
        await installWebSocketMock(fresh);
        await installApiMock(fresh);
        await fresh.goto('/');
        await expect
            .poll(() => fresh.evaluate(() => typeof window.__vloE2E?.runDetachedRenderPixelProbe))
            .toBe('function');
        const result = (await fresh.evaluate(
            (request) => window.__vloE2E!.runDetachedRenderPixelProbe!(request as never),
            { input, samples: expectations.samples.map(({ frame, rect }) => ({ frame, rect })) },
        )) as ProbeResult & {
            assetsAfterRender: number;
            capabilities: { ready: boolean; audio: { supported: boolean; encoder: string | null } };
        };

        expectMatchesExpectations(result);
        // Readiness agreed with the encoder: MP4 audio is supported, through
        // the WASM fallback where this browser has no native AAC.
        expect(result.capabilities).toMatchObject({ ready: true, audio: { supported: true } });
        expect(['native', 'wasm']).toContain(result.capabilities.audio.encoder);
        testInfo.annotations.push({ type: 'aac-encoder', description: String(result.capabilities.audio.encoder) });
        // The realm's library is emptied again on the way out.
        expect(result.assetsAfterRender).toBe(0);
    } finally {
        await context.close();
    }
});

function expectMatchesExpectations(result: ProbeResult) {
    expect(result.frames).toBe(expectations.frames);
    expect(result.audioPeak).not.toBeNull();
    expect(Math.abs(result.audioPeak! - expectations.audio.peak)).toBeLessThanOrEqual(expectations.audio.tolerance);
    expect([result.width, result.height]).toEqual([expectations.width, expectations.height]);
    const failures = expectations.samples.flatMap((sample, index) => {
        const colour = result.colours[index];
        const off = colour.some((channel, c) => Math.abs(channel - sample.rgb[c]) > sample.tolerance);
        return off ? [`${sample.name}: got ${colour.map(Math.round)}, expected ${sample.rgb} ±${sample.tolerance}`] : [];
    });
    expect(failures).toEqual([]);
}
