export const COLUMNS: string[];
export const BEGIN: string;
export const END: string;
export const EIGHT_GB: string;
export const OPERATIONS: string[];
export function csvHeader(): string;
export function csvRow(o: Record<string, string | number | boolean>): string;
export function parseCsv(text: string): Array<Record<string, string>>;
export function renderDocsBench(rows: Array<Record<string, string>>): string;
export function summarise(rows: Array<Record<string, string>>): Array<{
  driver: string;
  operation: string;
  n: number;
  allMatch: boolean;
}>;
