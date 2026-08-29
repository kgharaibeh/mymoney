/**
 * OFX / QFX import. OFX is the format banks and Quicken (QFX is Quicken's OFX
 * variant) export. Older files are SGML with unclosed leaf tags
 * (`<TRNAMT>-12.34<FITID>...`); newer 2.x files are real XML with closed tags.
 * This lenient parser handles both: aggregate elements (STMTTRN) keep their
 * closing tag, and each leaf value is read as the text up to the next tag or
 * line break — which is correct for SGML and XML alike.
 */

export interface OfxTransaction {
  /** Financial-institution transaction id — a stable dedupe key when present. */
  fitid: string;
  date: string; // YYYY-MM-DD
  amount: string; // signed decimal, e.g. "-12.34"
  payee: string;
}

export interface OfxParseResult {
  transactions: OfxTransaction[];
  errors: Array<{ index: number; message: string }>;
}

export function parseOfx(text: string): OfxParseResult {
  const transactions: OfxTransaction[] = [];
  const errors: Array<{ index: number; message: string }> = [];

  const blocks = text.match(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi) ?? [];
  blocks.forEach((block, i) => {
    const field = (tag: string): string => {
      const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
      return m ? m[1].trim() : "";
    };
    try {
      const date = ofxDate(field("DTPOSTED") || field("DTUSER"));
      const amount = field("TRNAMT");
      if (!amount) throw new Error("missing TRNAMT");
      const payee = field("NAME") || field("MEMO") || "Unknown";
      transactions.push({ fitid: field("FITID"), date, amount, payee });
    } catch (err) {
      errors.push({ index: i + 1, message: (err as Error).message });
    }
  });

  return { transactions, errors };
}

/** OFX dates look like YYYYMMDD or YYYYMMDDHHMMSS[.xxx][TZ]; take the date part. */
function ofxDate(raw: string): string {
  const m = /(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (!m) throw new Error(`unparseable OFX date "${raw}"`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}
