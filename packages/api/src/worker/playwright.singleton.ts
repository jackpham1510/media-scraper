import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';

let browserInstance: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;
let closing = false;

async function launchBrowser(): Promise<Browser> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
    ],
  });

  browser.on('disconnected', () => {
    // Null out state so getBrowser() relaunches lazily on next request.
    // Do NOT call getBrowser() here — that causes a race condition between
    // the disconnect handler and any concurrent getBrowser() call.
    browserInstance = null;
    launchPromise = null;
  });

  return browser;
}

/**
 * Get the singleton Chromium browser instance, launching it if necessary.
 * On SIGTERM/SIGINT shutdown, call browser.close() — ONLY valid shutdown path.
 * Throws if closeBrowser() has already been called (shutdown in progress).
 */
export async function getBrowser(): Promise<Browser> {
  if (closing) throw new Error('Browser is closing');

  if (browserInstance !== null && browserInstance.isConnected()) {
    return browserInstance;
  }

  if (launchPromise !== null) {
    return launchPromise;
  }

  launchPromise = launchBrowser().then((browser) => {
    browserInstance = browser;
    launchPromise = null;
    return browser;
  });

  return launchPromise;
}

/**
 * Close the Playwright browser instance.
 * Called by main.ts shutdown sequence — NOT via signal handlers here.
 * browser.close() must NEVER be called in the hot path.
 * Sets the closing flag first to prevent new launches during shutdown.
 */
export async function closeBrowser(): Promise<void> {
  closing = true;
  // Wait for any in-flight launch to settle before closing
  if (launchPromise !== null) {
    try {
      await launchPromise;
    } catch {
      // Ignore launch errors during shutdown
    }
  }
  if (browserInstance !== null) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
  launchPromise = null;
}
