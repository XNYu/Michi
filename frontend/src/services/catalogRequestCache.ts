/** Renderer-lifetime snapshots; durable model discovery remains owned by the backend. */
export function createCatalogRequestCache<T>(canCache: (value: T) => boolean = () => true) {
  const snapshots = new Map<string, T>();
  const requests = new Map<string, Promise<T>>();
  return {
    load(key: string, fetchCatalog: () => Promise<T>, refresh = false): Promise<T> {
      const pending = requests.get(key);
      if (pending) return pending;
      if (!refresh && snapshots.has(key)) return Promise.resolve(snapshots.get(key)!);
      const request = fetchCatalog().then((value) => {
        if (canCache(value)) snapshots.set(key, value);
        return value;
      }).finally(() => {
        if (requests.get(key) === request) requests.delete(key);
      });
      requests.set(key, request);
      return request;
    },
  };
}
