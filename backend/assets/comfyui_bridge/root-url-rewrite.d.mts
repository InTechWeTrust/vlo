export const ROOT_URL_REWRITE_PREFIX: string;
export const ROOT_URL_REWRITE_DISABLE_KEY: string;

export function rewriteRootUrl(input: unknown, prefix?: string): string | null;

export function installRootUrlRewrite(options?: {
  windowObject?: unknown;
  prefix?: string;
  logger?: { info?: (message: string) => void } | null;
}): { uninstall(): void } | null;
