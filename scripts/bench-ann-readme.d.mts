export const ANN_COLUMNS: string[];
export const EIGHT_GB: string;
export const BEGIN: string;
export const END: string;
export const ANN_CSV: string;
export const ANN_NOTE: string;
export function annCsvHeader(): string;
export function annCsvRow(o: Record<string, string | number | boolean>): string;
export function parseCsv(text: string): Array<Record<string, string>>;
export function renderAnnBench(
  rows: Array<Record<string, string>>,
  note?: { oneMillion?: { statement: string } },
): string;
export function readAnnNote(path?: string): { oneMillion?: { statement: string } } | undefined;
export const ANN_DUP_COLUMNS: string[];
export const ANN_DUP_CSV: string;
export const DUP_BEGIN: string;
export const DUP_END: string;
export const LOAD_LIMIT: number;
export const UNDER_LOAD: string;
export function annDupCsvHeader(): string;
export function annDupCsvRow(o: Record<string, string | number | boolean>): string;
export function hostLoadCell(platform: string, load: number): string;
export function renderAnnDup(rows: Array<Record<string, string>>): string;
