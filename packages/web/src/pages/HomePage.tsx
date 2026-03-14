import type React from 'react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { JobStatus } from '../components/JobStatus.js';
import { useJobStatus } from '../hooks/useJobStatus.js';

export function HomePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [urlsText, setUrlsText] = useState('');
  const [browserFallback, setBrowserFallback] = useState(false);
  const [maxScrollDepth, setMaxScrollDepth] = useState(10);
  const [jobId, setJobId] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: jobStatusData } = useJobStatus(jobId);

  useEffect(() => {
    if (jobStatusData?.status === 'done' && jobId) {
      navigate(`/gallery?jobId=${encodeURIComponent(jobId)}`);
    }
  }, [jobStatusData?.status, jobId, navigate]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError(null);

    const urls = urlsText
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urls.length === 0) {
      setError('Please enter at least one URL.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await api.scrape(urls, { browserFallback, maxScrollDepth });
      setJobId(result.jobId);
    } catch {
      setError('Failed to start scrape job. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-900">Media Scraper</h1>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            <div>
              <label htmlFor="urls" className="block text-sm font-medium text-gray-700 mb-1">
                Enter URLs to scrape (one per line):
              </label>
              <textarea
                id="urls"
                rows={6}
                value={urlsText}
                onChange={(e) => setUrlsText(e.target.value)}
                placeholder="https://example.com&#10;https://another.com"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
                disabled={isSubmitting || jobId !== null}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="browserFallback"
                checked={browserFallback}
                onChange={(e) => setBrowserFallback(e.target.checked)}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                disabled={isSubmitting || jobId !== null}
              />
              <label htmlFor="browserFallback" className="text-sm text-gray-700">
                Browser fallback (for SPAs)
              </label>
            </div>

            {browserFallback && (
              <div className="flex items-center gap-2">
                <label htmlFor="maxScrollDepth" className="text-sm text-gray-700">
                  Max scroll depth:
                </label>
                <input
                  type="number"
                  id="maxScrollDepth"
                  min={1}
                  max={60}
                  value={maxScrollDepth}
                  onChange={(e) => setMaxScrollDepth(Number(e.target.value))}
                  className="w-20 rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={isSubmitting || jobId !== null}
                />
              </div>
            )}

            {error && (
              <p className="text-sm text-red-600">{error}</p>
            )}

            <button
              type="submit"
              disabled={isSubmitting || jobId !== null}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? 'Starting...' : 'Scrape URLs'}
            </button>
          </form>
        </div>

        {jobId && <JobStatus data={jobStatusData ?? null} />}
      </main>
    </div>
  );
}
