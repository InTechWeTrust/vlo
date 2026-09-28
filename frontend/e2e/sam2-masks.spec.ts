import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { installApiMock } from './mocks/apiMock';
import { installWebSocketMock } from './mocks/websocketMock';
import { EditorComponent } from './components';

async function setupSam2Editor(page: Page, options: Parameters<typeof installApiMock>[1] = {}) {
    await installWebSocketMock(page);
    await installApiMock(page, options);

    const editor = new EditorComponent(page);
    await editor.setup('project_v2_with_clips');
    await editor.timeline.clickClip(0);
    await editor.rightSidebar.switchToTab('Mask');

    return editor;
}

async function waitForSam2Preview(page: Page) {
    await expect
        .poll(() =>
            page.evaluate(
                () => window.__vloE2E?.getSam2PreviewDiagnostics().hasLivePreview ?? false,
            ),
        )
        .toBe(true);
}

// With the SAM2 editor in add-point mode, a click on the stage places a point
// on the current frame, the same way a user adds one.
async function addSam2PointAtCanvasCenter(editor: EditorComponent) {
    const box = await editor.player.canvasContainer.boundingBox();
    if (!box) {
        throw new Error('Player canvas has no layout box');
    }
    await editor.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe('SAM2 Mask Flow', () => {
    test('SAM2 mask option available when SAM2 healthy', async ({ page }) => {
        const editor = await setupSam2Editor(page, {
            runtimeStatus: {
                sam2: { status: 'available', error: null },
            },
            sam2Health: { status: 'ok' },
        });

        await editor.maskPanel.addMaskChip.click();

        const sam2Option = page.getByRole('menuitem', { name: 'Sam2' });
        await expect(sam2Option).toBeVisible();
    });

    test('SAM2 panel shows point tools', async ({ page }) => {
        const editor = await setupSam2Editor(page, {
            runtimeStatus: {
                sam2: { status: 'available', error: null },
            },
            sam2Health: { status: 'ok' },
        });

        await editor.maskPanel.addMask('Sam2');

        await expect(editor.maskPanel.sam2Panel).toBeVisible();
        await expect(editor.maskPanel.sam2AddPointButton).toBeVisible();
        await expect(editor.maskPanel.sam2RemovePointButton).toBeVisible();
        await expect(editor.maskPanel.sam2GenerateButton).toBeVisible();
    });

    test('Generate mask frame preview', async ({ page }) => {
        const editor = await setupSam2Editor(page, {
            runtimeStatus: {
                sam2: { status: 'available', error: null },
            },
            sam2Health: { status: 'ok' },
        });

        await editor.maskPanel.addMask('Sam2');
        await editor.maskPanel.sam2AddPointButton.click();

        await addSam2PointAtCanvasCenter(editor);
        await expect(editor.maskPanel.panel.getByText(/Current frame: 1 point/)).toBeVisible();

        await editor.maskPanel.sam2PreviewButton.click();
        await waitForSam2Preview(page);
    });

    test('SAM2 unavailable shows disabled state', async ({ page }) => {
        const editor = await setupSam2Editor(page, {
            runtimeStatus: {
                sam2: { status: 'unavailable', error: 'SAM2 offline for test' },
            },
            sam2Health: { status: 'error' },
        });

        await editor.maskPanel.addMaskChip.click();

        const sam2Option = page.getByRole('menuitem', { name: 'Sam2' });
        await expect(sam2Option).toBeVisible();
        await expect(sam2Option).toBeEnabled();

        await sam2Option.click();

        await expect(editor.maskPanel.sam2Panel).toBeVisible();
        await expect(editor.maskPanel.panel.getByText('SAM2 offline for test').first()).toBeVisible();
        await expect(editor.maskPanel.sam2PreviewButton).toBeDisabled();
        await expect(editor.maskPanel.sam2GenerateButton).toBeDisabled();
    });
});
