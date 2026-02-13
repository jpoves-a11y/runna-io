// Proxy Worker - Serves Cloudflare Pages content through workers.dev
// This bypasses ISP blocking of *.pages.dev domains

const PAGES_ORIGIN = 'https://runna-io.pages.dev';

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Build the target URL on Pages
    const targetUrl = `${PAGES_ORIGIN}${url.pathname}${url.search}`;
    
    // Forward the request to Pages
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
    });

    // Clone the response and modify headers
    const newHeaders = new Headers(response.headers);
    
    // Remove any restrictive headers that might cause issues
    newHeaders.delete('x-frame-options');
    
    // Add CORS headers
    newHeaders.set('Access-Control-Allow-Origin', '*');
    
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};
