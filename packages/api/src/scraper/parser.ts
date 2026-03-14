import { Parser } from 'htmlparser2';
import { pipeline } from 'node:stream/promises';
import { Writable, Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import type { ParsedPage, SpaSignals, MediaType } from '../types/index.js';
import { MAX_BODY_BYTES } from './http-client.js';

interface MediaItem {
  mediaUrl: string;
  mediaType: MediaType;
  altText: string | null;
}

function normalizeUrl(src: string, baseUrl: string): string | null {
  if (!src || src.startsWith('data:')) return null;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}

function extractMediaSrc(
  attribs: Record<string, string>,
  baseUrl: string,
): string | null {
  const candidates = [
    attribs['src'],
    attribs['data-src'],
    attribs['data-lazy'],
    attribs['data-original'],
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '') {
      const normalized = normalizeUrl(candidate, baseUrl);
      if (normalized !== null) return normalized;
    }
  }
  return null;
}

/**
 * Parse an HTML page body using htmlparser2 SAX streaming.
 * Collects media items and SPA signals in a single pass.
 */
export async function parsePage(body: Readable, baseUrl: string): Promise<ParsedPage> {
  const mediaItems: MediaItem[] = [];
  const signals: SpaSignals = {
    hasRootDiv: false,
    hasNextData: false,
    hasNuxtData: false,
    hasNoScriptWarning: false,
    bodyTextLength: 0,
    scriptTagCount: 0,
    mediaCount: 0,
  };

  let title: string | null = null;
  let description: string | null = null;
  let inTitle = false;
  let inScript = false;
  let inStyle = false;
  let inNoscript = false;
  let titleBuffer = '';
  let scriptBuffer = '';
  let noscriptBuffer = '';

  const parser = new Parser({
    onopentag(name: string, attribs: Record<string, string>) {
      const lname = name.toLowerCase();

      if (lname === 'title') {
        inTitle = true;
        titleBuffer = '';
      }

      if (lname === 'meta') {
        const metaName = (attribs['name'] ?? '').toLowerCase();
        if (metaName === 'description' && attribs['content'] !== undefined) {
          description = attribs['content'];
        }
      }

      if (lname === 'script') {
        signals.scriptTagCount++;
        inScript = true;
        scriptBuffer = '';
      }

      if (lname === 'style') {
        inStyle = true;
      }

      if (lname === 'noscript') {
        inNoscript = true;
        noscriptBuffer = '';
      }

      if (lname === 'div') {
        const id = (attribs['id'] ?? '').toLowerCase();
        if (id === 'root' || id === 'app' || id === '__next' || id === '__nuxt') {
          signals.hasRootDiv = true;
        }
      }

      if (lname === 'img') {
        const src = extractMediaSrc(attribs, baseUrl);
        if (src !== null) {
          mediaItems.push({
            mediaUrl: src,
            mediaType: 'image',
            altText: attribs['alt'] ?? null,
          });
        }
      }

      if (lname === 'video' || lname === 'source') {
        const src = extractMediaSrc(attribs, baseUrl);
        if (src !== null) {
          mediaItems.push({
            mediaUrl: src,
            mediaType: 'video',
            altText: null,
          });
        }
      }
    },

    ontext(text: string) {
      if (inTitle) {
        titleBuffer += text;
      }
      if (inScript) {
        scriptBuffer += text;
      }
      if (inNoscript) {
        noscriptBuffer += text;
      }
      // Accumulate visible text length (rough estimate), excluding script/style content
      if (!inScript && !inStyle) {
        signals.bodyTextLength += text.trimStart().length;
      }
    },

    onclosetag(name: string) {
      const lname = name.toLowerCase();

      if (lname === 'title') {
        if (inTitle) {
          title = titleBuffer.trim() || null;
          inTitle = false;
          titleBuffer = '';
        }
      }

      if (lname === 'script') {
        if (inScript) {
          if (scriptBuffer.includes('__NEXT_DATA__')) signals.hasNextData = true;
          if (scriptBuffer.includes('__NUXT__')) signals.hasNuxtData = true;
          inScript = false;
          scriptBuffer = '';
        }
      }

      if (lname === 'style') {
        inStyle = false;
      }

      if (lname === 'noscript') {
        if (inNoscript) {
          if (noscriptBuffer.toLowerCase().includes('javascript')) {
            signals.hasNoScriptWarning = true;
          }
          inNoscript = false;
          noscriptBuffer = '';
        }
      }
    },
  });

  // Wrap the htmlparser2 Parser in a Writable stream
  const parserWritable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      parser.write(chunk.toString());
      callback();
    },
    final(callback) {
      parser.end();
      callback();
    },
  });

  // Byte-counter + HTML collector Transform to enforce MAX_BODY_BYTES limit
  let bytesRead = 0;
  const htmlChunks: Buffer[] = [];
  const sizeGuard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytesRead += chunk.length;
      if (bytesRead > MAX_BODY_BYTES) {
        callback(new Error('response_too_large'));
        return;
      }
      htmlChunks.push(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(body, sizeGuard, parserWritable);

  signals.mediaCount = mediaItems.length;
  const rawHtml = Buffer.concat(htmlChunks).toString('utf8');

  return { title, description, rawHtml, mediaItems, spaSignals: signals };
}
