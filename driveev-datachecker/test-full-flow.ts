import XLSX from "xlsx";
import * as path from "path";
import * as fs from "fs";
import { parseExcelFile } from "./src/excel-parser.js";
import { scrapeEvData, closeBrowser } from "./src/scraper.js";
import { compareEntry } from "./src/comparator.js";
import { saveExcelReport, saveMarkdownReport } from "./src/report-writer.js";

async function runFullFlow() {
  const testDir = path.resolve("test-data");
  const outputDir = path.resolve("test-output");
  fs.mkdirSync(testDir, { recursive: true });

  // =====================================================
  // STEP 1: Create Excel with BYD Seal data
  // =====================================================
  console.log("\n========================================");
  console.log("STEP 1: CREATE TEST EXCEL");
  console.log("========================================\n");

  const excelData = [
    [
      "Brand", "Group", "Model", "Variant", "Fuel Type", "Type", "Seats",
      "Drivetrain", "Battery (kWh)", "Range (km)", "WLTP Range (km)",
      "0-100 (s)", "Base Price (AED)", "Price", "Warranty (Years)",
      "Battery Warranty (Years)", "Service Plan (Years)",
      "Roadside Assist (Years)", "Maintenance (Years)",
      "Charging (kW AC)", "Charging (kW DC)", "Top Speed (km/h)",
      "Energy Consumption (kWh/100km)"
    ],
    [
      "BYD", "BYD Group", "Seal", "RWD (Standard)", "BEV", "Passenger", 5,
      "RWD", 75, 475, 520,
      7.5, 25000, 174000, 3,
      3, 3,
      3, 3,
      7.2, 250, 325,
      18.3
    ],
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(excelData);
  XLSX.utils.book_append_sheet(wb, ws, "EV Cars");
  const excelPath = path.join(testDir, "byd-seal-test.xlsx");
  XLSX.writeFile(wb, excelPath);
  console.log(`Created test Excel: ${excelPath}`);

  // =====================================================
  // STEP 2: Parse Excel
  // =====================================================
  console.log("\n========================================");
  console.log("STEP 2: PARSE EXCEL");
  console.log("========================================\n");

  const entries = parseExcelFile(excelPath);
  const entry = entries[0];
  console.log(`Brand: ${entry.brand}, Model: ${entry.model}, Variant: ${entry.variant}`);
  console.log(`Price: ${entry.price}`);
  console.log(`Specs: ${Object.keys(entry.specs).length} fields`);

  // =====================================================
  // STEP 3: Scrape ALL 5 sites
  // =====================================================
  console.log("\n========================================");
  console.log("STEP 3: SCRAPE ALL 5 SITES");
  console.log("========================================\n");

  const sites = [
    { key: "yallamotor", url: "https://www.yallamotor.com/new-cars/byd/seal/2025" },
    { key: "dubicars", url: "https://www.dubicars.com/new-cars/byd/seal" },
    { key: "drivearabia", url: "https://www.drivearabia.com/carprices/uae/byd/byd-seal/2026/" },
    { key: "zigwheels-uae", url: "https://www.zigwheels.ae/new-cars/byd/seal" },
    { key: "autotrader-uae", url: "https://www.autotraderuae.com/new-cars/byd/seal" },
  ];

  const scrapedResults: Array<{
    source: string;
    price: string;
    specs: Record<string, string>;
    variants: string[];
  }> = [];

  for (const site of sites) {
    console.log(`\n--- [${site.key}] Scraping ---`);
    const startTime = Date.now();
    try {
      const result = await scrapeEvData(site.url, site.key, "BYD", "Seal");
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  Strategy: ${result.strategy} (${elapsed}s)`);
      console.log(`  Title: ${result.data.title || "(empty)"}`);
      console.log(`  Price: ${result.data.price || "(empty)"}`);
      const specCount = Object.keys(result.data.specs).length;
      if (specCount > 0) {
        console.log(`  Specs (${specCount}):`);
        for (const [k, v] of Object.entries(result.data.specs)) {
          console.log(`    ${k}: ${v}`);
        }
      } else {
        console.log(`  Specs: none extracted`);
      }
      console.log(`  Variants: ${result.data.variants.length > 0 ? JSON.stringify(result.data.variants) : "none"}`);
      console.log(`  Raw text: ${result.rawText.length} chars`);

      scrapedResults.push({
        source: result.source,
        price: result.data.price,
        specs: result.data.specs,
        variants: result.data.variants,
      });
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(`  FAILED (${elapsed}s):`, err instanceof Error ? err.message : err);
      // Still add empty result so comparison shows "missing"
      scrapedResults.push({
        source: site.key,
        price: "",
        specs: {},
        variants: [],
      });
    }
  }

  // =====================================================
  // STEP 3.5: Cross-site data summary
  // =====================================================
  console.log("\n========================================");
  console.log("CROSS-SITE DATA SUMMARY");
  console.log("========================================\n");

  // Collect all spec keys across all sites
  const allSpecKeys = new Set<string>();
  for (const r of scrapedResults) {
    for (const key of Object.keys(r.specs)) allSpecKeys.add(key);
  }

  console.log("Price across sites:");
  for (const r of scrapedResults) {
    console.log(`  ${r.source}: ${r.price || "-"}`);
  }

  console.log(`\nSpecs found across sites (${allSpecKeys.size} unique fields):`);
  for (const key of allSpecKeys) {
    const values: string[] = [];
    for (const r of scrapedResults) {
      if (r.specs[key]) values.push(`${r.source}: ${r.specs[key]}`);
    }
    console.log(`  ${key}: ${values.join(" | ")}`);
  }

  // =====================================================
  // STEP 4: Compare
  // =====================================================
  console.log("\n========================================");
  console.log("STEP 4: COMPARE EXCEL vs ALL SITES");
  console.log("========================================\n");

  const comparison = compareEntry(entry, scrapedResults);

  // Print comparison summary
  let matchCount = 0, mismatchCount = 0, missingCount = 0;
  for (const [field, fc] of Object.entries(comparison.fields)) {
    if (fc.status === "match") matchCount++;
    else if (fc.status === "mismatch") mismatchCount++;
    else missingCount++;
  }
  console.log(`Match: ${matchCount} | Mismatch: ${mismatchCount} | Missing: ${missingCount}`);
  console.log(`\nDetailed field comparison:`);
  for (const [field, fc] of Object.entries(comparison.fields)) {
    const scrapedStr = Object.entries(fc.scraped)
      .map(([s, v]) => `${s}=${v}`)
      .join(", ");
    console.log(`  [${fc.status.toUpperCase().padEnd(8)}] ${field}: Excel="${fc.excel}" | Scraped: ${scrapedStr || "none"}`);
  }

  console.log(`\nVariant check: "${comparison.variantCheck.excel}" → ${comparison.variantCheck.status}`);
  if (comparison.variantCheck.foundOnSites.length > 0) {
    console.log(`  Found on: ${comparison.variantCheck.foundOnSites.join(", ")}`);
  }
  if (comparison.variantCheck.notFoundOnSites.length > 0) {
    console.log(`  Not found on: ${comparison.variantCheck.notFoundOnSites.join(", ")}`);
  }

  // =====================================================
  // STEP 5: Save Report
  // =====================================================
  console.log("\n========================================");
  console.log("STEP 5: SAVE REPORT");
  console.log("========================================\n");

  const siteNames = sites.map((s) => s.key);
  const excelReport = saveExcelReport([comparison], excelPath, outputDir);
  const mdReport = saveMarkdownReport([comparison], excelPath, siteNames, outputDir);

  console.log(`Excel report: ${excelReport}`);
  console.log(`Markdown report: ${mdReport}`);

  console.log("\n========================================");
  console.log("MARKDOWN REPORT");
  console.log("========================================\n");
  console.log(fs.readFileSync(mdReport, "utf-8"));

  await closeBrowser();
  console.log("\n=== FULL FLOW COMPLETE ===");
}

runFullFlow().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
