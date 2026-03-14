import { describe, it, expect } from '@jest/globals';
import { Readable } from 'node:stream';
import { parsePage } from '../parser.js';

function makeReadable(html: string): Readable {
  return Readable.from([Buffer.from(html)]);
}

describe('parsePage', () => {
  // Fixture 1: Static page with images and videos
  const staticPageHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <meta name="description" content="A test page with media" />
</head>
<body>
  <h1>Hello World</h1>
  <p>Some text content here for body text length purposes.</p>
  <img src="https://example.com/image1.jpg" alt="Image 1" />
  <img src="https://example.com/image2.png" alt="Image 2" />
  <video src="https://example.com/video1.mp4"></video>
  <source src="https://example.com/video2.webm" />
</body>
</html>`;

  it('extracts images and videos from a static page', async () => {
    const result = await parsePage(makeReadable(staticPageHtml), 'https://example.com');
    expect(result.mediaItems.length).toBe(4);
    const urls = result.mediaItems.map((m) => m.mediaUrl);
    expect(urls).toContain('https://example.com/image1.jpg');
    expect(urls).toContain('https://example.com/image2.png');
    expect(urls).toContain('https://example.com/video1.mp4');
    expect(urls).toContain('https://example.com/video2.webm');
  });

  it('extracts title and description from meta tags', async () => {
    const result = await parsePage(makeReadable(staticPageHtml), 'https://example.com');
    expect(result.title).toBe('Test Page');
    expect(result.description).toBe('A test page with media');
  });

  it('assigns correct media types', async () => {
    const result = await parsePage(makeReadable(staticPageHtml), 'https://example.com');
    const images = result.mediaItems.filter((m) => m.mediaType === 'image');
    const videos = result.mediaItems.filter((m) => m.mediaType === 'video');
    expect(images.length).toBe(2);
    expect(videos.length).toBe(2);
  });

  it('extracts alt text for images', async () => {
    const result = await parsePage(makeReadable(staticPageHtml), 'https://example.com');
    const img1 = result.mediaItems.find((m) => m.mediaUrl === 'https://example.com/image1.jpg');
    expect(img1?.altText).toBe('Image 1');
  });

  // Fixture 2: Page with relative URLs
  const relativeUrlHtml = `<!DOCTYPE html>
<html>
<head><title>Relative URLs</title></head>
<body>
  <img src="/images/photo.jpg" alt="Photo" />
  <img src="./thumb.png" alt="Thumb" />
  <video src="../videos/clip.mp4"></video>
</body>
</html>`;

  it('normalizes relative URLs to absolute', async () => {
    const result = await parsePage(makeReadable(relativeUrlHtml), 'https://example.com/page/');
    const urls = result.mediaItems.map((m) => m.mediaUrl);
    expect(urls).toContain('https://example.com/images/photo.jpg');
    expect(urls).toContain('https://example.com/page/thumb.png');
    expect(urls).toContain('https://example.com/videos/clip.mp4');
  });

  it('handles root-relative URLs', async () => {
    const result = await parsePage(makeReadable(relativeUrlHtml), 'https://example.com/page/');
    const rootRelative = result.mediaItems.find((m) => m.mediaUrl.includes('/images/photo.jpg'));
    expect(rootRelative?.mediaUrl).toBe('https://example.com/images/photo.jpg');
  });

  // Fixture 3: Page with data URIs (should be filtered)
  const dataUriHtml = `<!DOCTYPE html>
<html>
<head><title>Data URI Page</title></head>
<body>
  <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA" alt="Inline" />
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAI=" alt="GIF" />
  <img src="https://example.com/real.jpg" alt="Real" />
</body>
</html>`;

  it('filters out data URI images', async () => {
    const result = await parsePage(makeReadable(dataUriHtml), 'https://example.com');
    expect(result.mediaItems.length).toBe(1);
    expect(result.mediaItems[0]?.mediaUrl).toBe('https://example.com/real.jpg');
  });

  it('does not include data URIs in media count', async () => {
    const result = await parsePage(makeReadable(dataUriHtml), 'https://example.com');
    expect(result.spaSignals.mediaCount).toBe(1);
  });

  // Fixture 4: SPA-like page (has root div, scripts, no media)
  const spaHtml = `<!DOCTYPE html>
<html>
<head>
  <title>My App</title>
  <script>var __NEXT_DATA__ = {"props":{}}</script>
  <script src="/static/chunk1.js"></script>
  <script src="/static/chunk2.js"></script>
  <script src="/static/chunk3.js"></script>
  <script src="/static/chunk4.js"></script>
  <script src="/static/chunk5.js"></script>
  <script src="/static/main.js"></script>
</head>
<body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <div id="root"></div>
</body>
</html>`;

  it('collects SPA signals from a SPA-like page', async () => {
    const result = await parsePage(makeReadable(spaHtml), 'https://example.com');
    expect(result.spaSignals.hasRootDiv).toBe(true);
    expect(result.spaSignals.hasNextData).toBe(true);
    expect(result.spaSignals.hasNoScriptWarning).toBe(true);
    expect(result.spaSignals.scriptTagCount).toBeGreaterThan(5);
    expect(result.mediaItems.length).toBe(0);
    expect(result.spaSignals.mediaCount).toBe(0);
  });

  it('detects __NEXT_DATA__ in inline scripts', async () => {
    const result = await parsePage(makeReadable(spaHtml), 'https://example.com');
    expect(result.spaSignals.hasNextData).toBe(true);
  });

  it('detects noscript warning text', async () => {
    const result = await parsePage(makeReadable(spaHtml), 'https://example.com');
    expect(result.spaSignals.hasNoScriptWarning).toBe(true);
  });

  // Fixture 5: Page with meta title/description
  const metaPageHtml = `<!DOCTYPE html>
<html>
<head>
  <title>  Trimmed Title  </title>
  <meta name="description" content="Page description here" />
  <meta name="keywords" content="test, page" />
</head>
<body>
  <p>Content goes here with enough text to not be considered a SPA.</p>
</body>
</html>`;

  it('trims whitespace from title', async () => {
    const result = await parsePage(makeReadable(metaPageHtml), 'https://example.com');
    expect(result.title).toBe('Trimmed Title');
  });

  it('extracts description from meta tag', async () => {
    const result = await parsePage(makeReadable(metaPageHtml), 'https://example.com');
    expect(result.description).toBe('Page description here');
  });

  it('returns null title when no title tag', async () => {
    const html = '<html><head></head><body></body></html>';
    const result = await parsePage(makeReadable(html), 'https://example.com');
    expect(result.title).toBeNull();
  });

  it('returns null description when no meta description', async () => {
    const html = '<html><head><title>No Desc</title></head><body></body></html>';
    const result = await parsePage(makeReadable(html), 'https://example.com');
    expect(result.description).toBeNull();
  });

  it('detects __NUXT__ in inline scripts', async () => {
    const html = `<html><head><script>window.__NUXT__ = {}</script></head><body><div id="__nuxt"></div></body></html>`;
    const result = await parsePage(makeReadable(html), 'https://example.com');
    expect(result.spaSignals.hasNuxtData).toBe(true);
  });

  it('detects root div for various SPA root IDs', async () => {
    for (const id of ['root', 'app', '__next', '__nuxt']) {
      const html = `<html><body><div id="${id}"></div></body></html>`;
      const result = await parsePage(makeReadable(html), 'https://example.com');
      expect(result.spaSignals.hasRootDiv).toBe(true);
    }
  });

  it('filters blank src attributes', async () => {
    const html = `<html><body><img src="" alt="empty" /><img src="https://example.com/valid.jpg" /></body></html>`;
    const result = await parsePage(makeReadable(html), 'https://example.com');
    expect(result.mediaItems.length).toBe(1);
  });
});
