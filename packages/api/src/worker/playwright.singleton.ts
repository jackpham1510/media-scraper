import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';

let browserInstance: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

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
 */
export async function getBrowser(): Promise<Browser> {
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
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance !== null) {
    try {
      await browserInstance.close();
    } catch {
      // Ignore errors on shutdown
    }
    browserInstance = null;
    launchPromise = null;
  }
}
