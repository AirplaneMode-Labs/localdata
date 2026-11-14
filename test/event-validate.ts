// Test-only validators for the Event contract 0.1.2. eventProblems() checks one event against the
// constants of the vendored src/contracts/event.ts (so a vendoring drift fails here); schemaProblems()
// is a small JSON Schema 2020-12 subset evaluator (const, enum, type, pattern, minimum, minLength,
// maxLength, maxProperties, propertyNames.pattern, required, properties, additionalProperties as
// false or a schema, anyOf) used to check events against the sibling's event.schema.json when
// ../runtime/spec exists. No dependency is added for either.
import {
  EVENT_ATTRS_MAX_KEYS,
  EVENT_ATTR_KEY_PATTERN,
  EVENT_ATTR_STRING_MAX,
  EVENT_FORBIDDEN_KEY_PATTERN,
  EVENT_NAME_PATTERN,
  EVENT_SOURCE_PATTERN,
  EVENT_SPEC,
  STORAGE_EVENT_NAMES,
} from '../src/contracts/event';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KINDS = ['log', 'timing', 'memory', 'model-load', 'asset', 'error'];
const LEVELS = ['debug', 'info', 'warn', 'error'];
const TOP_KEYS = [
  'spec',
  'id',
  'ts',
  'mono',
  'session',
  'source',
  'kind',
  'name',
  'level',
  'durationMs',
  'bytes',
  'attrs',
];

/** Every way `e` violates Event 0.1.2 (empty when valid). */
export function eventProblems(e: unknown): string[] {
  const p: string[] = [];
  if (typeof e !== 'object' || e === null || Array.isArray(e)) return ['not an object'];
  const o = e as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!TOP_KEYS.includes(k)) p.push(`unknown top-level key ${k}`);
  if (o['spec'] !== EVENT_SPEC) p.push('spec');
  if (typeof o['id'] !== 'string' || !UUID_V4.test(o['id'])) p.push('id is not a UUID v4');
  if (!Number.isInteger(o['ts']) || (o['ts'] as number) < 0) p.push('ts');
  if (o['mono'] !== undefined && !(typeof o['mono'] === 'number' && o['mono'] >= 0)) p.push('mono');
  if (typeof o['session'] !== 'string' || o['session'].length < 1 || o['session'].length > 64)
    p.push('session');
  if (typeof o['source'] !== 'string' || !EVENT_SOURCE_PATTERN.test(o['source'])) p.push('source');
  if (!KINDS.includes(o['kind'] as string)) p.push('kind');
  if (typeof o['name'] !== 'string' || !EVENT_NAME_PATTERN.test(o['name'])) p.push('name');
  if (!LEVELS.includes(o['level'] as string)) p.push('level');
  if (
    o['durationMs'] !== undefined &&
    !(
      typeof o['durationMs'] === 'number' &&
      Number.isFinite(o['durationMs']) &&
      o['durationMs'] >= 0
    )
  )
    p.push('durationMs');
  if (o['bytes'] !== undefined && !(Number.isInteger(o['bytes']) && (o['bytes'] as number) >= 0))
    p.push('bytes');
  const attrs = o['attrs'];
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) {
    p.push('attrs is not a flat object');
  } else {
    const keys = Object.keys(attrs);
    if (keys.length > EVENT_ATTRS_MAX_KEYS) p.push('attrs has too many keys');
    for (const k of keys) {
      if (!EVENT_ATTR_KEY_PATTERN.test(k)) p.push(`attr key ${k}`);
      if (EVENT_FORBIDDEN_KEY_PATTERN.test(k)) p.push(`forbidden attr key ${k}`);
      const v = (attrs as Record<string, unknown>)[k];
      const okValue =
        (typeof v === 'string' && v.length <= EVENT_ATTR_STRING_MAX) ||
        (typeof v === 'number' && Number.isFinite(v)) ||
        typeof v === 'boolean' ||
        v === null;
      if (!okValue) p.push(`attr ${k} has an invalid value`);
    }
  }
  if (typeof o['name'] === 'string' && o['name'].startsWith('storage.')) {
    if (!(STORAGE_EVENT_NAMES as readonly string[]).includes(o['name']))
      p.push('unknown storage.* name');
    if (o['source'] !== 'localdata') p.push('storage.* source is not localdata');
  }
  return p;
}

type Schema = Record<string, unknown>;

/** Problems found evaluating `value` against `schema` (a JSON Schema subset, see the file header). */
export function schemaProblems(schema: Schema, value: unknown, at = '$'): string[] {
  const out: string[] = [];
  if ('const' in schema && value !== schema['const']) out.push(`${at}: const`);
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) out.push(`${at}: enum`);
  const type = schema['type'];
  if (typeof type === 'string' && !typeMatches(type, value)) {
    out.push(`${at}: type ${type}`);
    return out;
  }
  if (typeof value === 'string') {
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(value))
      out.push(`${at}: pattern`);
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength'])
      out.push(`${at}: minLength`);
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength'])
      out.push(`${at}: maxLength`);
  }
  if (
    typeof value === 'number' &&
    typeof schema['minimum'] === 'number' &&
    value < schema['minimum']
  )
    out.push(`${at}: minimum`);
  if (Array.isArray(schema['anyOf'])) {
    const ok = (schema['anyOf'] as Schema[]).some((s) => schemaProblems(s, value, at).length === 0);
    if (!ok) out.push(`${at}: anyOf`);
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (typeof schema['maxProperties'] === 'number' && keys.length > schema['maxProperties'])
      out.push(`${at}: maxProperties`);
    for (const r of (schema['required'] as string[] | undefined) ?? [])
      if (!(r in o)) out.push(`${at}: required ${r}`);
    const names = schema['propertyNames'] as { pattern?: string } | undefined;
    if (names?.pattern !== undefined)
      for (const k of keys)
        if (!new RegExp(names.pattern, 'u').test(k)) out.push(`${at}: propertyNames ${k}`);
    const props = (schema['properties'] as Record<string, Schema> | undefined) ?? {};
    for (const k of keys) {
      const sub = props[k];
      if (sub !== undefined) out.push(...schemaProblems(sub, o[k], `${at}.${k}`));
      else if (schema['additionalProperties'] === false)
        out.push(`${at}: additional property ${k}`);
      else if (typeof schema['additionalProperties'] === 'object' && schema['additionalProperties'])
        out.push(...schemaProblems(schema['additionalProperties'] as Schema, o[k], `${at}.${k}`));
    }
  }
  return out;
}

function typeMatches(type: string, v: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'integer':
      return Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'null':
      return v === null;
    default:
      return false;
  }
}
