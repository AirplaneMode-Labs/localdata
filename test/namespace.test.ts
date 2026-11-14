// D4-01: the '__ld_' prefix is reserved for the SDK's own namespaces ('__ld_meta' accounting,
// '__ld_vec.<ns>' vector indexes). Callers can never name one.
import { describe, expect, it } from 'vitest';
import { createStore, validateNamespace } from '../src/index';

describe('reserved namespace prefix __ld_', () => {
  it('validateNamespace rejects every name starting with __ld_', () => {
    for (const ns of ['__ld_meta', '__ld_vec.docs', '__ld_', '__ld_x', '__ld_vec.__ld_vec.docs']) {
      expect(() => validateNamespace(ns), ns).toThrowError(
        expect.objectContaining({ name: 'StorageError', code: 'invalid_namespace' }),
      );
    }
  });

  it('still accepts ordinary names, including ones that merely contain ld', () => {
    for (const ns of ['docs', 'ld', 'a__ld_b', 'vec.docs', 'ld_vec', '0']) {
      expect(() => validateNamespace(ns), ns).not.toThrow();
    }
  });

  it('set, get, delete, list, usage, clear and query refuse a reserved namespace', async () => {
    const store = await createStore({ driver: 'memory' });
    const ns = '__ld_vec.docs';
    const bad = { code: 'invalid_namespace' };
    await expect(store.set(ns, 'k', 1)).rejects.toMatchObject(bad);
    await expect(store.get(ns, 'k')).rejects.toMatchObject(bad);
    await expect(store.delete(ns, 'k')).rejects.toMatchObject(bad);
    await expect(store.list(ns)).rejects.toMatchObject(bad);
    await expect(store.usage(ns)).rejects.toMatchObject(bad);
    await expect(store.clear(ns)).rejects.toMatchObject(bad);
    await expect(store.query(ns, new Float32Array(2), 1)).rejects.toMatchObject(bad);
    await store.close();
  });

  it('the rejection does not echo the namespace into details beyond the string already passed', async () => {
    try {
      validateNamespace('__ld_meta');
      expect.unreachable();
    } catch (e) {
      expect((e as { details?: Record<string, unknown> }).details).toEqual({ ns: '__ld_meta' });
    }
  });
});
