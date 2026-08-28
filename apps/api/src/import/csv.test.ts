import { describe, it, expect } from "vitest";
import { parseCsv, mapCsvRows } from "./csv.js";

describe("parseCsv", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });
  it("handles quoted fields with commas and escaped quotes", () => {
    expect(parseCsv('name,note\n"Doe, Jane","She said ""hi"""')).toEqual([
      ["name", "note"],
      ["Doe, Jane", 'She said "hi"'],
    ]);
  });
  it("handles CRLF and a trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("mapCsvRows", () => {
  const csv = parseCsv(
    ["Date,Description,Amount,Category", "2026-02-01,Coffee,-3.50,Food", "2026-02-02,Salary,\"2,000.00\",Income"].join(
      "\n",
    ),
  );

  it("maps by header name with a signed amount column", () => {
    const { drafts, errors } = mapCsvRows(csv, {
      hasHeader: true,
      mapping: { date: "Date", payee: "Description", amount: "Amount", category: "Category" },
    });
    expect(errors).toEqual([]);
    expect(drafts).toEqual([
      { date: "2026-02-01", payee: "Coffee", amount: "-3.50", categoryId: "Food" },
      { date: "2026-02-02", payee: "Salary", amount: "2000.00", categoryId: "Income" },
    ]);
  });

  it("supports separate inflow/outflow columns and accounting negatives", () => {
    const rows = parseCsv(["date,payee,in,out", "2026-03-01,Refund,15.00,", "2026-03-02,Rent,,(1200.00)"].join("\n"));
    const { drafts } = mapCsvRows(rows, {
      hasHeader: true,
      mapping: { date: "date", payee: "payee", inflow: "in", outflow: "out" },
    });
    expect(drafts.map((d) => d.amount)).toEqual(["15.00", "-1200.00"]);
  });

  it("collects a per-row error for a bad date and keeps good rows", () => {
    const rows = parseCsv(["2026-04-01,Ok,-1.00", "04/02/2026,Bad,-2.00"].join("\n"));
    const { drafts, errors } = mapCsvRows(rows, {
      hasHeader: false,
      mapping: { date: 0, payee: 1, amount: 2 },
    });
    expect(drafts).toHaveLength(1);
    expect(errors[0]).toMatchObject({ row: 2 });
    expect(errors[0]!.message).toContain("YYYY-MM-DD");
  });

  it("throws if the mapping has no amount source", () => {
    expect(() => mapCsvRows(csv, { hasHeader: true, mapping: { date: "Date", payee: "Description" } })).toThrow();
  });
});
