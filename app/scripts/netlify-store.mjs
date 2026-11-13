/**
 * A Netlify blob store held in memory: one document per key, answered over a fixed etag, the keys
 * under a prefix, a delete. The document store, the registry and the community function all talk to
 * this shape, so this is the store the three tests that drive them are given.
 */
export function memoryStore() {
  const data = new Map()
  return {
    data,
    async getWithMetadata(key) {
      return data.has(key) ? { data: structuredClone(data.get(key)), etag: "e" } : null
    },
    async setJSON(key, value) {
      data.set(key, structuredClone(value))
      return { modified: true, etag: "e" }
    },
    async delete(key) {
      data.delete(key)
    },
    async list({ prefix }) {
      return {
        blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
      }
    },
  }
}
