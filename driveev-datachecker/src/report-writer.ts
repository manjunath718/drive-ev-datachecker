import XLSX from "xlsx";
import * as fs from "fs";
import * as path from "path";
import type { ComparisonResult } from "./comparator.js";

/**
 * Save an annotated Excel report.
 *
 * Reads the original Excel file, appends verification columns for each
 * compared field ({field}_Status, {field}_Scraped, {field}_Note) plus a
 * Variant_Status column, and writes the result to outputDir.
 */
export function saveExcelReport(
  comparisons: ComparisonResult[],
  originalExcelPath: string,
  outputDir: string
): string {
  // Ensure the output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  // Read the original workbook
  const workbook = XLSX.readFile(originalExcelPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Parse sheet as raw row arrays (header = 1 gives arrays of arrays)
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
  });

  if (rows.length === 0) {
    // Nothing to annotate – write an empty workbook
    const outputPath = path.join(outputDir, "ev-data-verified.xlsx");
    XLSX.writeFile(workbook, outputPath);
    return outputPath;
  }

  const headers = (rows[0] as unknown[]).map((h) => String(h ?? ""));

  // Collect all unique field names across every comparison
  const fieldNamesSet = new Set<string>();
  for (const comparison of comparisons) {
    for (const fieldName of Object.keys(comparison.fields)) {
      fieldNamesSet.add(fieldName);
    }
  }
  const fieldNames = Array.from(fieldNamesSet);

  // Append new header columns
  for (const field of fieldNames) {
    headers.push(`${field}_Status`);
    headers.push(`${field}_Scraped`);
    headers.push(`${field}_Note`);
  }
  headers.push("Variant_Status");

  // Replace the header row
  rows[0] = headers;

  // Build a lookup from rowNumber to comparison
  const comparisonByRow = new Map<number, ComparisonResult>();
  for (const comparison of comparisons) {
    comparisonByRow.set(comparison.rowNumber, comparison);
  }

  // Annotate each data row
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[];
    // rowNumber is 1-indexed with row 1 being header, so data row index i
    // corresponds to rowNumber = i + 1
    const rowNumber = i + 1;
    const comparison = comparisonByRow.get(rowNumber);

    for (const field of fieldNames) {
      if (comparison && comparison.fields[field]) {
        const fc = comparison.fields[field];
        row.push(fc.status);
        // Concatenate scraped values from all sources
        const scrapedSummary = Object.entries(fc.scraped)
          .map(([source, value]) => `${source}: ${value}`)
          .join("; ");
        row.push(scrapedSummary);
        row.push(fc.note ?? "");
      } else {
        row.push("");
        row.push("");
        row.push("");
      }
    }

    // Variant status
    if (comparison) {
      row.push(comparison.variantCheck.status);
    } else {
      row.push("");
    }
  }

  // Create a new worksheet from the annotated rows
  const newSheet = XLSX.utils.aoa_to_sheet(rows);
  workbook.Sheets[sheetName] = newSheet;

  const outputPath = path.join(outputDir, "ev-data-verified.xlsx");
  XLSX.writeFile(workbook, outputPath);
  return outputPath;
}

/**
 * Save a Markdown summary report.
 *
 * Produces a human-readable report with:
 * - Header with date, source file, and sites checked
 * - Summary table of match / mismatch / missing counts
 * - Discrepancies section listing only cars that have issues
 * - Variant check notes for non-matching variants
 */
export function saveMarkdownReport(
  comparisons: ComparisonResult[],
  originalExcelPath: string,
  sites: string[],
  outputDir: string
): string {
  // Ensure the output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];

  const lines: string[] = [];

  // --- Header ---
  lines.push("# EV Data Verification Report");
  lines.push("");
  lines.push(`**Date:** ${dateStr}`);
  lines.push(`**Source:** ${originalExcelPath}`);
  lines.push(`**Sites checked:** ${sites.join(", ")}`);
  lines.push(`**Total entries:** ${comparisons.length}`);
  lines.push("");

  // --- Summary counts ---
  let matchCount = 0;
  let mismatchCount = 0;
  let missingCount = 0;

  for (const comparison of comparisons) {
    for (const fc of Object.values(comparison.fields)) {
      switch (fc.status) {
        case "match":
          matchCount++;
          break;
        case "mismatch":
          mismatchCount++;
          break;
        case "missing":
          missingCount++;
          break;
      }
    }
  }

  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Count |");
  lines.push("| --- | --- |");
  lines.push(`| Match | ${matchCount} |`);
  lines.push(`| Mismatch | ${mismatchCount} |`);
  lines.push(`| Missing | ${missingCount} |`);
  lines.push(`| **Total fields checked** | **${matchCount + mismatchCount + missingCount}** |`);
  lines.push("");

  // --- Discrepancies ---
  const carsWithIssues = comparisons.filter((c) => {
    const hasFieldIssue = Object.values(c.fields).some(
      (fc) => fc.status !== "match"
    );
    const hasVariantIssue = c.variantCheck.status !== "match";
    return hasFieldIssue || hasVariantIssue;
  });

  lines.push("## Discrepancies");
  lines.push("");

  if (carsWithIssues.length === 0) {
    lines.push("No discrepancies found. All values match.");
    lines.push("");
  } else {
    lines.push(
      `Found issues in **${carsWithIssues.length}** out of ${comparisons.length} entries.`
    );
    lines.push("");

    for (const comparison of carsWithIssues) {
      lines.push(`### ${comparison.car} (Row ${comparison.rowNumber})`);
      lines.push("");

      // Build a table: Field | Excel | {site1} | {site2} | ... | Status
      const tableHeaders = ["Field", "Excel"];
      for (const site of sites) {
        tableHeaders.push(site);
      }
      tableHeaders.push("Status");

      lines.push("| " + tableHeaders.join(" | ") + " |");
      lines.push(
        "| " + tableHeaders.map(() => "---").join(" | ") + " |"
      );

      for (const [fieldName, fc] of Object.entries(comparison.fields)) {
        const row: string[] = [fieldName, fc.excel];
        for (const site of sites) {
          row.push(fc.scraped[site] ?? "-");
        }
        row.push(fc.status);
        lines.push("| " + row.join(" | ") + " |");
      }

      lines.push("");

      // Variant check notes
      if (comparison.variantCheck.status !== "match") {
        lines.push(
          `**Variant check:** \`${comparison.variantCheck.excel}\` — status: **${comparison.variantCheck.status}**`
        );
        if (comparison.variantCheck.foundOnSites.length > 0) {
          lines.push(
            `- Found on: ${comparison.variantCheck.foundOnSites.join(", ")}`
          );
        }
        if (comparison.variantCheck.notFoundOnSites.length > 0) {
          lines.push(
            `- Not found on: ${comparison.variantCheck.notFoundOnSites.join(", ")}`
          );
        }
        lines.push("");
      }
    }
  }

  const markdown = lines.join("\n");
  const outputPath = path.join(outputDir, "ev-data-report.md");
  fs.writeFileSync(outputPath, markdown, "utf-8");
  return outputPath;
}
