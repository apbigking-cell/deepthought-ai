// HTTP GET 请求
export const webSearchDef = {
  name: 'web_search',
  description: 'Make an HTTP GET request to a URL and return the response body (truncated).',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
    },
    required: ['url'],
  },
};

export async function webSearchHandler(args) {
  const url = args.url || '';
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    throw new Error('Only http/https URLs are allowed');
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BrainAgent/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const text = await res.text();
  // 去除HTML标签的简单处理
  const stripped = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.slice(0, 5000);
}
