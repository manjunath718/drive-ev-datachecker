# DriveEV Data Checker — Implementation Story

## Overview

An MCP server that verifies Electric Vehicle data stored in a local Excel file against live data from OEM websites and car review sites. It parses the Excel, scrapes target websites, compares values (exact match), and produces both an annotated Excel file and a Markdown summary report highlighting matches, discrepancies, and missing data.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Claude Code                        │
│              (Orchestrator / Brain)                   │
│                                                      │
│  1. "Parse the Excel at /path/to/ev-data.xlsx"       │
│  2. "Scrape YallaMotor for Tesla Model 3"            │
│  3. "Scrape AutoTrader for Tesla Model 3"            │
│  4. "Compare Excel row vs scraped data"              │
│  5. "Save the report"                                │
│         │                                            │
└─────────┼────────────────────────────────────────────┘
          │ stdio (JSON-RPC)
          ▼
┌─────────────────────────────────────────────────────┐
│            DriveEV Data Checker MCP Server            │
│                                                      │
│  Tools:                                              │
│  ┌─────────────┐  ┌──────────────┐                   │
│  │ parse_excel  │  │scrape_ev_data│                   │
│  └─────────────┘  └──────────────┘                   │
│  ┌──────────────┐  ┌─────────────┐                   │
│  │ compare_data │  │ save_report  │                   │
│  └──────────────┘  └─────────────┘                   │
│                                                      │
│  Config:                                             │
│  ┌──────────────────────┐                            │
│  │ site-configs/*.json   │ ← CSS selectors per site  │
│  └──────────────────────┘                            │
└─────────────────────────────────────────────────────┘
```

**How Claude orchestrates a typical run:**

1. User says: *"Check the EV data in `/data/ev-cars.xlsx` against YallaMotor and AutoTrader"*
2. Claude calls `parse_excel` → gets all rows (brand, model, variant, price, specs)
3. For each car entry, Claude calls `scrape_ev_data` for each target site
4. Claude calls `compare_data` with the Excel row + scraped results → gets match/mismatch/missing per field
5. After all cars are checked, Claude calls `save_report` with all comparison results → outputs annotated Excel + Markdown report
6. Claude summarizes the findings to the user

---

## MCP Tools

### Tool 1: `parse_excel`

**Purpose**: Read a local Excel file and return structured EV data rows.

**Input Schema**:
```typescript
{
  filePath: z.string(),         // Absolute path to .xlsx file
  sheetName: z.string().optional(), // Sheet name (defaults to first sheet)
}
```

**Output**: Array of car entries
```json
{
  "totalRows": 45,
  "entries": [
    {
      "rowNumber": 2,
      "brand": "Tesla",
      "model": "Model 3",
      "variant": "Long Range",
      "price": "189900",
      "specs": {
        "range": "629 km",
        "battery": "75 kWh",
        "motor": "Dual Motor AWD",
        "acceleration": "4.4s 0-100",
        "topSpeed": "201 km/h"
      }
    }
  ]
}
```

**Implementation**:
```typescript
import * as XLSX from "xlsx";

interface ExcelEntry {
  rowNumber: number;
  brand: string;
  model: string;
  variant: string;
  price: string;
  specs: Record<string, string>;
}

export function parseExcelFile(filePath: string, sheetName?: string): ExcelEntry[] {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[sheetName || workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);

  return rows.map((row, index) => {
    // Extract known columns, rest goes into specs
    const { Brand, Model, Variant, Price, ...specColumns } = row;

    const specs: Record<string, string> = {};
    for (const [key, value] of Object.entries(specColumns)) {
      if (value !== undefined && value !== "") {
        specs[key.toLowerCase().replace(/\s+/g, "_")] = String(value).trim();
      }
    }

    return {
      rowNumber: index + 2, // +2 because row 1 is header, 0-indexed
      brand: String(Brand || "").trim(),
      model: String(Model || "").trim(),
      variant: String(Variant || "").trim(),
      price: String(Price || "").trim(),
      specs,
    };
  });
}
```

**Column mapping note**: The Excel column headers must include `Brand`, `Model`, `Variant`, `Price`. All other columns are treated as spec fields. If your Excel uses different column names, update the destructuring in the code.

---

### Tool 2: `scrape_ev_data`

**Purpose**: Scrape a specific URL for EV car data using a config-driven CSS selector approach. Falls back to raw text extraction if selectors fail.

**Input Schema**:
```typescript
{
  url: z.string(),              // Full URL to scrape
  siteKey: z.string().optional(), // Key into site-configs (e.g., "yallamotor")
}
```

**Output**: Structured scraped data
```json
{
  "source": "yallamotor",
  "url": "https://yallamotor.com/...",
  "data": {
    "title": "Tesla Model 3 Long Range 2024",
    "price": "189,900 AED",
    "specs": {
      "range": "629 km",
      "battery": "75 kWh",
      "motor": "Dual Motor AWD"
    },
    "variants": ["Standard Range", "Long Range", "Performance"]
  },
  "rawText": "Tesla Model 3 Long Range 2024 Price: 189900..."
}
```

**Site config structure** (`config/sites/yallamotor.json`):
```json
{
  "name": "YallaMotor",
  "baseUrl": "https://yallamotor.com",
  "selectors": {
    "title": "h1.car-title",
    "price": ".price-value",
    "specsTable": ".specs-table tr",
    "specLabel": "td:first-child",
    "specValue": "td:last-child",
    "variants": ".variant-list li",
    "images": ".gallery img"
  }
}
```

**Implementation**:
```typescript
import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";

interface SiteConfig {
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

interface ScrapedData {
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
  const configPath = path.join(__dirname, "..", "config", "sites", `${siteKey}.json`);
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function detectSiteKey(url: string, configs: Record<string, SiteConfig>): string | null {
  for (const [key, config] of Object.entries(configs)) {
    if (url.includes(config.baseUrl) || url.includes(key)) return key;
  }
  return null;
}

export async function scrapeEvData(url: string, siteKey?: string): Promise<ScrapedData> {
  const response = await fetch(url, {
    headers: { "User-Agent": "DriveEV-DataChecker/1.0" },
  });
  const html = await response.text();
  const $ = cheerio.load(html);

  // Determine site config
  const resolvedKey = siteKey || detectSiteKey(url, loadAllConfigs());
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
        const label = $(row).find(config.selectors.specLabel || "td:first-child").text().trim();
        const value = $(row).find(config.selectors.specValue || "td:last-child").text().trim();
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
  $("script, style, nav, footer, header").remove();
  result.rawText = $("body").text().replace(/\s+/g, " ").trim().substring(0, 8000);

  return result;
}
```

**Why raw text fallback matters**: Website layouts change frequently. When CSS selectors break, the raw text still gives Claude enough data to extract information using AI reasoning.

---

### Tool 3: `compare_data`

**Purpose**: Compare one Excel entry against scraped data from one or more sites. Returns exact match results per field.

**Input Schema**:
```typescript
{
  excelEntry: z.object({
    rowNumber: z.number(),
    brand: z.string(),
    model: z.string(),
    variant: z.string(),
    price: z.string(),
    specs: z.record(z.string()),
  }),
  scrapedResults: z.array(z.object({
    source: z.string(),
    price: z.string(),
    specs: z.record(z.string()),
    variants: z.array(z.string()),
  })),
}
```

**Output**: Comparison result
```json
{
  "rowNumber": 2,
  "car": "Tesla Model 3 Long Range",
  "fields": {
    "price": {
      "excel": "189900",
      "scraped": { "yallamotor": "189,900 AED", "autotrader": "189900" },
      "status": "mismatch",
      "note": "Format differs: '189900' vs '189,900 AED'"
    },
    "range": {
      "excel": "629 km",
      "scraped": { "yallamotor": "629 km" },
      "status": "match"
    },
    "battery": {
      "excel": "75 kWh",
      "scraped": {},
      "status": "missing",
      "note": "Not found on any scraped site"
    }
  },
  "variantCheck": {
    "excel": "Long Range",
    "foundOnSites": ["yallamotor"],
    "notFoundOnSites": ["autotrader"],
    "status": "partial"
  }
}
```

**Implementation**:
```typescript
interface FieldComparison {
  excel: string;
  scraped: Record<string, string>;
  status: "match" | "mismatch" | "missing";
  note?: string;
}

interface ComparisonResult {
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

function normalizeValue(val: string): string {
  // Strip currency symbols, commas, units, extra spaces for comparison
  return val
    .replace(/[,\s]/g, "")
    .replace(/AED|USD|EUR|km|kWh|hp|kW|kg|mm|s/gi, "")
    .trim()
    .toLowerCase();
}

export function compareEntry(
  excelEntry: ExcelEntry,
  scrapedResults: Array<{ source: string; price: string; specs: Record<string, string>; variants: string[] }>
): ComparisonResult {
  const result: ComparisonResult = {
    rowNumber: excelEntry.rowNumber,
    car: `${excelEntry.brand} ${excelEntry.model} ${excelEntry.variant}`,
    fields: {},
    variantCheck: {
      excel: excelEntry.variant,
      foundOnSites: [],
      notFoundOnSites: [],
      status: "missing",
    },
  };

  // Compare price
  const priceScraped: Record<string, string> = {};
  for (const s of scrapedResults) {
    if (s.price) priceScraped[s.source] = s.price;
  }
  result.fields["price"] = compareField(excelEntry.price, priceScraped);

  // Compare each spec
  for (const [specKey, excelValue] of Object.entries(excelEntry.specs)) {
    const specScraped: Record<string, string> = {};
    for (const s of scrapedResults) {
      // Try exact key match, then fuzzy key match
      const matchedKey = findMatchingKey(specKey, Object.keys(s.specs));
      if (matchedKey) specScraped[s.source] = s.specs[matchedKey];
    }
    result.fields[specKey] = compareField(excelValue, specScraped);
  }

  // Check variant existence
  for (const s of scrapedResults) {
    const variantFound = s.variants.some(
      (v) => v.toLowerCase().includes(excelEntry.variant.toLowerCase())
    );
    if (variantFound) {
      result.variantCheck.foundOnSites.push(s.source);
    } else {
      result.variantCheck.notFoundOnSites.push(s.source);
    }
  }
  if (result.variantCheck.foundOnSites.length === scrapedResults.length) {
    result.variantCheck.status = "match";
  } else if (result.variantCheck.foundOnSites.length > 0) {
    result.variantCheck.status = "partial";
  }

  return result;
}

function compareField(excelValue: string, scrapedValues: Record<string, string>): FieldComparison {
  if (Object.keys(scrapedValues).length === 0) {
    return { excel: excelValue, scraped: scrapedValues, status: "missing", note: "Not found on any scraped site" };
  }

  const normalizedExcel = normalizeValue(excelValue);
  let allMatch = true;
  for (const scraped of Object.values(scrapedValues)) {
    if (normalizeValue(scraped) !== normalizedExcel) {
      allMatch = false;
      break;
    }
  }

  return {
    excel: excelValue,
    scraped: scrapedValues,
    status: allMatch ? "match" : "mismatch",
    note: allMatch ? undefined : `Excel: '${excelValue}' vs Scraped: ${JSON.stringify(scrapedValues)}`,
  };
}

function findMatchingKey(target: string, keys: string[]): string | null {
  const normalized = target.toLowerCase().replace(/[_\s-]/g, "");
  for (const key of keys) {
    if (key.toLowerCase().replace(/[_\s-]/g, "") === normalized) return key;
  }
  return null;
}
```

**Key detail — `normalizeValue`**: Before comparing, values are stripped of currency symbols (AED, USD), commas, units (km, kWh), and whitespace. This means `"189,900 AED"` vs `"189900"` will be an **exact match** after normalization. The raw values are still preserved in the output for human review.

---

### Tool 4: `save_report`

**Purpose**: Save comparison results as both an annotated Excel file and a Markdown summary.

**Input Schema**:
```typescript
{
  comparisons: z.array(z.object({
    rowNumber: z.number(),
    car: z.string(),
    fields: z.record(z.object({
      excel: z.string(),
      scraped: z.record(z.string()),
      status: z.enum(["match", "mismatch", "missing"]),
      note: z.string().optional(),
    })),
    variantCheck: z.object({
      excel: z.string(),
      foundOnSites: z.array(z.string()),
      notFoundOnSites: z.array(z.string()),
      status: z.enum(["match", "partial", "missing"]),
    }),
  })),
  originalExcelPath: z.string(),
  outputDir: z.string(),
}
```

**Output**: Paths to generated files
```json
{
  "excelReport": "/output/ev-data-verified.xlsx",
  "markdownReport": "/output/ev-data-report.md"
}
```

**Excel output format**: The original Excel data is preserved with 3 new columns appended per field:
- `Price_Status` → `match` / `mismatch` / `missing`
- `Price_Scraped` → Scraped values from each site
- `Price_Note` → Explanation of discrepancy (if any)
- Same pattern for each spec field

**Markdown output format**:
```markdown
# EV Data Verification Report

**Date**: 2025-02-14
**Source Excel**: /data/ev-cars.xlsx
**Sites checked**: YallaMotor, AutoTrader UAE

## Summary

| Status     | Count |
|------------|-------|
| ✅ Match    | 32    |
| ❌ Mismatch | 8     |
| ⚠️ Missing  | 5     |

## Discrepancies

### Tesla Model 3 Long Range (Row 2)

| Field   | Excel     | YallaMotor    | AutoTrader | Status   |
|---------|-----------|---------------|------------|----------|
| Price   | 189900    | 189,900 AED   | 189900     | ✅ Match  |
| Range   | 629 km    | 629 km        | —          | ⚠️ Missing (AutoTrader) |
| Battery | 75 kWh    | 82 kWh        | 82 kWh     | ❌ Mismatch |

...
```

**Implementation**:
```typescript
import * as XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";

export function saveExcelReport(
  comparisons: ComparisonResult[],
  originalExcelPath: string,
  outputDir: string
): string {
  const workbook = XLSX.readFile(originalExcelPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { header: 1 });

  // Find the last column
  const headers = rows[0] as string[];

  // Add verification columns
  const statusCols: string[] = [];
  // Collect all unique field names from comparisons
  const allFields = new Set<string>();
  for (const comp of comparisons) {
    for (const field of Object.keys(comp.fields)) {
      allFields.add(field);
    }
  }

  for (const field of allFields) {
    headers.push(`${field}_Status`, `${field}_Scraped`, `${field}_Note`);
  }
  headers.push("Variant_Status");

  // Update each data row
  for (const comp of comparisons) {
    const rowIndex = comp.rowNumber - 1; // Convert to 0-indexed
    if (!rows[rowIndex]) continue;
    const row = rows[rowIndex] as string[];

    for (const field of allFields) {
      const fc = comp.fields[field];
      if (fc) {
        row.push(fc.status, JSON.stringify(fc.scraped), fc.note || "");
      } else {
        row.push("", "", "");
      }
    }
    row.push(comp.variantCheck.status);
  }

  const newSheet = XLSX.utils.aoa_to_sheet(rows);
  workbook.Sheets[sheetName] = newSheet;

  const outputPath = path.join(outputDir, "ev-data-verified.xlsx");
  XLSX.writeFile(workbook, outputPath);
  return outputPath;
}

export function saveMarkdownReport(
  comparisons: ComparisonResult[],
  originalExcelPath: string,
  sites: string[],
  outputDir: string
): string {
  const today = new Date().toISOString().split("T")[0];
  const matchCount = comparisons.reduce(
    (sum, c) => sum + Object.values(c.fields).filter((f) => f.status === "match").length, 0
  );
  const mismatchCount = comparisons.reduce(
    (sum, c) => sum + Object.values(c.fields).filter((f) => f.status === "mismatch").length, 0
  );
  const missingCount = comparisons.reduce(
    (sum, c) => sum + Object.values(c.fields).filter((f) => f.status === "missing").length, 0
  );

  let md = `# EV Data Verification Report\n\n`;
  md += `**Date**: ${today}\n`;
  md += `**Source Excel**: ${originalExcelPath}\n`;
  md += `**Sites checked**: ${sites.join(", ")}\n\n`;
  md += `## Summary\n\n`;
  md += `| Status | Count |\n|--------|-------|\n`;
  md += `| Match | ${matchCount} |\n`;
  md += `| Mismatch | ${mismatchCount} |\n`;
  md += `| Missing | ${missingCount} |\n\n`;

  // Only show cars with issues
  const carsWithIssues = comparisons.filter((c) =>
    Object.values(c.fields).some((f) => f.status !== "match") ||
    c.variantCheck.status !== "match"
  );

  if (carsWithIssues.length === 0) {
    md += `## Result\n\nAll data matches across all sites. No discrepancies found.\n`;
  } else {
    md += `## Discrepancies\n\n`;
    for (const comp of carsWithIssues) {
      md += `### ${comp.car} (Row ${comp.rowNumber})\n\n`;
      md += `| Field | Excel |`;
      for (const site of sites) md += ` ${site} |`;
      md += ` Status |\n`;
      md += `|-------|-------|`;
      for (const _ of sites) md += `-------|`;
      md += `--------|\n`;

      for (const [field, fc] of Object.entries(comp.fields)) {
        md += `| ${field} | ${fc.excel} |`;
        for (const site of sites) {
          md += ` ${fc.scraped[site] || "—"} |`;
        }
        md += ` ${fc.status} |\n`;
      }

      if (comp.variantCheck.status !== "match") {
        md += `\n**Variant "${comp.variantCheck.excel}"**: `;
        if (comp.variantCheck.foundOnSites.length > 0) {
          md += `Found on ${comp.variantCheck.foundOnSites.join(", ")}. `;
        }
        if (comp.variantCheck.notFoundOnSites.length > 0) {
          md += `Not found on ${comp.variantCheck.notFoundOnSites.join(", ")}.`;
        }
        md += `\n`;
      }
      md += `\n`;
    }
  }

  const outputPath = path.join(outputDir, "ev-data-report.md");
  fs.writeFileSync(outputPath, md, "utf-8");
  return outputPath;
}
```

---

## MCP Server Registration

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseExcelFile } from "./excel-parser.js";
import { scrapeEvData } from "./scraper.js";
import { compareEntry } from "./comparator.js";
import { saveExcelReport, saveMarkdownReport } from "./report-writer.js";

const server = new McpServer({
  name: "driveev-datachecker",
  version: "1.0.0",
});

// Tool 1: Parse Excel
server.tool(
  "parse_excel",
  "Reads a local Excel file and returns structured EV data (brand, model, variant, price, specs)",
  {
    filePath: z.string().describe("Absolute path to the .xlsx file"),
    sheetName: z.string().optional().describe("Sheet name (defaults to first sheet)"),
  },
  async ({ filePath, sheetName }) => {
    const entries = parseExcelFile(filePath, sheetName);
    return {
      content: [{ type: "text", text: JSON.stringify({ totalRows: entries.length, entries }, null, 2) }],
    };
  }
);

// Tool 2: Scrape EV Data
server.tool(
  "scrape_ev_data",
  "Scrapes a URL for EV car data using config-driven CSS selectors with raw text fallback",
  {
    url: z.string().describe("Full URL to scrape"),
    siteKey: z.string().optional().describe("Site config key (e.g., 'yallamotor'). Auto-detected from URL if omitted"),
  },
  async ({ url, siteKey }) => {
    const data = await scrapeEvData(url, siteKey);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool 3: Compare Data
server.tool(
  "compare_data",
  "Compares one Excel entry against scraped data from one or more sites. Exact match with normalization.",
  {
    excelEntry: z.object({
      rowNumber: z.number(),
      brand: z.string(),
      model: z.string(),
      variant: z.string(),
      price: z.string(),
      specs: z.record(z.string()),
    }),
    scrapedResults: z.array(z.object({
      source: z.string(),
      price: z.string(),
      specs: z.record(z.string()),
      variants: z.array(z.string()),
    })),
  },
  async ({ excelEntry, scrapedResults }) => {
    const result = compareEntry(excelEntry, scrapedResults);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool 4: Save Report
server.tool(
  "save_report",
  "Saves comparison results as annotated Excel file + Markdown summary report",
  {
    comparisons: z.array(z.any()).describe("Array of ComparisonResult objects from compare_data"),
    originalExcelPath: z.string().describe("Path to the original Excel file"),
    outputDir: z.string().describe("Directory to save reports"),
    sites: z.array(z.string()).describe("List of site names checked"),
  },
  async ({ comparisons, originalExcelPath, outputDir, sites }) => {
    const excelPath = saveExcelReport(comparisons, originalExcelPath, outputDir);
    const mdPath = saveMarkdownReport(comparisons, originalExcelPath, sites, outputDir);
    return {
      content: [{ type: "text", text: JSON.stringify({ excelReport: excelPath, markdownReport: mdPath }, null, 2) }],
    };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(console.error);
```

---

## Project Structure

```
driveev-datachecker/
├── package.json
├── tsconfig.json
├── config/
│   └── sites/
│       ├── yallamotor.json       ← CSS selectors for YallaMotor
│       ├── autotrader-uae.json   ← CSS selectors for AutoTrader UAE
│       └── oem-tesla.json        ← CSS selectors for Tesla's official site
├── src/
│   ├── index.ts                  ← MCP server entry point
│   ├── excel-parser.ts           ← parse_excel implementation
│   ├── scraper.ts                ← scrape_ev_data implementation
│   ├── comparator.ts             ← compare_data implementation
│   └── report-writer.ts          ← save_report implementation (Excel + Markdown)
└── output/                       ← Generated reports land here
    ├── ev-data-verified.xlsx
    └── ev-data-report.md
```

---

## Dependencies

```json
{
  "name": "driveev-datachecker",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.23.0",
    "xlsx": "^0.18.5",
    "cheerio": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/node": "^20.0.0"
  }
}
```

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP server framework |
| `zod` | Input validation for tool schemas |
| `xlsx` | Read/write Excel files (.xlsx) |
| `cheerio` | HTML parsing with CSS selectors |

---

## Claude Desktop MCP Config

```json
{
  "mcpServers": {
    "driveev-datachecker": {
      "command": "node",
      "args": ["/path/to/driveev-datachecker/dist/index.js"]
    }
  }
}
```

No environment variables needed — all inputs (file paths, URLs) are passed per tool call.

---

## Example Conversation Flow

```
User: "Check the EV data in /data/uae-ev-cars.xlsx against YallaMotor and AutoTrader"

Claude: I'll verify your EV data against both sites. Let me start by reading the Excel file.

→ calls parse_excel({ filePath: "/data/uae-ev-cars.xlsx" })
← returns 45 entries

Claude: Found 45 cars. Let me check each one against both sites. Starting with Tesla Model 3...

→ calls scrape_ev_data({ url: "https://yallamotor.com/cars/tesla/model-3" })
← returns structured data + raw text

→ calls scrape_ev_data({ url: "https://autotrader.ae/cars/tesla/model-3" })
← returns structured data + raw text

→ calls compare_data({ excelEntry: {...}, scrapedResults: [{...}, {...}] })
← returns comparison with match/mismatch/missing per field

[...repeats for remaining cars...]

→ calls save_report({
     comparisons: [...all results...],
     originalExcelPath: "/data/uae-ev-cars.xlsx",
     outputDir: "/data/output",
     sites: ["yallamotor", "autotrader-uae"]
   })
← returns { excelReport: "/data/output/ev-data-verified.xlsx", markdownReport: "/data/output/ev-data-report.md" }

Claude: Verification complete! Here's the summary:
- ✅ 32 fields matched across all sites
- ❌ 8 mismatches found (mostly price differences)
- ⚠️ 5 fields missing from scraped sites

Key discrepancies:
1. Tesla Model 3 Long Range — battery listed as 75 kWh but both sites show 82 kWh
2. BYD Atto 3 — price in Excel is 119,900 but YallaMotor shows 124,900

Reports saved to:
- Excel: /data/output/ev-data-verified.xlsx
- Markdown: /data/output/ev-data-report.md
```

---

## Relationship to DriveEV Article Agent

Both agents scrape EV websites but serve **different purposes**:

| | Data Checker | Article Agent |
|---|---|---|
| **Goal** | Verify existing data | Generate new content |
| **Input** | Excel file with data | Car model + template type |
| **Output** | Discrepancy report | Article draft |
| **Scraping focus** | Extract specific fields for comparison | Extract content for article writing |
| **Code sharing** | Self-contained | Self-contained |

They use the **same config-driven scraping pattern** (JSON site configs + CSS selectors + raw text fallback) but maintain separate codebases for independence.

---

## Common Pitfalls

1. **`console.log` breaks MCP**: MCP uses stdio for communication. Use `console.error` for debug logging, never `console.log`.

2. **Excel column name mismatch**: The parser expects columns named `Brand`, `Model`, `Variant`, `Price` (case-sensitive). If your Excel uses different headers (e.g., `Car Brand`, `Model Name`), update the destructuring in `excel-parser.ts`.

3. **Website rate limiting**: Scraping many pages rapidly may trigger rate limits. Add delays between requests if needed:
   ```typescript
   await new Promise((resolve) => setTimeout(resolve, 1000)); // 1s delay between requests
   ```

4. **Stale CSS selectors**: Websites change their HTML structure. When scraping returns empty structured data but raw text has content, the selectors need updating. The raw text fallback ensures Claude can still work with the data.

5. **Normalized vs raw values**: The comparator normalizes values for matching (strips units, commas, currency). The report shows **both** the raw values so humans can verify the normalization was correct.

6. **Large Excel files**: For 100+ car entries with 2+ sites each, this means 200+ HTTP requests. Claude will process these sequentially. For very large datasets, consider batching (process 10 cars, save partial results, continue).

---

## Testing Plan

1. **Unit test `normalizeValue`**: Test that `"189,900 AED"`, `"189900"`, `"189,900"` all normalize to the same value
2. **Unit test `compareField`**: Test match, mismatch, and missing scenarios
3. **Unit test `parseExcelFile`**: Use a small test `.xlsx` with known data
4. **Integration test**: Create a mock HTML page, scrape it with a test config, verify extraction
5. **End-to-end**: Small Excel (3-5 cars) + mock server → full report generation
