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
 * Synonym groups for fields where different sources use equivalent terms.
 * Each group maps to a canonical form used for comparison.
 */
const VALUE_SYNONYMS: Record<string, string[]> = {
  electric: ["bev", "electric", "battery electric", "battery electric vehicle", "full electric"],
  "plug-in hybrid": ["phev", "plug-in hybrid", "plug-in hybrid electric"],
  hybrid: ["hev", "hybrid", "hybrid electric"],
  "fuel cell": ["fcev", "fuel cell", "hydrogen fuel cell"],
  rwd: ["rwd", "rear-wheel drive", "rear wheel drive"],
  fwd: ["fwd", "front-wheel drive", "front wheel drive"],
  awd: ["awd", "4wd", "all-wheel drive", "all wheel drive", "four-wheel drive"],
  automatic: ["automatic", "auto", "at", "cvt", "dct", "single-speed"],
  manual: ["manual", "mt"],
};

/**
 * Get the canonical form for a value if it belongs to a synonym group.
 * Returns the canonical key if found, otherwise the original value.
 */
function getCanonicalValue(val: string): string {
  const lower = val.toLowerCase().trim();
  for (const [canonical, synonyms] of Object.entries(VALUE_SYNONYMS)) {
    if (synonyms.includes(lower)) {
      return canonical;
    }
  }
  return lower;
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
    .replace(/\b(AED|USD|EUR|SAR|km\/h|kWh|km|hp|bhp|kW|kg|mm|nm|sec|seater|seats|seat)\b/gi, "")
    .replace(/[,\s]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Field name alias groups. Each array contains equivalent field names
 * that different sites may use for the same data point.
 * The first entry is the "canonical" name.
 */
const FIELD_ALIASES: string[][] = [
  ["battery_(kwh)", "battery_size", "battery_capacity", "engine_size", "battery"],
  ["seats", "seating_capacity", "seating", "seater"],
  ["drivetrain", "drive_type", "driven_wheels"],
  ["range_(km)", "battery_range", "range", "electric_range"],
  ["wltp_range_(km)", "wltp_range"],
  ["0-100_(s)", "acceleration_(0-100_km/h)", "acceleration", "0-100_kmh", "0_to_100"],
  ["top_speed_(km/h)", "top_speed", "max_speed"],
  ["fuel_type", "engine_type", "fuel"],
  ["type", "vehicle_type", "vehicle_category"],
  ["body_type", "body_style"],
  ["charging_(kw_ac)", "ac_charging", "charging_ac"],
  ["charging_(kw_dc)", "dc_charging", "charging_dc", "fast_charging"],
  ["energy_consumption_(kwh/100km)", "energy_consumption", "consumption"],
  ["group", "brand_group", "manufacturer_group"],
  ["price", "price_range"],
  ["horsepower", "horsepower_(bhp)", "power", "max_power"],
  ["torque", "max_torque"],
  ["weight", "curb_weight", "kerb_weight"],
  ["length", "overall_length"],
  ["width", "overall_width"],
  ["height", "overall_height"],
  ["boot_space", "trunk_space", "cargo_capacity", "cargo_volume"],
];

/**
 * Get all alias keys that are equivalent to the given field name.
 */
function getFieldAliases(fieldName: string): string[] {
  const normalized = fieldName.replace(/[_\s-]/g, "").toLowerCase();
  for (const group of FIELD_ALIASES) {
    for (const alias of group) {
      if (alias.replace(/[_\s-]/g, "").toLowerCase() === normalized) {
        return group;
      }
    }
  }
  return [fieldName];
}

/**
 * Find a key in `keys` that fuzzy-matches `target`.
 * Matching is done by:
 * 1. Checking field alias groups for equivalent names
 * 2. Stripping underscores, spaces, and dashes, then comparing case-insensitively
 */
function findMatchingKey(target: string, keys: string[]): string | null {
  const normalize = (s: string) =>
    s
      .replace(/[_\s-]/g, "")
      .replace(/\(.*?\)/g, "")
      .toLowerCase();

  const normalizedTarget = normalize(target);

  // Direct fuzzy match
  for (const key of keys) {
    if (normalize(key) === normalizedTarget) {
      return key;
    }
  }

  // Alias group match
  const aliases = getFieldAliases(target);
  for (const alias of aliases) {
    const normalizedAlias = normalize(alias);
    for (const key of keys) {
      if (normalize(key) === normalizedAlias) {
        return key;
      }
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
  const canonicalExcel = getCanonicalValue(excelValue);
  let hasMatch = false;
  let hasMismatch = false;

  for (const source of sources) {
    const normalizedScraped = normalizeValue(scrapedValues[source]);
    const canonicalScraped = getCanonicalValue(scrapedValues[source]);

    if (normalizedExcel === normalizedScraped || canonicalExcel === canonicalScraped) {
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
