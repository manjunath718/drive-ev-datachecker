import { chromium, type Browser, type Page } from "playwright";
import type { SiteConfig, ScrapedData } from "./scraper.js";

// ---------------------------------------------------------------------------
// Singleton browser manager
// ---------------------------------------------------------------------------

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance && browserInstance.isConnected()) {
    await browserInstance.close();
    browserInstance = null;
  }
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

export async function scrapeWithBrowser(
  url: string,
  siteKey: string,
  config: SiteConfig | null,
): Promise<ScrapedData | null> {
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
    });

    const page: Page = await context.newPage();

    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Give dynamic content a moment to render
    await page.waitForTimeout(2000);

    // If we have a config with a title selector, wait briefly for it
    if (config?.selectors?.title) {
      try {
        await page.waitForSelector(config.selectors.title, { timeout: 3000 });
      } catch {
        // Selector didn't appear in time — continue anyway
      }
    }

    // Build the selectors object to pass into page.evaluate()
    const selectors = config?.selectors ?? null;

    const extracted = await page.evaluate(
      (sel: SiteConfig["selectors"] | null) => {
        // --- Structured extraction (only when selectors are available) ---
        let title = "";
        let price = "";
        const specs: Record<string, string> = {};
        const variants: string[] = [];

        if (sel) {
          if (sel.title) {
            title =
              document.querySelector(sel.title)?.textContent?.trim() ?? "";
          }
          if (sel.price) {
            price =
              document.querySelector(sel.price)?.textContent?.trim() ?? "";
          }
          if (sel.specsTable) {
            const rows = document.querySelectorAll(sel.specsTable);
            rows.forEach((row) => {
              const labelSel = sel.specLabel ?? "td:first-child";
              const valueSel = sel.specValue ?? "td:last-child";
              const labelEl = row.querySelector(labelSel);
              const valueEl = row.querySelector(valueSel);
              // Pattern 1: label and value are children of the row
              let label = labelEl?.textContent?.trim() ?? "";
              let value = valueEl?.textContent?.trim() ?? "";
              // Pattern 2 (Tailwind sites): label IS the row itself,
              // and value is the next sibling element
              if (!label && row.matches(labelSel)) {
                label = row.textContent?.trim() ?? "";
                const sibling = row.nextElementSibling;
                if (sibling && sibling.matches(valueSel)) {
                  value = sibling.textContent?.trim() ?? "";
                }
              }
              if (label && value && label !== value) {
                specs[label.toLowerCase().replace(/\s+/g, "_")] = value;
              }
            });
          }
          if (sel.variants) {
            const variantEls = document.querySelectorAll(sel.variants);
            variantEls.forEach((el) => {
              const text = el.textContent?.trim() ?? "";
              if (text) variants.push(text);
            });
          }
        }

        // --- Raw text extraction (always) ---
        const removeTags = ["script", "style", "nav", "footer", "header"];
        for (const tag of removeTags) {
          document.querySelectorAll(tag).forEach((el) => el.remove());
        }
        const rawText = (document.body?.innerText ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 8000);

        return { title, price, specs, variants, rawText };
      },
      selectors,
    );

    await context.close();
    context = null;

    return {
      source: siteKey,
      url,
      data: {
        title: extracted.title,
        price: extracted.price,
        specs: extracted.specs,
        variants: extracted.variants,
      },
      rawText: extracted.rawText,
    };
  } catch (err) {
    console.error(
      `[browser-scraper] Failed to scrape ${url}:`,
      err instanceof Error ? err.message : err,
    );

    if (context) {
      try {
        await context.close();
      } catch {
        // Ignore close errors during cleanup
      }
    }

    return null;
  }
}
