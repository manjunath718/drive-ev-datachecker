import XLSX from "xlsx";

export interface ExcelEntry {
  rowNumber: number;
  brand: string;
  model: string;
  variant: string;
  price: string;
  specs: Record<string, string>;
}

// Required columns (matched case-insensitively)
const REQUIRED_COLUMNS = ["brand", "model", "variant", "price"] as const;

/**
 * Find the actual column header name that matches a required key (case-insensitive).
 * Returns the original header name from the Excel, or null if not found.
 */
function findColumnHeader(
  headers: string[],
  target: string
): string | null {
  const targetLower = target.toLowerCase();
  for (const header of headers) {
    if (header.toLowerCase().trim() === targetLower) {
      return header;
    }
  }
  return null;
}

export function parseExcelFile(
  filePath: string,
  sheetName?: string
): ExcelEntry[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read Excel file "${filePath}": ${message}`);
  }

  const targetSheet = sheetName || workbook.SheetNames[0];
  if (!targetSheet || !workbook.Sheets[targetSheet]) {
    const available = workbook.SheetNames.join(", ");
    throw new Error(
      `Sheet "${targetSheet}" not found. Available sheets: ${available}`
    );
  }

  const sheet = workbook.Sheets[targetSheet];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);

  if (rows.length === 0) {
    return [];
  }

  // Detect column headers from the first row's keys (case-insensitive)
  const firstRowKeys = Object.keys(rows[0]);
  const columnMap: Record<string, string> = {};
  const missingColumns: string[] = [];

  for (const required of REQUIRED_COLUMNS) {
    const found = findColumnHeader(firstRowKeys, required);
    if (found) {
      columnMap[required] = found;
    } else {
      missingColumns.push(required);
    }
  }

  if (missingColumns.length > 0) {
    throw new Error(
      `Missing required columns: ${missingColumns.join(", ")}. ` +
        `Found columns: ${firstRowKeys.join(", ")}. ` +
        `Expected (case-insensitive): Brand, Model, Variant, Price`
    );
  }

  const knownColumnNames = new Set(Object.values(columnMap));

  return rows.map((row, index) => {
    const brand = String(row[columnMap["brand"]] || "").trim();
    const model = String(row[columnMap["model"]] || "").trim();
    const variant = String(row[columnMap["variant"]] || "").trim();
    const price = String(row[columnMap["price"]] || "").trim();

    // Everything else goes into specs
    const specs: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      if (knownColumnNames.has(key)) continue;
      if (value !== undefined && value !== "") {
        specs[key.toLowerCase().replace(/\s+/g, "_")] = String(value).trim();
      }
    }

    return {
      rowNumber: index + 2, // +2 because row 1 is header, index is 0-based
      brand,
      model,
      variant,
      price,
      specs,
    };
  });
}
