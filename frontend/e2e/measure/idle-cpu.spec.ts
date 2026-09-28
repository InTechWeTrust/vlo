import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, type CDPSession, type Page } from '@playwright/test';
import { EditorComponent } from '../components';
import { installApiMock } from '../mocks/apiMock';
import { installWebSocketMock } from '../mocks/websocketMock';

/**
 * Idle CPU of an open project: nothing playing, nothing clicked. Not a test:
 * it measures, and writes a `.cpuprofile` (open in DevTools > Performance) plus
 * a self-time summary per frame, so a busy render loop or poller at rest shows
 * up by name.
 *
 *   PLAYWRIGHT_MEASURE_HEADLESS=1 npx playwright test --project=export-measure e2e/measure/idle-cpu.spec.ts
 *
 * IDLE_PROJECT: fixture name or absolute project path (default project_mask_grade).
 * IDLE_SETTLE_MS / IDLE_SAMPLE_MS: wait after open, then profile window.
 * IDLE_LIVE_BACKEND=1: skip the API and websocket mocks, so the real backend
 * and ComfyUI (and its iframe) take part.
 *
 * CDP profiles cover frames only, so on Linux the browser's threads are also
 * timed from /proc: workers, compositor, raster and GPU work show up there.
 */
const PROJECT = process.env.IDLE_PROJECT ?? 'project_mask_grade';
const SETTLE_MS = Number(process.env.IDLE_SETTLE_MS ?? 10_000);
const SAMPLE_MS = Number(process.env.IDLE_SAMPLE_MS ?? 10_000);
const OUT_DIR = resolve('test-results/idle-cpu');

const METRICS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'];

interface ProfileNode {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
}
interface Profile {
    nodes: ProfileNode[];
    samples: number[];
    timeDeltas: number[];
}

function summarize(profile: Profile, top = 30): string[] {
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const selfTime = new Map<string, number>();
    profile.samples.forEach((id, index) => {
        const frame = byId.get(id)!.callFrame;
        const file = frame.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
        const key = `${frame.functionName || '(anon)'}  ${file}:${frame.lineNumber + 1}`;
        selfTime.set(key, (selfTime.get(key) ?? 0) + (profile.timeDeltas[index] ?? 0));
    });
    const total = [...selfTime.values()].reduce((sum, us) => sum + us, 0);
    return [...selfTime.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([key, us]) => `${(us / 1000).toFixed(0).padStart(6)}ms ${((us / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
}

const CLOCK_TICKS_PER_SECOND = 100;

/** CPU ticks per Playwright-browser thread, labelled `<process type>:<thread name>`. */
function browserThreadTicks(): Map<string, { label: string; ticks: number }> {
    const threads = new Map<string, { label: string; ticks: number }>();
    if (process.platform !== 'linux') return threads;
    for (const pid of readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))) {
        try {
            const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/);
            if (!args[0]?.includes('ms-playwright')) continue;
            const type = args.find((arg) => arg.startsWith('--type='))?.slice(7) ?? 'browser';
            const subType = args.find((arg) => arg.startsWith('--utility-sub-type='))?.split('.').pop() ?? '';
            for (const tid of readdirSync(`/proc/${pid}/task`)) {
                const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
                const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
                // Fields after the command name start at field 3 (state).
                const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
                const ticks = Number(fields[11]) + Number(fields[12]);
                threads.set(`${pid}/${tid}`, { label: `${type}${subType ? `(${subType})` : ''}[${pid}]:${name}`, ticks });
            }
        } catch {
            /* process exited mid-scan */
        }
    }
    return threads;
}

function threadReport(before: ReturnType<typeof browserThreadTicks>, after: ReturnType<typeof browserThreadTicks>, ms: number): string[] {
    const byLabel = new Map<string, number>();
    for (const [key, { label, ticks }] of after) {
        const delta = ticks - (before.get(key)?.ticks ?? 0);
        if (delta > 0) byLabel.set(label, (byLabel.get(label) ?? 0) + delta);
    }
    const toCores = (ticks: number) => ticks / CLOCK_TICKS_PER_SECOND / (ms / 1000);
    const total = [...byLabel.values()].reduce((sum, ticks) => sum + ticks, 0);
    return [
        `browser threads total: ${toCores(total).toFixed(2)} cores`,
        ...[...byLabel.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 40)
            .map(([label, ticks]) => `  ${toCores(ticks).toFixed(3).padStart(6)} cores  ${label}`),
    ];
}

async function metrics(session: CDPSession): Promise<Record<string, number>> {
    const { metrics: list } = await session.send('Performance.getMetrics');
    return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

async function frameSessions(page: Page) {
    const sessions: { label: string; session: CDPSession }[] = [
        { label: 'main', session: await page.context().newCDPSession(page) },
    ];
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        // In-process frames share the page's session and reject their own.
        try {
            sessions.push({ label: frame.url().slice(0, 80), session: await page.context().newCDPSession(frame) });
        } catch {
            /* same-process frame */
        }
    }
    return sessions;
}

test.use({
    launchOptions: {
        args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--site-per-process'],
    },
});

test('idle CPU with a project open', async ({ page, baseURL }) => {
    test.setTimeout(SETTLE_MS + SAMPLE_MS + 120_000);
    const editor = new EditorComponent(page);
    if (process.env.IDLE_LIVE_BACKEND !== '1') {
        await installWebSocketMock(page);
        await installApiMock(page);
    }
    await editor.setup({ fixtureDir: PROJECT, appURL: new URL('/', baseURL).href });
    await page.waitForTimeout(SETTLE_MS);

    const sessions = await frameSessions(page);
    for (const { session } of sessions) {
        await session.send('Performance.enable');
        await session.send('Profiler.enable');
        await session.send('Profiler.setSamplingInterval', { interval: 200 });
        await session.send('Profiler.start');
    }
    const before = await Promise.all(sessions.map(({ session }) => metrics(session)));
    const threadsBefore = browserThreadTicks();
    // Counts animation frames the page asks for, by caller: none at true rest.
    const rafCallers = await page.evaluate(
        (ms) =>
            new Promise<[string, number][]>((done) => {
                const original = window.requestAnimationFrame.bind(window);
                const callers = new Map<string, number>();
                window.requestAnimationFrame = (cb) => {
                    const caller = (new Error().stack ?? '').split('\n')[2]?.trim().replace(/\?[^:)]*/, '') ?? '?';
                    callers.set(caller, (callers.get(caller) ?? 0) + 1);
                    return original(cb);
                };
                setTimeout(() => {
                    window.requestAnimationFrame = original;
                    done([...callers.entries()].map(([caller, calls]) => [caller, calls / (ms / 1000)]));
                }, ms);
            }),
        SAMPLE_MS,
    );
    const after = await Promise.all(sessions.map(({ session }) => metrics(session)));
    const threadsAfter = browserThreadTicks();

    mkdirSync(OUT_DIR, { recursive: true });
    const report: string[] = [`project=${PROJECT} settle=${SETTLE_MS}ms sample=${SAMPLE_MS}ms`, 'main-frame rAF calls/s by caller:', ...rafCallers.map(([caller, perSecond]) => `  ${perSecond.toFixed(1).padStart(6)}  ${caller}`), ...threadReport(threadsBefore, threadsAfter, SAMPLE_MS)];
    for (const [index, { label, session }] of sessions.entries()) {
        const { profile } = (await session.send('Profiler.stop')) as { profile: Profile };
        const file = resolve(OUT_DIR, `frame-${index}.cpuprofile`);
        writeFileSync(file, JSON.stringify(profile));
        report.push('', `=== ${label}  (${file})`);
        for (const name of METRICS) {
            const delta = after[index][name] - before[index][name];
            report.push(
                `  ${name.padEnd(20)} ${name.endsWith('Duration') ? `${((delta / (SAMPLE_MS / 1000)) * 100).toFixed(1)}% of a core` : `${delta} in ${SAMPLE_MS / 1000}s`}`,
            );
        }
        report.push(...summarize(profile));
    }
    writeFileSync(resolve(OUT_DIR, 'summary.txt'), report.join('\n'));
    console.log(report.join('\n'));
});
