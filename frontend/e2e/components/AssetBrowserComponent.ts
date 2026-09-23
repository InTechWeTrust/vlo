import { Page, Locator } from '@playwright/test';

type AssetTab = 'video' | 'image' | 'audio';

/**
 * Component Object Model for the Asset Browser (left sidebar).
 * Wraps: AssetBrowser.tsx + AssetCard.tsx
 */
export class AssetBrowserComponent {
    readonly page: Page;
    readonly root: Locator;

    constructor(page: Page) {
        this.page = page;
        this.root = page.getByTestId('asset-browser');
    }

    get assetCards() {
        return this.page.getByTestId('asset-card');
    }

    get sortButton() {
        return this.root.getByRole('button', { name: 'Sort Assets' });
    }

    get uploadButton() {
        return this.root.getByRole('button', { name: 'Import Asset' });
    }

    get fileInput() {
        return this.page.getByTestId('hidden-file-input');
    }

    /**
     * Switch to a tab by aria-label: "Videos", "Images", or "Audio".
     */
    async switchTab(type: AssetTab) {
        const labelMap: Record<AssetTab, string> = {
            video: 'Videos',
            image: 'Images',
            audio: 'Audio',
        };
        await this.root.getByRole('tab', { name: labelMap[type] }).click();
    }

    async getAssetByName(name: string): Promise<Locator> {
        return this.assetCards.filter({ hasText: name }).first();
    }

    async getVisibleCardCount(): Promise<number> {
        return this.assetCards.count();
    }

    async sortBy(option: 'Newest First' | 'Oldest First' | 'Name (A-Z)') {
        await this.sortButton.click();
        await this.page.getByRole('menuitem', { name: option }).click();
    }

    /**
     * Asset card name labels, in display order. Assert on this with
     * `toHaveText([...])` so the check retries until the cards have rendered.
     */
    get cardNames() {
        return this.root.getByTestId('asset-card-name');
    }
}
