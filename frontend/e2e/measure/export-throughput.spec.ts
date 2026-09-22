import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { EditorComponent } from '../components';
import { installApiMock } from '../mocks/apiMock';
import { installWebSocketMock } from '../mocks/websocketMock';

/**
 * Export throughput with the editor visible, hidden and minimised
 * (docs/pip-render-plan.md, phase 1). Not a test: it measures, and fails only
 * when an export does not complete.
 *
 * Each run starts its own Chrome with a fresh profile and drives the real
 * Export dialog, so today's progress-only PiP window opens exactly as it does
 * for a user. The browser is attached over CDP with `noDefaults`, not
 * launched by Playwright: Playwright's launch switches and per-page focus
 * emulation keep background tabs visible and unthrottled, which is the very
 * thing measured here.
 *
 * MEASURE_CHROME picks the browser binary (Playwright's Chromium by default),
 * MEASURE_HEADLESS=1 runs it headless (tab hiding still applies; minimising
 * does not). Whether a minimise actually took effect is recorded, since some
 * window managers (WSLg) ignore it.
 *
 *   npm run measure:export --prefix frontend
 *   MEASURE_PROJECT=/abs/project MEASURE_CONDITIONS=visible,hidden-pip MEASURE_REPEAT=2 ...
 *
 * Conditions:
 * - `visible`: the editor tab stays in front.
 * - `hidden-pip`: another tab is brought to front; the progress PiP opens as usual.
 * - `hidden`: the same, with Document PiP unavailable (the no-PiP control).
 * - `minimized`: the window is minimised; the progress PiP opens as usual.
 *
 * Results: one JSON line per run in test-results/export-measure.jsonl, and a
 * table printed at the end.
 */

const CONDITIONS = ['visible', 'hidden-pip', 'hidden', 'minimized'] as const;
type Condition = (typeof CONDITIONS)[number];

const PROJECT = process.env.MEASURE_PROJECT ?? 'project_mask_grade';
const REPEAT = Number(process.env.MEASURE_REPEAT ?? 1);
const SELECTED = (process.env.MEASURE_CONDITIONS?.split(',') ?? [...CONDITIONS]) as Condition[];
const RESULTS = resolve(process.cwd(), 'test-results/export-measure.jsonl');

interface StateCounters {
    milliseconds: number;
    rafs: number;
    rafMaxWait: number;
    timeouts: number;
    timeoutLateTotal: number;
    timeoutLateMax: number;
}

interface PageCounters {
    /** Per `document.visibilityState`, so hidden stretches are read on their own. */
    byState: Record<string, StateCounters>;
    /** With MEASURE_RAF_CALLERS=1: rAF requests by the first app frame on the stack. */
    rafCallers?: Record<string, number>;
    visibility: [number, string][];
    pipWindows: number;
}

/**
 * rAF callback latency and timer lateness, bucketed by visibility state, and
 * reset when the export starts.
 */
function installCounters({ traceCallers }: { traceCallers: boolean }) {
    const now = () => performance.now();
    const target = window as unknown as {
        __measure: PageCounters & { reset(): void; snapshot(): PageCounters };
    };
    let state = document.visibilityState as string;
    let stateSince = now();
    const bucket = (name: string): StateCounters => {
        const counters = target.__measure.byState;
        return (counters[name] ??= {
            milliseconds: 0, rafs: 0, rafMaxWait: 0, timeouts: 0, timeoutLateTotal: 0, timeoutLateMax: 0,
        });
    };
    const closeState = () => {
        bucket(state).milliseconds += now() - stateSince;
        stateSince = now();
    };
    target.__measure = {
        byState: {},
        visibility: [[now(), state]],
        pipWindows: 0,
        // Keeps the PiP count: the window opens as the export starts, before the reset.
        reset() {
            target.__measure.byState = {};
            target.__measure.rafCallers = {};
            target.__measure.visibility = [[now(), document.visibilityState]];
            state = document.visibilityState;
            stateSince = now();
        },
        snapshot() {
            closeState();
            return JSON.parse(JSON.stringify(target.__measure)) as PageCounters;
        },
    };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
        const requested = now();
        if (traceCallers) {
            const frames = (new Error().stack ?? '').split('\n').slice(2);
            const caller = frames.find((frame) => !frame.includes('installCounters') && /\/src\/|assets\/|node_modules/.test(frame)) ?? frames[0] ?? '?';
            const key = caller.trim().replace(/\?[^:)]*/, '').replace(/^at /, '');
            const callers = (target.__measure.rafCallers ??= {});
            callers[key] = (callers[key] ?? 0) + 1;
        }
        return raf((time) => {
            const counters = bucket(document.visibilityState);
            counters.rafs += 1;
            counters.rafMaxWait = Math.max(counters.rafMaxWait, now() - requested);
            callback(time);
        });
    };
    const setTimeoutOriginal = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
        if (typeof handler !== 'function') return setTimeoutOriginal(handler, delay, ...args);
        const due = now() + (delay ?? 0);
        return setTimeoutOriginal((...callArgs: unknown[]) => {
            const late = Math.max(0, now() - due);
            const counters = bucket(document.visibilityState);
            counters.timeouts += 1;
            counters.timeoutLateTotal += late;
            counters.timeoutLateMax = Math.max(counters.timeoutLateMax, late);
            (handler as (...a: unknown[]) => void)(...callArgs);
        }, delay, ...args);
    }) as typeof window.setTimeout;
    document.addEventListener('visibilitychange', () => {
        closeState();
        state = document.visibilityState;
        target.__measure.visibility.push([now(), state]);
    });
    const dpip = (window as unknown as { documentPictureInPicture?: EventTarget })
        .documentPictureInPicture;
    dpip?.addEventListener('enter', () => { target.__measure.pipWindows += 1; });
}

function disableDocumentPip() {
    Object.defineProperty(window, 'documentPictureInPicture', { value: undefined, configurable: true });
}

interface RunSummary { kind: string; status: string; startedAt: number; endedAt: number | null; error: string | null }

async function latestRun(page: Page): Promise<RunSummary | null> {
    return (await page.evaluate(() => window.__vloE2E?.getLatestExportRunSummary?.() ?? null)) as RunSummary | null;
}

interface MeasuredChrome { browser: Browser; process: ChildProcess; profile: string }

/** A plain Chrome, attached over CDP without Playwright's page overrides. */
async function launchMeasuredChrome(): Promise<MeasuredChrome> {
    const port = 9300 + Math.floor(Math.random() * 600);
    const profile = mkdtempSync(join(tmpdir(), 'vlo-measure-'));
    const process_ = spawn(process.env.MEASURE_CHROME ?? chromium.executablePath(), [
        `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required', '--window-size=1600,900',
        // WSLg's GPU is blocklisted by default; without WebGL Pixi cannot
        // export. SwiftShader stays allowed as the fallback. The renderer
        // actually used is recorded with each result.
        ...(process.env.MEASURE_GPU_BLOCKLIST === '1' ? [] : ['--ignore-gpu-blocklist']),
        '--enable-unsafe-swiftshader',
        ...(process.env.MEASURE_HEADLESS === '1' ? ['--headless=new'] : []),
        'about:blank',
    ], { stdio: 'ignore' });
    const endpointURL = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 20_000;
    for (;;) {
        try {
            if ((await fetch(`${endpointURL}/json/version`)).ok) break;
        } catch { /* not listening yet */ }
        if (Date.now() > deadline) throw new Error('Chrome never opened its debugging port');
        await new Promise((resolve_) => setTimeout(resolve_, 200));
    }
    const browser = await chromium.connectOverCDP({ endpointURL, noDefaults: true });
    return { browser, process: process_, profile };
}

async function applyCondition(condition: Condition, context: BrowserContext, page: Page): Promise<{
    restore: () => Promise<void>;
    minimizeApplied?: boolean;
}> {
    if (condition === 'hidden' || condition === 'hidden-pip') {
        const cover = await context.newPage();
        await cover.goto('about:blank');
        await cover.bringToFront();
        return { restore: async () => { await page.bringToFront(); } };
    }
    if (condition === 'minimized') {
        const cdp = await context.newCDPSession(page);
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        await new Promise((resolve_) => setTimeout(resolve_, 500));
        const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
        return {
            minimizeApplied: bounds.windowState === 'minimized',
            restore: async () => {
                await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
            },
        };
    }
    return { restore: async () => {} };
}

/** The debug log's final line: frame work vs wall, and each phase's share. */
function parseFinalLine(line: string | undefined) {
    const match = line?.match(/frame work: render ([\d.]+) s, output ([\d.]+) s of ([\d.]+) s wall \| phases: (.*)$/);
    if (!match) return null;
    const phases = Object.fromEntries(match[4].split(', ').map((part) => {
        const [name, value] = part.split(' ');
        return [name, Number(value)];
    }));
    return { renderSeconds: Number(match[1]), outputSeconds: Number(match[2]), wallSeconds: Number(match[3]), phases };
}

for (let repeat = 1; repeat <= REPEAT; repeat += 1) {
    for (const condition of SELECTED) {
        test(`${condition} #${repeat}`, async ({ baseURL }, testInfo) => {
            if (condition === 'minimized' && process.env.MEASURE_HEADLESS === '1') {
                test.skip(true, 'Minimising needs a headed browser.');
            }
            const chrome = await launchMeasuredChrome();
            try {
                const context = chrome.browser.contexts()[0];
                const page = context.pages()[0] ?? await context.newPage();
                // One script with its option as an argument: Playwright does not
                // order separate init scripts.
                await page.addInitScript(installCounters, {
                    traceCallers: process.env.MEASURE_RAF_CALLERS === '1',
                });
                if (condition === 'hidden') await page.addInitScript(disableDocumentPip);
                const debugLines: string[] = [];
                page.on('console', (message) => {
                    if (message.text().startsWith('[Export debug')) debugLines.push(message.text());
                });
                await installWebSocketMock(page);
                await installApiMock(page);
                const editor = new EditorComponent(page);
                // Attached contexts have no Playwright baseURL.
                await editor.setup({ fixtureDir: PROJECT, appURL: new URL('/', baseURL).href });
                await expect.poll(() => page.evaluate(() => typeof window.__vloE2E?.setExportDebugMode), {
                    message: 'measure hooks missing: serve a build with VITE_E2E_DIAGNOSTICS=true',
                }).toBe('function');
                await page.evaluate(() => window.__vloE2E!.setExportDebugMode!(true));

                await page.getByRole('button', { name: 'Extract', exact: true }).click();
                await page.getByRole('button', { name: /Download the full timeline/ }).click();
                await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
                await expect.poll(async () => (await latestRun(page))?.status, { timeout: 30_000 }).toBe('running');
                await page.evaluate(() => (window as unknown as { __measure: { reset(): void } }).__measure.reset());
                const { restore, minimizeApplied } = await applyCondition(condition, context, page);
                let run: RunSummary | null = null;
                let counters: PageCounters;
                let pipSupported = false;
                let pipOpen = false;
                try {
                    // Whether today's progress window is actually open while the export runs.
                    pipSupported = await page.evaluate(() => Boolean(
                        (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture));
                    pipOpen = pipSupported && await expect.poll(() => page.evaluate(() => Boolean(
                        (window as unknown as { documentPictureInPicture?: { window: Window | null } })
                            .documentPictureInPicture?.window)), { timeout: 5000 }).toBe(true)
                        .then(() => true, () => false);
                    await expect.poll(async () => {
                        run = await latestRun(page);
                        return run?.status;
                    }, { timeout: 55 * 60 * 1000, intervals: [1000] }).not.toBe('running');
                    // Before the condition is lifted, so the hidden stretch ends with the export.
                    counters = (await page.evaluate(() =>
                        (window as unknown as { __measure: { snapshot(): PageCounters } }).__measure.snapshot())) as PageCounters;
                } finally {
                    await restore();
                }
                const final = debugLines.find((line) => line.includes('frame work:'));
                const result = {
                    project: PROJECT, condition, repeat,
                    status: run!.status,
                    error: run!.error,
                    wallSeconds: (run!.endedAt! - run!.startedAt) / 1000,
                    frames: Number(final?.match(/(\d+) frames submitted/)?.[1] ?? NaN),
                    debug: parseFinalLine(final),
                    counters,
                    pipSupported,
                    pipOpen,
                    minimizeApplied,
                    userAgent: await page.evaluate(() => navigator.userAgent),
                    webgl: await page.evaluate(() => {
                        const gl = document.createElement('canvas').getContext('webgl2');
                        const info = gl?.getExtension('WEBGL_debug_renderer_info');
                        return gl ? String(gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)) : null;
                    }),
                    headless: Boolean(testInfo.project.use.headless),
                };
                appendFileSync(RESULTS, `${JSON.stringify(result)}\n`);
                await testInfo.attach('result.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
                await testInfo.attach('export-debug.log', { body: debugLines.join('\n'), contentType: 'text/plain' });
                expect(result.status).toBe('completed');
            } finally {
                // Chrome keeps writing its profile until it has exited. Listen
                // before closing, since it may exit (or crash) during the close.
                const alreadyExited = () => chrome.process.exitCode !== null || chrome.process.signalCode !== null;
                const exited = new Promise((resolve_) => chrome.process.once('exit', resolve_));
                await chrome.browser.close().catch(() => {});
                if (!alreadyExited()) {
                    chrome.process.kill();
                    await Promise.race([exited, new Promise((resolve_) => setTimeout(resolve_, 10_000))]);
                }
                try {
                    rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
                } catch (error) {
                    console.warn(`Could not remove ${chrome.profile}:`, error);
                }
            }
        });
    }
}

test.afterAll(() => {
    if (!existsSync(RESULTS)) return;
    const rows = readFileSync(RESULTS, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const table = rows.map((row) => {
        const hidden = row.counters.byState.hidden;
        return {
            condition: `${row.condition} #${row.repeat}`,
            status: row.status,
            wall: row.wallSeconds.toFixed(1),
            fps: (row.frames / row.wallSeconds).toFixed(1),
            render: row.debug?.renderSeconds?.toFixed(1),
            output: row.debug?.outputSeconds?.toFixed(1),
            idle: row.debug ? (row.debug.wallSeconds - row.debug.renderSeconds - row.debug.outputSeconds).toFixed(1) : '',
            hiddenSec: hidden ? (hidden.milliseconds / 1000).toFixed(1) : '0',
            hiddenRafs: hidden?.rafs ?? '',
            hiddenTimerLateMax: hidden ? hidden.timeoutLateMax.toFixed(0) : '',
            pip: row.pipOpen,
            minimized: row.minimizeApplied ?? '',
        };
    });
    console.log(`\nExport throughput — ${PROJECT}`);
    console.table(table);
});
