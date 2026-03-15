import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

// ---------------------------------------------------------------------------
// URL pool — loaded from CSV at init time (shared across all VUs)
// Override with: k6 run k6-scrape.js -e CSV_FILE=./my-urls.csv
// ---------------------------------------------------------------------------
const CSV_FILE = __ENV.CSV_FILE || './wiki-100.csv';
const URLS_PER_JOB = parseInt(__ENV.URLS_PER_JOB || '10', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || '500', 10);

const allUrls = new SharedArray('urls', function () {
  // Skip header row, drop blank lines
  return open(CSV_FILE)
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
});

export const options = {
  stages: [
    { duration: '30s', target: MAX_VUS },   // ramp to MAX_VUS
    { duration: '60s', target: MAX_VUS },   // hold
    { duration: '10s', target: 0 },         // ramp down
  ],
  thresholds: {
    // POST p95 < 500ms under 500 concurrent clients
    'http_req_duration{name:post_scrape}': ['p(95)<500'],
    // Error rate < 0.5%
    http_req_failed: ['rate<0.005'],
    // All jobs must reach terminal status within 120s (>99.5% success rate)
    'checks{check:job completed within 120s}': ['rate>0.995'],
  },
};

const API_BASE = __ENV.API_BASE || 'http://localhost:3001';

/** Pick `count` URLs starting at a random offset (wraps around). */
function pickUrls(count) {
  const start = Math.floor(Math.random() * allUrls.length);
  const urls = [];
  for (let i = 0; i < count; i++) {
    urls.push(allUrls[(start + i) % allUrls.length]);
  }
  return urls;
}

export default function () {
  const urls = pickUrls(URLS_PER_JOB);

  // POST /api/scrape
  const postRes = http.post(
    `${API_BASE}/api/scrape`,
    JSON.stringify({ urls, options: { browserFallback: false } }),
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
