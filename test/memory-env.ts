// A PersistEnv over the memory driver: storage that survives a store being closed and opened again.
import { createStore } from '../src/index';
import { MemoryDriver } from '../src/drivers/memory';
import type { PersistEnv } from './persist-env';

export function memoryPersistEnv(): PersistEnv {
  let driver = new MemoryDriver();
  return {
    makeStore: async (opts) => {
      driver = new MemoryDriver();
      return createStore({ driver, ...(opts ?? {}) });
    },
    reopen: async (opts) => createStore({ driver, ...(opts ?? {}) }),
    raw: async () => {
      await driver.open();
      return driver;
    },
  };
}
