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
