import { describe, it, expect } from "vitest";
import { parseOfx } from "./ofx.js";

const SGML = `OFXHEADER:100
DATA:OFXSGML

<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>USD
<BANKTRANLIST>
<DTSTART>20260601
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260601120000<TRNAMT>-12.34<FITID>F1<NAME>STARBUCKS</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260603<TRNAMT>2000.00<FITID>F2<NAME>ACME PAYROLL</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

const XML = `<?xml version="1.0"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260604</DTPOSTED><TRNAMT>-5.00</TRNAMT><FITID>F3</FITID><NAME>SHELL</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("parseOfx", () => {
  it("parses SGML (unclosed leaf tags)", () => {
    const { transactions, errors } = parseOfx(SGML);
    expect(errors).toEqual([]);
    expect(transactions).toEqual([
      { fitid: "F1", date: "2026-06-01", amount: "-12.34", payee: "STARBUCKS" },
      { fitid: "F2", date: "2026-06-03", amount: "2000.00", payee: "ACME PAYROLL" },
    ]);
  });

  it("parses XML 2.x (closed tags)", () => {
    const { transactions } = parseOfx(XML);
    expect(transactions).toEqual([{ fitid: "F3", date: "2026-06-04", amount: "-5.00", payee: "SHELL" }]);
  });

  it("falls back to MEMO when NAME is absent and records bad-date errors", () => {
    const ofx = [
      "<STMTTRN><DTPOSTED>20260610<TRNAMT>-1.00<FITID>F4<MEMO>Corner Store</STMTTRN>",
      "<STMTTRN><DTPOSTED>notadate<TRNAMT>-2.00<FITID>F5<NAME>Bad</STMTTRN>",
    ].join("\n");
    const { transactions, errors } = parseOfx(ofx);
    expect(transactions).toEqual([{ fitid: "F4", date: "2026-06-10", amount: "-1.00", payee: "Corner Store" }]);
    expect(errors[0]).toMatchObject({ index: 2 });
  });

  it("returns nothing for input with no transactions", () => {
    expect(parseOfx("<OFX></OFX>").transactions).toEqual([]);
  });
});
