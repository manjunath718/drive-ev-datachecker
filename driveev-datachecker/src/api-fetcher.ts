import type { ScrapedData } from "./scraper.js";

export interface ApiConfig {
  endpoint: string;
  searchPath?: string;
  headers?: Record<string, string>;
  responseMapping: {
    title?: string;
    price?: string;
    specs?: string;
    variants?: string;
  };
}

/**
 * Traverse an object using dot-notation path, with support for array indices.
 * Examples: "data.results[0].price", "meta.title", "items[2].name"
 */
export function getNestedValue(obj: any, path: string): any {
  if (obj == null || !path) return undefined;

  // Split on dots, then handle bracket notation within each segment.
  // e.g. "data.results[0].price" -> ["data", "results[0]", "price"]
  const segments = path.split(".");

  let current: any = obj;

  for (const segment of segments) {
    if (current == null) return undefined;

    // Check for array index notation, e.g. "results[0]"
    const bracketMatch = segment.match(/^([^[]+)\[(\d+)\]$/);

    if (bracketMatch) {
      const key = bracketMatch[1];
      const index = parseInt(bracketMatch[2], 10);
      current = current[key];
      if (current == null || !Array.isArray(current)) return undefined;
      current = current[index];
    } else {
      current = current[segment];
    }
  }

  return current;
}

/**
 * Strategy 1: Fetch EV data directly from an API endpoint.
 *
 * Returns ScrapedData on success, or null on ANY failure so the
 * scraper waterfall can fall through to the next strategy.
 */
export async function fetchFromApi(
  siteKey: string,
  apiConfig: ApiConfig,
  brand: string,
  model: string
): Promise<ScrapedData | null> {
  try {
    // 1. Build the request URL
    let url = apiConfig.endpoint;
    if (apiConfig.searchPath) {
      const populatedPath = apiConfig.searchPath
        .replace("{brand}", encodeURIComponent(brand))
        .replace("{model}", encodeURIComponent(model));
      url = url.replace(/\/+$/, "") + populatedPath;
    }

    // 2. Fetch with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; DriveEV-DataChecker/1.0)",
        ...apiConfig.headers,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(
        `API fetch failed for ${siteKey}: HTTP ${response.status} ${response.statusText}`
      );
      return null;
    }

    // 3. Parse JSON
    const json = await response.json();

    // 4. Extract fields using responseMapping
    const mapping = apiConfig.responseMapping;

    const title = mapping.title
      ? String(getNestedValue(json, mapping.title) ?? "")
      : "";

    const price = mapping.price
      ? String(getNestedValue(json, mapping.price) ?? "")
      : "";

    const specsRaw = mapping.specs
      ? getNestedValue(json, mapping.specs)
      : undefined;
    const specs: Record<string, string> =
      specsRaw && typeof specsRaw === "object" && !Array.isArray(specsRaw)
        ? Object.fromEntries(
            Object.entries(specsRaw).map(([k, v]) => [k, String(v)])
          )
        : {};

    const variantsRaw = mapping.variants
      ? getNestedValue(json, mapping.variants)
      : undefined;
    const variants: string[] = Array.isArray(variantsRaw)
      ? variantsRaw.map(String)
      : [];

    // 5. Check that we got at least some meaningful data
    if (!title && !price && Object.keys(specs).length === 0 && variants.length === 0) {
      console.error(
        `API fetch for ${siteKey}: response parsed but no usable data found`
      );
      return null;
    }

    return {
      source: siteKey,
      url,
      data: { title, price, specs, variants },
      rawText: JSON.stringify(json),
    };
  } catch (err) {
    console.error(
      `API fetch error for ${siteKey}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
