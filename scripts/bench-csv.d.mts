export const COLUMNS: string[];
export const BEGIN: string;
export const END: string;
export const ROW_LIMIT_MS: number;
export function csvHeader(): string;
export function csvRow(o: Record<string, string | number | boolean>): string;
export function parseCsv(text: string): Array<Record<string, string>>;
export function renderBench(rows: Array<Record<string, string>>): string;
export function summarise(rows: Array<Record<string, string>>): Array<{
  driver: string;
  rows: number;
  chunk: number;
  n: number;
  allMatch: boolean;
  allPrecise: boolean;
  totalMedian: number;
  totalWorst: number;
}>;
export function readmePath(argv: string[], repo: string): string;
export function checkBlock(
  text: string,
  begin: string,
  end: string,
  body: string,
  name: string,
): { ok: boolean; message: string };
