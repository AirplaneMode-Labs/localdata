type Rows = Array<Record<string, string>>;

export interface Inputs {
  root: string;
  files: string[];
  sizes: Record<string, number>;
  texts: Record<string, string>;
  csv: Record<string, Rows>;
  notes: Record<string, unknown>;
  rustTests: Record<string, string>;
  sources: Record<string, string>;
  pkg: { scripts?: Record<string, string> };
}

export interface RegisterEntry {
  id: string;
  source: string;
  docs: string[];
  tokens: string[];
  phrases?: string[];
  checks?: Array<[string, boolean]>;
}

export interface NotKeptFigure {
  id: string;
  tokens: string[];
  docs: string[];
  why: string;
}

export interface IndexRow {
  file: string;
  status: string;
  date: string;
  commit: string;
  machine: string;
}

export const repoRoot: string;
export const NOT_KEPT: string;
export const STANDING_LINE: string;
export const INDEX_STATUSES: string[];
export const SOURCE_NEEDLES: Array<[string, string, RegExp]>;
export const FLOORS: Array<{ pattern: RegExp; reason: string }>;
export const CONSTANTS: Array<{ pattern: RegExp; reason: string }>;
export const NOT_KEPT_FIGURES: NotKeptFigure[];
export function parseCsv(text: string): Rows;
export function loadInputs(root?: string): Inputs;
export function prose(rel: string, text: string): string;
export function figureTokens(
  text: string,
  options?: { decimals?: boolean },
): Array<{ token: string; start: number; end: number }>;
export function register(d: Inputs): RegisterEntry[];
export function checkFigures(d: Inputs): string[];
export function checkIndex(d: Inputs): string[];
export function parseIndex(md: string): {
  table: IndexRow[];
  sections: Record<
    string,
    {
      what: string | undefined;
      method: string | undefined;
      reproduce: string | undefined;
      quotedIn: string | undefined;
    }
  >;
  notKept: string | undefined;
  standing: boolean;
  eightGb: boolean;
};
