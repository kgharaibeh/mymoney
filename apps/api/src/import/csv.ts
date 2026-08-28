/**
 * CSV import: a small RFC-4180-ish parser plus a column mapper that turns bank
 * export rows into draft transactions. Pure and dependency-free so it is easy
 * to test; persistence and dedupe happen in AppService.importCsv.
 */

/** Parse CSV text into rows of string fields (handles quotes, commas, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let started = false; // did the current row have any content?

  const endField = () => {
    row.push(field);
    field = "";
    started = true;
  };
  const endRow = () => {
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") endField();
    else if (c === "\r") continue;
    else if (c === "\n") {
      endField();
      endRow();
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field.length > 0) {
    endField();
    endRow();
  }

  // Drop blank lines (a single empty field).
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** Column reference: a 0-based index, or a header name (needs hasHeader). */
export type ColumnRef = string | number;

export interface CsvMapping {
  date: ColumnRef;
  payee: ColumnRef;
  /** A single signed amount column... */
  amount?: ColumnRef;
  /** ...or separate positive inflow / outflow columns. */
  inflow?: ColumnRef;
  outflow?: ColumnRef;
  category?: ColumnRef;
}

export interface CsvImportOptions {
  hasHeader?: boolean;
  mapping: CsvMapping;
}

export interface DraftTransaction {
  date: string; // YYYY-MM-DD
  amount: string; // signed decimal string
  payee: string;
  categoryId?: string;
}

export interface RowError {
  row: number; // 1-based row number in the source file
  message: string;
}

/** Map parsed CSV rows to draft transactions, collecting per-row errors. */
export function mapCsvRows(
  rows: string[][],
  opts: CsvImportOptions,
): { drafts: DraftTransaction[]; errors: RowError[] } {
  const { mapping } = opts;
  if (!mapping.amount && !mapping.inflow && !mapping.outflow) {
    throw new Error("CSV mapping must specify either `amount` or `inflow`/`outflow`.");
  }

  let header: string[] | null = null;
  let dataRows = rows;
  let baseRowNumber = 1;
  if (opts.hasHeader) {
    header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
    dataRows = rows.slice(1);
    baseRowNumber = 2;
  }

  const resolve = (ref: ColumnRef): number => {
    if (typeof ref === "number") return ref;
    if (!header) throw new Error(`Column "${ref}" given by name but the file has no header row.`);
    const idx = header.indexOf(ref.trim().toLowerCase());
    if (idx === -1) throw new Error(`Column "${ref}" not found in the header.`);
    return idx;
  };

  const col = {
    date: resolve(mapping.date),
    payee: resolve(mapping.payee),
    amount: mapping.amount !== undefined ? resolve(mapping.amount) : null,
    inflow: mapping.inflow !== undefined ? resolve(mapping.inflow) : null,
    outflow: mapping.outflow !== undefined ? resolve(mapping.outflow) : null,
    category: mapping.category !== undefined ? resolve(mapping.category) : null,
  };

  const drafts: DraftTransaction[] = [];
  const errors: RowError[] = [];

  dataRows.forEach((r, i) => {
    const rowNumber = baseRowNumber + i;
    try {
      const date = normalizeDate((r[col.date] ?? "").trim());
      const payee = (r[col.payee] ?? "").trim();
      const amount = computeAmount(r, col);
      const draft: DraftTransaction = { date, amount, payee };
      if (col.category !== null) {
        const cat = (r[col.category] ?? "").trim();
        if (cat) draft.categoryId = cat;
      }
      drafts.push(draft);
    } catch (err) {
      errors.push({ row: rowNumber, message: (err as Error).message });
    }
  });

  return { drafts, errors };
}

function computeAmount(
  r: string[],
  col: { amount: number | null; inflow: number | null; outflow: number | null },
): string {
  if (col.amount !== null) {
    const raw = (r[col.amount] ?? "").trim();
    if (!raw) throw new Error("Empty amount.");
    return normalizeAmount(raw);
  }
  const inflow = col.inflow !== null ? (r[col.inflow] ?? "").trim() : "";
  const outflow = col.outflow !== null ? (r[col.outflow] ?? "").trim() : "";
  if (inflow) return normalizeAmount(inflow);
  if (outflow) return "-" + normalizeAmount(outflow).replace(/^-/, "");
  throw new Error("Row has neither an inflow nor an outflow amount.");
}

/** Normalize a money cell to a signed decimal string, or throw. */
function normalizeAmount(raw: string): string {
  let s = raw.trim();
  let negative = false;
  // Accounting negatives: (123.45)
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^0-9.,+-]/g, ""); // strip currency symbols/spaces
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  s = s.replace(/,/g, ""); // remove thousands separators
  if (!/^\d*\.?\d+$|^\d+\.?\d*$/.test(s)) throw new Error(`Unparseable amount: "${raw}"`);
  return (negative ? "-" : "") + s;
}

/** Accept ISO YYYY-MM-DD; throw on anything else (keeps Phase 0 unambiguous). */
function normalizeDate(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`Date "${raw}" must be ISO format YYYY-MM-DD.`);
  }
  return raw;
}
