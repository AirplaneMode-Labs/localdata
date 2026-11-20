export const repoRoot: string;
export const WASM_SIZE_CSV: string;
export const GEN: string;
export const BUDGET_BYTES: number;
export const COMMAND: string;
export const WASM_SIZE_COLUMNS: string[];
export function wasmSizeHeader(): string;
export function wasmSizeRow(o: Record<string, string | number | boolean>): string;
export function parseCsv(text: string): Array<Record<string, string>>;
export function readModules(path?: string): { simd: Buffer; scalar: Buffer };
export function measure(modules?: {
  simd: Buffer;
  scalar: Buffer;
}): Array<Record<string, string | number | boolean>>;
export function checkCsv(
  rows: Array<Record<string, string>>,
  built?: { simd: Buffer; scalar: Buffer },
): string[];
