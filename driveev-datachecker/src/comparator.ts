import type { ExcelEntry } from "./excel-parser.js";

export interface FieldComparison {
  excel: string;
  scraped: Record<string, string>;
  status: "match" | "mismatch" | "missing";
  note?: string;
}

export interface ComparisonResult {
  rowNumber: number;
  car: string;
  fields: Record<string, FieldComparison>;
  variantCheck: {
    excel: string;
    foundOnSites: string[];
    notFoundOnSites: string[];
    status: "match" | "partial" | "missing";
  };
}

/**
 * Normalize a value for comparison by stripping currency codes, unit suffixes,
 * commas, and whitespace, then lowercasing.
 *
 * IMPORTANT: Uses word-boundary matching (\b) so that unit/currency tokens are
 * only removed when they appear as whole words.  The earlier implementation used
 * a bare character-class approach (`/AED|USD|EUR|km|kWh|hp|kW|kg|mm|s/gi`)
 * which incorrectly stripped the letter "s" from every value (e.g. "Tesla" ->
 * "Tela").  The fix below avoids that by never listing "s" as a standalone
 * alternative and by anchoring every token with \b.
 */
function normalizeValue(val: string): string {
  return val
    .replace(/\b(AED|USD|EUR|SAR|km\/h|kWh|km|hp|kW|kg|mm)\b/gi, "")
    .replace(/[,\s]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Find a key in `keys` that fuzzy-matches `target`.
 * Matching is done by stripping underscores, spaces, and dashes, then comparing
 * case-insensitively.
 */
function findMatchingKey(target: string, keys: string[]): string | null {
  const normalize = (s: string) =>
    s
      .replace(/[_\s-]/g, "")
      .toLowerCase();

  const normalizedTarget = normalize(target);

  for (const key of keys) {
    if (normalize(key) === normalizedTarget) {
      return key;
    }
  }

  return null;
}

/**
 * Compare a single field's Excel value against scraped values from multiple
 * sources.  Returns a FieldComparison indicating match / mismatch / missing.
 */
function compareField(
  excelValue: string,
  scrapedValues: Record<string, string>
): FieldComparison {
  const result: FieldComparison = {
    excel: excelValue,
    scraped: scrapedValues,
    status: "missing",
  };

  const sources = Object.keys(scrapedValues);

  if (sources.length === 0) {
    result.status = "missing";
    result.note = "No scraped data available for this field";
    return result;
  }

  const normalizedExcel = normalizeValue(excelValue);
  let hasMatch = false;
  let hasMismatch = false;

  for (const source of sources) {
    const normalizedScraped = normalizeValue(scrapedValues[source]);

    if (normalizedExcel === normalizedScraped) {
      hasMatch = true;
    } else {
      hasMismatch = true;
    }
  }

  if (hasMatch && !hasMismatch) {
    result.status = "match";
  } else if (hasMatch && hasMismatch) {
    result.status = "mismatch";
    result.note = "Value matches some sources but not all";
  } else {
    result.status = "mismatch";
    result.note = "Value does not match any scraped source";
  }

  return result;
}

/**
 * Compare an Excel entry against scraped results from one or more web sources.
 */
export function compareEntry(
  excelEntry: ExcelEntry,
  scrapedResults: Array<{
    source: string;
    price: string;
    specs: Record<string, string>;
    variants: string[];
  }>
): ComparisonResult {
  const car = `${excelEntry.brand} ${excelEntry.model}`.trim();

  // --- Price comparison ---
  const priceScraped: Record<string, string> = {};
  for (const result of scrapedResults) {
    if (result.price) {
      priceScraped[result.source] = result.price;
    }
  }

  const fields: Record<string, FieldComparison> = {};
  fields["price"] = compareField(excelEntry.price, priceScraped);

  // --- Specs comparison ---
  for (const [specKey, excelValue] of Object.entries(excelEntry.specs)) {
    const specScraped: Record<string, string> = {};

    for (const result of scrapedResults) {
      const scrapedKeys = Object.keys(result.specs);
      const matchedKey = findMatchingKey(specKey, scrapedKeys);

      if (matchedKey !== null) {
        specScraped[result.source] = result.specs[matchedKey];
      }
    }

    fields[specKey] = compareField(excelValue, specScraped);
  }

  // --- Variant check ---
  const foundOnSites: string[] = [];
  const notFoundOnSites: string[] = [];
  const excelVariantLower = excelEntry.variant.toLowerCase();

  for (const result of scrapedResults) {
    const variantFound = result.variants.some((v) =>
      v.toLowerCase().includes(excelVariantLower)
    );

    if (variantFound) {
      foundOnSites.push(result.source);
    } else {
      notFoundOnSites.push(result.source);
    }
  }

  let variantStatus: "match" | "partial" | "missing";
  if (foundOnSites.length === scrapedResults.length) {
    variantStatus = "match";
  } else if (foundOnSites.length > 0) {
    variantStatus = "partial";
  } else {
    variantStatus = "missing";
  }

  return {
    rowNumber: excelEntry.rowNumber,
    car,
    fields,
    variantCheck: {
      excel: excelEntry.variant,
      foundOnSites,
      notFoundOnSites,
      status: variantStatus,
    },
  };
}
