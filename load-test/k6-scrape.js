import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 5000 },  // ramp to 5000 VUs
    { duration: '60s', target: 5000 },  // hold
    { duration: '10s', target: 0 },     // ramp down
  ],
  thresholds: {
    // POST p95 < 500ms under 5000 concurrent clients
    'http_req_duration{name:post_scrape}': ['p(95)<500'],
    // Error rate < 0.5%
    http_req_failed: ['rate<0.005'],
  },
};

// 5 static URLs to scrape per VU (these are example placeholder URLs — note they won't resolve in a real test)
const STATIC_URLS = [
  'https://example.com/page1',
  'https://example.com/page2',
  'https://example.com/page3',
  'https://example.com/page4',
  'https://example.com/page5',
];

const API_BASE = __ENV.API_BASE || 'http://localhost:3001';

export default function () {
  // POST /api/scrape
  const postRes = http.post(
    `${API_BASE}/api/scrape`,
    JSON.stringify({ urls: STATIC_URLS, options: { browserFallback: false } }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'post_scrape' },
    }
  );

  check(postRes, {
    'POST /api/scrape returns 202': (r) => r.status === 202,
    'response has jobId': (r) => {
      try { return !!JSON.parse(r.body).jobId; } catch { return false; }
    },
  });

  if (postRes.status !== 202) return;

  const { jobId } = JSON.parse(postRes.body);

  // Poll until done (max 120s)
  let done = false;
  let attempts = 0;
  while (!done && attempts < 60) {
    sleep(2);
    const statusRes = http.get(`${API_BASE}/api/scrape/${jobId}`, {
      tags: { name: 'get_status' },
    });
    check(statusRes, { 'GET status returns 200': (r) => r.status === 200 });
    try {
      const body = JSON.parse(statusRes.body);
      done = body.status === 'done' || body.status === 'failed';
    } catch {
      // ignore parse error
    }
    attempts++;
  }

  check({ done }, { 'job completed within 120s': (d) => d.done === true });
}
