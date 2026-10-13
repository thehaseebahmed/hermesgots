/** One server and key: bots that share both share a stream, a cache entry and a poll. */
export const connectionKey = (server: { baseUrl: string; apiKey: string }) =>
  `${server.baseUrl.trim().replace(/\/+$/, "")}\n${server.apiKey}`
