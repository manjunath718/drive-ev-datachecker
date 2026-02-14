import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SiteConfig {
  name: string;
  baseUrl: string;
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
}

function loadSiteConfig(siteKey: string): SiteConfig | null {
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

/**
 * Load all site configs from the config/sites/ directory.
 */
function loadAllConfigs(): Record<string, SiteConfig> {
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
      // If URL parsing fails, fall back to string includes
      if (url.includes(key)) return key;
    }
  }
  return null;
}

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
        `Fetch attempt ${attempt + 1}/${retries + 1} failed for ${url}: ${lastError.message}`
      );

      if (attempt < retries) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1))
        );
      }
    }
  }

  throw new Error(
    `Failed to fetch ${url} after ${retries + 1} attempts: ${lastError?.message}`
  );
}

export async function scrapeEvData(
  url: string,
  siteKey?: string
): Promise<ScrapedData> {
  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);

  // Determine site config
  const allConfigs = loadAllConfigs();
  const resolvedKey = siteKey || detectSiteKey(url, allConfigs);
  const config = resolvedKey ? loadSiteConfig(resolvedKey) : null;

  const result: ScrapedData = {
    source: resolvedKey || "unknown",
    url,
    data: { title: "", price: "", specs: {}, variants: [] },
    rawText: "",
  };

  if (config) {
    // Structured extraction using CSS selectors
    if (config.selectors.title) {
      result.data.title = $(config.selectors.title).first().text().trim();
    }
    if (config.selectors.price) {
      result.data.price = $(config.selectors.price).first().text().trim();
    }
    if (config.selectors.specsTable) {
      $(config.selectors.specsTable).each((_, row) => {
        const label = $(row)
          .find(config.selectors.specLabel || "td:first-child")
          .text()
          .trim();
        const value = $(row)
          .find(config.selectors.specValue || "td:last-child")
          .text()
          .trim();
        if (label && value) {
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

  // Always extract raw text as fallback
  $("script, style, nav, footer, header, noscript, iframe").remove();
  result.rawText = $("body")
    .text()
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 8000);

  return result;
}
