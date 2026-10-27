import { getStore } from '@netlify/blobs';

const CORS = { 'Access-Control-Allow-Origin': '*' };

// Serves the latest snapshot written by gp-refresh. The CDN cache means this function itself
// is invoked rarely (durable cache shares one response across edge nodes).
export default async () => {
  const body = await getStore('gp').get('snapshot', { type: 'text' });
  if (!body) {
    return new Response(JSON.stringify({ error: 'snapshot not ready yet' }), {
      status: 503,
      headers: { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '300', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(body, {
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Netlify-CDN-Cache-Control': 'public, max-age=3600, stale-while-revalidate=7200, durable',
    },
  });
};

export const config = { path: '/api/gp' };
