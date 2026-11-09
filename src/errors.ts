import { StorageError, type Primitive } from './contracts/storage-api';

export { StorageError };

/** True for the browser's storage-quota DOMException in any of its spellings. */
export function isQuotaError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  const code = (e as { code?: unknown }).code;
  return name === 'QuotaExceededError' || code === 22 || code === 1014;
}

/**
 * Maps whatever a driver or the platform threw to a StorageError. StorageErrors pass through,
 * quota DOMExceptions become quota_exceeded, everything else becomes io with the cause message.
 */
export function toStorageError(e: unknown, context: string): StorageError {
  if (e instanceof StorageError) return e;
  if ((e as { name?: unknown } | null)?.name === 'StorageError') return e as StorageError;
  if (isQuotaError(e)) {
    return new StorageError(
      'quota_exceeded',
      `${context}: the browser reported its storage quota is exceeded`,
      {
        cause: errorMessage(e),
      },
    );
  }
  const details: Record<string, Primitive> = { cause: errorMessage(e) };
  const name = (e as { name?: unknown } | null)?.name;
  if (typeof name === 'string') details['causeName'] = name;
  return new StorageError('io', `${context}: ${errorMessage(e)}`, details);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && 'message' in e)
    return String((e as { message: unknown }).message);
  return String(e);
}
