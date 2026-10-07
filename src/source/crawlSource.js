import fs from 'fs';
import { PlaywrightCrawler, Configuration } from 'crawlee';
import { extractSourcePageContent } from './extractSource.js';

/**
 * Crawl the authoritative reference/source website using Crawlee + Playwright.
 * Discovers relevant pages, extracts structured content, and saves to data/source/source-content.json.
 */
export async function crawlSourceWebsite(config, errorLogger) {
  console.log('\n==================================================');
  console.log('STEP 5 — CRAWLING REFERENCE / SOURCE WEBSITE');
  console.log('==================================================');

  if (!config.sourceUrl) {
    throw new Error(
      'SOURCE_URL is not configured. Please set SOURCE_URL in your .env file or config/config.json.'
    );
  }

  console.log(`[Source Crawl] Starting Crawlee PlaywrightCrawler at: ${config.sourceUrl}`);

  const pages = [];
  const seenUrls = new Set();

  // Configure Crawlee to avoid persisting internal queue state across independent runs unless desired
  const crawleeConfig = new Configuration({
    persistStorage: false
  });

  const maxRequests = config.crawl?.singleTestMode
    ? Math.min(config.crawl?.maxSourcePages || 25, 25)
    : config.crawl?.maxSourcePages || 200;

  const crawler = new PlaywrightCrawler(
    {
      maxRequestsPerCrawl: maxRequests,
      maxConcurrency: 3,
      navigationTimeoutSecs: Math.ceil((config.browser?.navigationTimeoutMs || 45000) / 1000),
      headless: config.browser?.headless ?? true,
      launchContext: {
        launchOptions: {
          headless: config.browser?.headless ?? true
        }
      },
      async requestHandler({ page, request, enqueueLinks, log }) {
        const loadedUrl = page.url();
        const canonicalUrl = loadedUrl.split('#')[0];

        if (seenUrls.has(canonicalUrl)) {
          return;
        }
        seenUrls.add(canonicalUrl);

        log.info(`[Source Crawl] Extracting: ${canonicalUrl}`);
        await page.waitForTimeout(400);

        const extracted = await extractSourcePageContent(page, config);
        if (extracted && extracted.meaningfulText && extracted.meaningfulText.length > 0) {
          pages.push(extracted);

          // Incrementally save source content so progress is preserved
          saveSourceContent(pages, config);
        }

        // Enqueue relevant links on the same domain
        await enqueueLinks({
          strategy: 'same-domain',
          transformRequestFunction(req) {
            // Skip binary downloads, mailto, auth endpoints, etc.
            if (
              /\.(pdf|zip|docx?|xlsx?|pptx?|jpg|jpeg|png|gif|svg|mp4|mp3|css|js|xml|json)$/i.test(
                req.url
              )
            ) {
              return false;
            }
            if (/\/(login|logout|signin|signup|register|cart|checkout|wp-admin)\b/i.test(req.url)) {
              return false;
            }
            req.url = req.url.split('#')[0];
            return req;
          }
        });
      },
      failedRequestHandler({ request }, error) {
        if (errorLogger) {
          errorLogger.log({
            stage: 'SOURCE_CRAWL',
            url: request.url,
            message: 'Failed to crawl source page',
            error
          });
        }
      }
    },
    crawleeConfig
  );

  try {
    await crawler.run([config.sourceUrl]);
  } catch (err) {
    if (errorLogger) {
      errorLogger.log({
        stage: 'SOURCE_CRAWL',
        url: config.sourceUrl,
        message: 'Source website crawler encountered a fatal error',
        error: err
      });
    }
    throw err;
  }

  const output = saveSourceContent(pages, config);
  console.log(`[Source Crawl Complete] Extracted ${pages.length} source page(s).`);
  console.log(`[Source Crawl Complete] Saved to: ${config.paths.sourceContent}`);

  return output;
}

function saveSourceContent(pages, config) {
  const payload = {
    sourceUrl: config.sourceUrl,
    crawledAt: new Date().toISOString(),
    totalPages: pages.length,
    pages
  };
  fs.writeFileSync(config.paths.sourceContent, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}
