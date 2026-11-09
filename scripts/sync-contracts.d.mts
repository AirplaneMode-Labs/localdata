// Type declarations for scripts/sync-contracts.mjs (used by test/contracts-sync.test.ts).
export interface ContractEntry {
  source: string;
  target: string;
  header: string;
}
export interface SyncResult {
  target: string;
  status: 'source-missing' | 'in-sync' | 'updated' | 'drift';
}
export const CONTRACTS: ContractEntry[];
export function vendoredBody(text: string): string;
export function sync(opts?: { write?: boolean }): SyncResult[];
