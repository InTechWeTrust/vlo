import type { Locator, Page } from '@playwright/test';

type LeftSidebarTab = 'Assets' | 'Text' | 'Composite' | 'Effects' | 'Transitions';

// Test IDs derive from the shell view registry: LeftSidebarPanel renders
// `left-sidebar-tab-${view.id}` with the `host.` prefix stripped, so these must
// track the IDs declared in app/layout/leftSidebarHostViews.ts.
const TAB_TEST_IDS: Record<LeftSidebarTab, string> = {
    Assets: 'left-sidebar-tab-assets',
    Text: 'left-sidebar-tab-text',
    Composite: 'left-sidebar-tab-composite',
    Effects: 'left-sidebar-tab-effects-library',
    Transitions: 'left-sidebar-tab-transitions-library',
};

export class LeftSidebarComponent {
    constructor(readonly page: Page) {}

    getTab(name: LeftSidebarTab): Locator {
        return this.page.getByTestId(TAB_TEST_IDS[name]);
    }

    async switchTo(name: LeftSidebarTab) {
        const tab = this.getTab(name);
        await tab.click();
        // The tab's label tooltip opens to the right, over the panel, and is
        // interactive: a pointer moving onto the panel can land on it and hold
        // it open over the controls beneath. Park the pointer at the strip's
        // left edge, off the icon, so the tooltip closes.
        const box = await tab.boundingBox();
        if (box) {
            await this.page.mouse.move(box.x + 1, box.y + box.height / 2);
        }
    }

    get compositePanel() {
        return this.page.getByTestId('composite-panel');
    }

    get compositeCards() {
        return this.page.getByTestId('composite-card');
    }

    get addBlankCompositeButton() {
        return this.page.getByTestId('composite-add-scene');
    }
}
