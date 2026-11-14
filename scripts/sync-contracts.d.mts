// Type declarations for scripts/sync-contracts.mjs (used by test/contracts-sync.test.ts).
export interface ContractEntry {
  file: string;
  source: string;
  target: string;
  header: string;
}
export type SyncStatus =
  'source-missing' | 'in-sync' | 'updated' | 'drift' | 'sha-mismatch' | 'sha-missing' | 'blocked';
export interface SyncResult {
  file: string;
  target: string;
  status: SyncStatus;
}
export interface SpecLandedLocation {
  path: string;
  source: 'env' | 'evidence';
  /** True only for source 'env' when SPEC_LANDED names a file that does not exist. */
  missing?: true;
}
export const DEFAULT_SPEC_DIR: string;
export const DEFAULT_OUT_DIR: string;
export const DEFAULT_EVIDENCE_ROOT: string;
export const CONTRACT_VERSIONS: Record<string, string>;
export const CONTRACT_FILES: string[];
export const CONTRACTS: ContractEntry[];
export function header(file: string): string;
export function vendoredBody(text: string): string;
export function parseLanded(text: string): Map<string, string>;
export function findSpecLanded(opts?: {
  env?: Record<string, string | undefined>;
  repo?: string;
  evidenceRoot?: string;
  exists?: (p: string) => boolean;
  list?: (dir: string) => string[];
}): SpecLandedLocation | undefined;
export function sync(opts?: {
  specDir?: string;
  outDir?: string;
  write?: boolean;
  landed?: Map<string, string>;
}): SyncResult[];
