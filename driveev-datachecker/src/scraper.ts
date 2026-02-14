import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { fetchFromApi, type ApiConfig } from "./api-fetcher.js";
import { scrapeWithBrowser, closeBrowser } from "./browser-scraper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface SiteConfig {
  name: string;
  baseUrl: string;
  disabled?: boolean;
  disabledReason?: string;
  preferredStrategy?: "api" | "cheerio" | "playwright";
  apiConfig?: ApiConfig;
  selectors: {
    title?: string;
    price?: string;
    specsTable?: string;
    specLabel?: string;
    specValue?: string;
    variants?: string;
    images?: string;
  };
}

export interface ScrapedData {
  source: string;
  url: string;
  data: {
    title: string;
    price: string;
    specs: Record<string, string>;
    variants: string[];
  };
  rawText: string;
  strategy?: string; // which strategy succeeded
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadSiteConfig(siteKey: string): SiteConfig | null {
  const configPath = path.join(
    __dirname,
    "..",
    "config",
    "sites",
    `${siteKey}.json`
  );
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.error(`Failed to parse site config "${siteKey}":`, err);
    return null;
  }
}

export function loadAllConfigs(): Record<string, SiteConfig> {
  const configDir = path.join(__dirname, "..", "config", "sites");
  const configs: Record<string, SiteConfig> = {};

  if (!fs.existsSync(configDir)) {
    console.error(`Site config directory not found: ${configDir}`);
    return configs;
  }

  const files = fs.readdirSync(configDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const key = path.basename(file, ".json");
    try {
      const content = fs.readFileSync(path.join(configDir, file), "utf-8");
      configs[key] = JSON.parse(content);
    } catch (err) {
      console.error(`Failed to parse site config "${file}":`, err);
    }
  }

  return configs;
}

function detectSiteKey(
  url: string,
  configs: Record<string, SiteConfig>
): string | null {
  for (const [key, config] of Object.entries(configs)) {
    try {
      const configHost = new URL(config.baseUrl).hostname;
      const urlHost = new URL(url).hostname;
      if (urlHost === configHost || urlHost.endsWith("." + configHost)) {
        return key;
      }
    } catch {
      if (url.includes(key)) return key;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 2: Cheerio (static HTML)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

async function fetchWithRetry(
  url: string,
  retries: number = MAX_RETRIES
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        DEFAULT_TIMEOUT_MS
      );

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; DriveEV-DataChecker/1.0; +https://driveev.com)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText} for ${url}`
        );
      }

      return await response.text();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[cheerio] Fetch attempt ${attempt + 1}/${retries + 1} failed for ${url}: ${lastError.message}`
      );

      if (attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1))
        );
      }
    }
  }

  return ""; // Return empty string instead of throwing — let waterfall continue
}

async function scrapeWithCheerio(
  url: string,
  siteKey: string,
  config: SiteConfig | null
): Promise<ScrapedData | null> {
  try {
    const html = await fetchWithRetry(url);

    if (!html) {
      console.error(`[cheerio] Empty response for ${url}`);
      return null;
    }

    const $ = cheerio.load(html);

    const result: ScrapedData = {
      source: siteKey,
      url,
      data: { title: "", price: "", specs: {}, variants: [] },
      rawText: "",
      strategy: "cheerio",
    };

    if (config) {
      if (config.selectors.title) {
        result.data.title = $(config.selectors.title).first().text().trim();
      }
      if (config.selectors.price) {
        result.data.price = $(config.selectors.price).first().text().trim();
      }
      if (config.selectors.specsTable) {
        $(config.selectors.specsTable).each((_, row) => {
          const labelSel = config.selectors.specLabel || "td:first-child";
          const valueSel = config.selectors.specValue || "td:last-child";
          let label = $(row).find(labelSel).first().text().trim();
          let value = $(row).find(valueSel).first().text().trim();
          // Pattern 2 (Tailwind sites): row IS the label, value is next sibling
          if (!label && $(row).is(labelSel)) {
            label = $(row).text().trim();
            const sibling = $(row).next(valueSel);
            if (sibling.length) {
              value = sibling.text().trim();
            }
          }
          if (label && value && label !== value) {
            result.data.specs[label.toLowerCase().replace(/\s+/g, "_")] = value;
          }
        });
      }
      if (config.selectors.variants) {
        $(config.selectors.variants).each((_, el) => {
          const variant = $(el).text().trim();
          if (variant) result.data.variants.push(variant);
        });
      }
    }

    // Raw text fallback
    $("script, style, nav, footer, header, noscript, iframe").remove();
    result.rawText = $("body")
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 8000);

    // If we got no structured data and barely any raw text, consider it a failure
    const hasData =
      result.data.title ||
      result.data.price ||
      Object.keys(result.data.specs).length > 0 ||
      result.rawText.length > 100;

    if (!hasData) {
      console.error(`[cheerio] No meaningful data extracted from ${url}`);
      return null;
    }

    return result;
  } catch (err) {
    console.error(
      `[cheerio] Error scraping ${url}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Waterfall orchestrator
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of strategies to try based on site config.
 * The preferred strategy goes first, then the others in default order.
 */
function getStrategyOrder(
  config: SiteConfig | null
): Array<"api" | "cheerio" | "playwright"> {
  const defaultOrder: Array<"api" | "cheerio" | "playwright"> = [
    "api",
    "cheerio",
    "playwright",
  ];

  const preferred = config?.preferredStrategy;
  if (!preferred) return defaultOrder;

  // Put preferred first, then the rest in default order
  return [preferred, ...defaultOrder.filter((s) => s !== preferred)];
}

/**
 * Main entry point: scrape EV data using a 3-strategy waterfall.
 *
 *   1. API (fastest)  → if fails →
 *   2. Cheerio (fast) → if fails →
 *   3. Playwright (heavy, most reliable)
 *
 * The preferred strategy from the site config determines the order.
 * Returns the first successful result. Raw text fallback is always included.
 */
export async function scrapeEvData(
  url: string,
  siteKey?: string,
  brand?: string,
  model?: string
): Promise<ScrapedData> {
  const allConfigs = loadAllConfigs();
  const resolvedKey = siteKey || detectSiteKey(url, allConfigs) || "unknown";
  const config = resolvedKey !== "unknown" ? loadSiteConfig(resolvedKey) : null;

  // Skip disabled sites
  if (config?.disabled) {
    console.error(
      `[scraper] Skipping disabled site: ${resolvedKey} (${config.disabledReason || "no reason given"})`
    );
    return {
      source: resolvedKey,
      url,
      data: { title: "", price: "", specs: {}, variants: [] },
      rawText: "",
      strategy: "skipped-disabled",
    };
  }

  const strategies = getStrategyOrder(config);

  console.error(
    `[scraper] Scraping ${url} (site: ${resolvedKey}, strategy order: ${strategies.join(" → ")})`
  );

  for (const strategy of strategies) {
    console.error(`[scraper] Trying strategy: ${strategy}`);

    let result: ScrapedData | null = null;

    switch (strategy) {
      case "api":
        if (config?.apiConfig && brand && model) {
          result = await fetchFromApi(
            resolvedKey,
            config.apiConfig,
            brand,
            model
          );
          if (result) result.strategy = "api";
        } else {
          console.error(
            `[scraper] Skipping API strategy: ${!config?.apiConfig ? "no apiConfig" : "no brand/model provided"}`
          );
        }
        break;

      case "cheerio":
        result = await scrapeWithCheerio(url, resolvedKey, config);
        break;

      case "playwright":
        result = await scrapeWithBrowser(url, resolvedKey, config);
        if (result) result.strategy = "playwright";
        break;
    }

    if (result) {
      console.error(
        `[scraper] Success with strategy: ${strategy} for ${url}`
      );
      return result;
    }

    console.error(`[scraper] Strategy ${strategy} failed, trying next...`);
  }

  // All strategies failed — return minimal result with whatever we have
  console.error(`[scraper] All strategies failed for ${url}`);
  return {
    source: resolvedKey,
    url,
    data: { title: "", price: "", specs: {}, variants: [] },
    rawText: "",
    strategy: "none",
  };
}

// Re-export closeBrowser for shutdown
export { closeBrowser } from "./browser-scraper.js";
