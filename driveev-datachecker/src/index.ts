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
  "Reads a local Excel file and returns structured EV data (brand, model, variant, price, specs). Column matching is case-insensitive.",
  {
    filePath: z.string().describe("Absolute path to the .xlsx file"),
    sheetName: z
      .string()
      .optional()
      .describe("Sheet name (defaults to first sheet)"),
  },
  async ({ filePath, sheetName }) => {
    try {
      const entries = parseExcelFile(filePath, sheetName);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { totalRows: entries.length, entries },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error parsing Excel: ${message}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: Scrape EV Data
server.tool(
  "scrape_ev_data",
  "Scrapes a URL for EV car data using config-driven CSS selectors with raw text fallback. Includes retry logic and timeout handling.",
  {
    url: z.string().describe("Full URL to scrape"),
    siteKey: z
      .string()
      .optional()
      .describe(
        "Site config key (e.g., 'yallamotor'). Auto-detected from URL if omitted"
      ),
  },
  async ({ url, siteKey }) => {
    try {
      const data = await scrapeEvData(url, siteKey);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error scraping ${url}: ${message}` }],
        isError: true,
      };
    }
  }
);

// Proper schema for scraped results (replaces z.any())
const scrapedResultSchema = z.object({
  source: z.string(),
  price: z.string(),
  specs: z.record(z.string()),
  variants: z.array(z.string()),
});

const excelEntrySchema = z.object({
  rowNumber: z.number(),
  brand: z.string(),
  model: z.string(),
  variant: z.string(),
  price: z.string(),
  specs: z.record(z.string()),
});

const fieldComparisonSchema = z.object({
  excel: z.string(),
  scraped: z.record(z.string()),
  status: z.enum(["match", "mismatch", "missing"]),
  note: z.string().optional(),
});

const comparisonResultSchema = z.object({
  rowNumber: z.number(),
  car: z.string(),
  fields: z.record(fieldComparisonSchema),
  variantCheck: z.object({
    excel: z.string(),
    foundOnSites: z.array(z.string()),
    notFoundOnSites: z.array(z.string()),
    status: z.enum(["match", "partial", "missing"]),
  }),
});

// Tool 3: Compare Data
server.tool(
  "compare_data",
  "Compares one Excel entry against scraped data from one or more sites. Uses normalized exact matching (strips units, currency, commas).",
  {
    excelEntry: excelEntrySchema,
    scrapedResults: z.array(scrapedResultSchema),
  },
  async ({ excelEntry, scrapedResults }) => {
    try {
      const result = compareEntry(excelEntry, scrapedResults);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `Error comparing data: ${message}` },
        ],
        isError: true,
      };
    }
  }
);

// Tool 4: Save Report
server.tool(
  "save_report",
  "Saves comparison results as annotated Excel file + Markdown summary report. Creates output directory if needed.",
  {
    comparisons: z
      .array(comparisonResultSchema)
      .describe("Array of ComparisonResult objects from compare_data"),
    originalExcelPath: z
      .string()
      .describe("Path to the original Excel file"),
    outputDir: z.string().describe("Directory to save reports"),
    sites: z.array(z.string()).describe("List of site names checked"),
  },
  async ({ comparisons, originalExcelPath, outputDir, sites }) => {
    try {
      const excelPath = saveExcelReport(
        comparisons,
        originalExcelPath,
        outputDir
      );
      const mdPath = saveMarkdownReport(
        comparisons,
        originalExcelPath,
        sites,
        outputDir
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { excelReport: excelPath, markdownReport: mdPath },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: "text", text: `Error saving report: ${message}` },
        ],
        isError: true,
      };
    }
  }
);

// Start server with graceful shutdown
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("DriveEV Data Checker MCP server started");

  const shutdown = async () => {
    console.error("Shutting down DriveEV Data Checker MCP server...");
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});
