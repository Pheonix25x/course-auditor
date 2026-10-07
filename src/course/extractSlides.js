import crypto from 'crypto';
import { getCourseTargetFrame } from './discoverCourse.js';

/**
 * Compute a deterministic fingerprint of a slide's extracted content
 * to prevent duplicate slides when navigating.
 */
function computeSlideFingerprint(slideData) {
  const raw = [
    slideData.slideTitle || '',
    (slideData.headings || []).map((h) => h.text).join('|'),
    slideData.meaningfulText || ''
  ]
    .join('::')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return crypto.createHash('sha1').update(raw).digest('hex');
}

/**
 * Open a specific subtopic either by navigating to its URL or clicking its navigation item.
 */
async function openSubtopic(page, subtopic, config) {
  const timeout = config.browser?.navigationTimeoutMs || 45000;
  const waitMs = config.browser?.slideWaitMs || 1500;

  if (subtopic.url) {
    if (page.url() !== subtopic.url) {
      await page.goto(subtopic.url, {
        waitUntil: 'domcontentloaded',
        timeout
      });
    }
    await page.waitForTimeout(waitMs);
    return;
  }

  // If no direct URL (SPA navigation item), click the element matching the subtopic name
  const framesToTry = [await getCourseTargetFrame(page, config), page.mainFrame()];
  for (const frame of framesToTry) {
    try {
      const clicked = await frame.evaluate((targetName) => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = clean(targetName);
        const candidates = Array.from(
          document.querySelectorAll('nav a, nav button, aside a, aside button, [role="treeitem"], li a, li button, a, button')
        );
        const match = candidates.find((el) => clean(el.innerText || el.textContent) === target);
        if (match && typeof match.click === 'function') {
          match.click();
          return true;
        }
        return false;
      }, subtopic.name);

      if (clicked) {
        await page.waitForTimeout(waitMs);
        return;
      }
    } catch {
      // Try next frame
    }
  }
}

/**
 * Extract meaningful visible content from the currently active slide.
 */
export async function extractSingleSlideFromFrame(frame, contextInfo, config) {
  const { moduleName, subtopicName, sequentialSlideNumber } = contextInfo;
  const courseSelectors = config.courseSelectors || {};

  return frame.evaluate(
    ({ modName, subName, seqNum, selectors }) => {
      const cleanText = (str) =>
        (str || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const excludeList = selectors.excludeSelectors || [
        'nav',
        'header.site-header',
        'footer',
        'aside',
        '.sidebar',
        '.navigation',
        '.nav-menu',
        '.breadcrumbs',
        '.cookie-banner',
        '#cookie-consent',
        '[class*="cookie" i]',
        '[id*="cookie" i]',
        '.login-controls',
        '.user-menu',
        'button',
        '[role="button"]',
        '[role="navigation"]',
        '[aria-hidden="true"]',
        '.sr-only',
        '.visually-hidden',
        'script',
        'style',
        'noscript',
        'svg'
      ];
      const excludeSelectorStr = excludeList.join(', ');

      const isVisible = (el) => {
        if (!el || el.nodeType !== 1) return false;
        if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') {
          return false;
        }
        const style = window.getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          parseFloat(style.opacity) === 0
        ) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return true;
      };

      const isExcluded = (el) => {
        if (!el || el.nodeType !== 1) return true;
        try {
          if (el.matches(excludeSelectorStr) || el.closest(excludeSelectorStr)) {
            return true;
          }
        } catch {
          // Ignore invalid selector syntax if custom selector had a typo
        }
        return false;
      };

      // Locate primary slide/content container
      let rootContainer = null;
      for (const sel of selectors.slideContainer || ['article', 'main', '[role="main"]']) {
        try {
          const candidates = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          if (candidates.length > 0) {
            // Pick the candidate with the most visible text
            rootContainer = candidates.sort(
              (a, b) => (b.innerText || '').length - (a.innerText || '').length
            )[0];
            break;
          }
        } catch {
          // continue
        }
      }
      if (!rootContainer) {
        rootContainer = document.body;
      }

      // Detect slide number from counter if present (e.g., "Slide 2 of 12" or "2 / 12")
      let detectedSlideNumber = seqNum;
      for (const counterSel of selectors.slideCounter || ['.slide-counter', '.slide-number']) {
        try {
          const counterEl = document.querySelector(counterSel);
          if (counterEl && isVisible(counterEl)) {
            const text = cleanText(counterEl.innerText);
            const match = text.match(/(?:slide|page)?\s*(\d+)\s*(?:of|\/)\s*\d+/i) || text.match(/^(\d+)$/);
            if (match) {
              detectedSlideNumber = Number.parseInt(match[1], 10);
              break;
            }
          }
        } catch {
          // continue
        }
      }

      // Extract headings
      const headings = [];
      const seenHeadings = new Set();
      Array.from(rootContainer.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')).forEach(
        (h) => {
          if (!isVisible(h) || isExcluded(h)) return;
          const text = cleanText(h.innerText);
          if (!text || seenHeadings.has(text)) return;
          seenHeadings.add(text);
          headings.push({
            level: h.tagName.toLowerCase(),
            text
          });
        }
      );

      // Determine slide title
      let slideTitle = '';
      for (const titleSel of selectors.slideTitle || ['.slide-title', 'h1', 'h2']) {
        try {
          const titleEl = rootContainer.querySelector(titleSel) || document.querySelector(titleSel);
          if (titleEl && isVisible(titleEl) && !isExcluded(titleEl)) {
            const t = cleanText(titleEl.innerText);
            if (t) {
              slideTitle = t;
              break;
            }
          }
        } catch {
          // continue
        }
      }
      if (!slideTitle) {
        slideTitle = headings[0]?.text || subName || `Slide ${detectedSlideNumber}`;
      }

      // Extract paragraphs
      const paragraphs = [];
      const seenParagraphs = new Set();
      Array.from(rootContainer.querySelectorAll('p')).forEach((p) => {
        if (!isVisible(p) || isExcluded(p)) return;
        // Skip paragraphs inside tables or lists to avoid double counting
        if (p.closest('table, ul, ol')) return;
        const text = cleanText(p.innerText);
        if (!text || seenParagraphs.has(text)) return;
        seenParagraphs.add(text);
        paragraphs.push(text);
      });

      // Extract bullet points (unordered lists)
      const bulletPoints = [];
      const seenBullets = new Set();
      Array.from(rootContainer.querySelectorAll('ul > li')).forEach((li) => {
        if (!isVisible(li) || isExcluded(li)) return;
        const clone = li.cloneNode(true);
        clone.querySelectorAll('ul, ol, button, script, style').forEach((n) => n.remove());
        const text = cleanText(clone.innerText || clone.textContent);
        if (!text || seenBullets.has(text)) return;
        seenBullets.add(text);
        bulletPoints.push(text);
      });

      // Extract numbered lists (ordered lists)
      const numberedLists = [];
      const seenNumbered = new Set();
      Array.from(rootContainer.querySelectorAll('ol > li')).forEach((li) => {
        if (!isVisible(li) || isExcluded(li)) return;
        const clone = li.cloneNode(true);
        clone.querySelectorAll('ul, ol, button, script, style').forEach((n) => n.remove());
        const text = cleanText(clone.innerText || clone.textContent);
        if (!text || seenNumbered.has(text)) return;
        seenNumbered.add(text);
        numberedLists.push(text);
      });

      // Extract tables
      const tables = [];
      Array.from(rootContainer.querySelectorAll('table')).forEach((table) => {
        if (!isVisible(table) || isExcluded(table)) return;
        const headers = Array.from(table.querySelectorAll('th'))
          .map((th) => cleanText(th.innerText))
          .filter(Boolean);
        const rows = [];
        Array.from(table.querySelectorAll('tr')).forEach((tr) => {
          const cells = Array.from(tr.querySelectorAll('td'))
            .map((td) => cleanText(td.innerText))
            .filter(Boolean);
          if (cells.length > 0) {
            rows.push(cells);
          }
        });
        const tableText = [
          headers.length ? headers.join(' | ') : '',
          ...rows.map((r) => r.join(' | '))
        ]
          .filter(Boolean)
          .join('\n');
        if (tableText) {
          tables.push({ headers, rows, text: tableText });
        }
      });

      // Extract important labels, definition lists, callouts, and standalone text blocks
      const labels = [];
      const seenLabels = new Set();
      Array.from(
        rootContainer.querySelectorAll(
          'dt, dd, figcaption, blockquote, [class*="callout" i], [class*="note" i], [class*="definition" i], [class*="highlight" i], [class*="card-text" i], [class*="slide-text" i], label'
        )
      ).forEach((el) => {
        if (!isVisible(el) || isExcluded(el)) return;
        const text = cleanText(el.innerText);
        if (
          !text ||
          seenLabels.has(text) ||
          seenParagraphs.has(text) ||
          seenBullets.has(text) ||
          seenHeadings.has(text)
        ) {
          return;
        }
        seenLabels.add(text);
        labels.push(text);
      });

      // Also capture any meaningful text inside generic div/span blocks if paragraphs/lists didn't capture them
      // (common in Articulate Rise / Storyline / custom slide decks that use <div> instead of <p>)
      Array.from(rootContainer.querySelectorAll('div, section, span')).forEach((el) => {
        if (!isVisible(el) || isExcluded(el)) return;
        if (el.closest('p, ul, ol, table, h1, h2, h3, h4, h5, h6')) return;
        // Only inspect leaf-like text containers
        const hasBlockChildren = Array.from(el.children).some((c) =>
          /^(DIV|SECTION|ARTICLE|P|UL|OL|TABLE|H1|H2|H3|H4|H5|H6)$/i.test(c.tagName)
        );
        if (hasBlockChildren) return;
        const text = cleanText(el.innerText);
        if (
          text.length >= 15 &&
          !seenParagraphs.has(text) &&
          !seenBullets.has(text) &&
          !seenNumbered.has(text) &&
          !seenHeadings.has(text) &&
          !seenLabels.has(text)
        ) {
          seenParagraphs.add(text);
          paragraphs.push(text);
        }
      });

      // Assemble full meaningful text in logical structure
      const textParts = [];
      headings.forEach((h) => textParts.push(h.text));
      paragraphs.forEach((p) => textParts.push(p));
      bulletPoints.forEach((b) => textParts.push(`• ${b}`));
      numberedLists.forEach((n, i) => textParts.push(`${i + 1}. ${n}`));
      tables.forEach((t) => textParts.push(t.text));
      labels.forEach((l) => textParts.push(l));

      // Deduplicate lines while keeping order
      const uniqueLines = [];
      const seenLines = new Set();
      for (const part of textParts) {
        const norm = part.toLowerCase();
        if (!seenLines.has(norm)) {
          seenLines.add(norm);
          uniqueLines.push(part);
        }
      }

      return {
        module: modName,
        subtopic: subName,
        slideNumber: detectedSlideNumber,
        slideTitle,
        url: window.location.href,
        headings,
        paragraphs,
        bulletPoints,
        numberedLists,
        tables,
        labels,
        meaningfulText: uniqueLines.join('\n')
      };
    },
    {
      modName: moduleName,
      subName: subtopicName,
      seqNum: sequentialSlideNumber,
      selectors: courseSelectors
    }
  );
}

/**
 * Attempt to find and click an active "Next" button to advance to the next slide.
 * Checks both the slide frame and the main page frame.
 * Returns true if a Next button was found and clicked, false if at the end of the subtopic.
 */
async function clickNextSlideButton(page, targetFrame, config) {
  const nextSelectors = config.courseSelectors?.nextSlideButton || [
    "button[aria-label*='next' i]:not([disabled])",
    "a[aria-label*='next' i]:not(.disabled)",
    ".next-slide:not(.disabled):not([disabled])",
    ".btn-next:not(.disabled):not([disabled])",
    "button:has-text('Next'):not([disabled])",
    "a:has-text('Next'):not(.disabled)"
  ];

  const framesToSearch =
    targetFrame !== page.mainFrame() ? [targetFrame, page.mainFrame()] : [page.mainFrame()];

  for (const frame of framesToSearch) {
    for (const selector of nextSelectors) {
      try {
        const locator = frame.locator(selector).first();
        const count = await frame.locator(selector).count().catch(() => 0);
        if (count === 0) continue;

        const isVisible = await locator.isVisible().catch(() => false);
        if (!isVisible) continue;

        const isDisabled = await locator
          .evaluate((el) => {
            if (
              el.hasAttribute('disabled') ||
              el.getAttribute('aria-disabled') === 'true' ||
              el.classList.contains('disabled') ||
              el.classList.contains('is-disabled')
            ) {
              return true;
            }
            const style = window.getComputedStyle(el);
            return style.pointerEvents === 'none' || parseFloat(style.opacity) < 0.35;
          })
          .catch(() => true);

        if (isDisabled) continue;

        // Click the Next button
        await locator.click({ timeout: 5000 });
        await page.waitForTimeout(config.browser?.slideWaitMs || 1500);
        return true;
      } catch {
        // Try next selector
      }
    }
  }

  return false;
}

/**
 * Extract all slides for a given subtopic.
 * Navigates to the subtopic, loops through slides via Next button, prevents duplicate slides,
 * and returns the array of extracted slide objects.
 */
export async function extractSubtopicSlides(page, moduleObj, subtopicObj, config, errorLogger) {
  const slides = [];
  const seenFingerprints = new Set();
  const maxSlides = config.crawl?.singleTestMode
    ? 1
    : config.crawl?.maxSlidesPerSubtopic || 250;

  try {
    console.log(
      `\n  -> Opening Subtopic: "${subtopicObj.name}" (Module: "${moduleObj.name}")`
    );
    await openSubtopic(page, subtopicObj, config);

    let slideIndex = 1;
    while (slideIndex <= maxSlides) {
      const targetFrame = await getCourseTargetFrame(page, config);

      const slideData = await extractSingleSlideFromFrame(
        targetFrame,
        {
          moduleName: moduleObj.name,
          subtopicName: subtopicObj.name,
          sequentialSlideNumber: slideIndex
        },
        config
      );

      const fingerprint = computeSlideFingerprint(slideData);
      if (seenFingerprints.has(fingerprint)) {
        console.log(
          `     [Slide ${slideIndex}] Content identical to a previous slide in this subtopic; reached end of subtopic.`
        );
        break;
      }

      seenFingerprints.add(fingerprint);
      slides.push(slideData);

      console.log(
        `     [Slide ${slideData.slideNumber}] Extracted: "${slideData.slideTitle}" (${
          slideData.meaningfulText.length
        } chars)`
      );

      if (slideIndex >= maxSlides) {
        if (config.crawl?.singleTestMode) {
          console.log('     [Single Test Mode] Stopping after 1 slide as configured.');
        }
        break;
      }

      // Try advancing to the next slide
      const advanced = await clickNextSlideButton(page, targetFrame, config);
      if (!advanced) {
        break;
      }

      slideIndex += 1;
    }
  } catch (err) {
    if (errorLogger) {
      errorLogger.log({
        stage: 'SLIDE_EXTRACTION',
        url: subtopicObj.url || page.url(),
        module: moduleObj.name,
        subtopic: subtopicObj.name,
        slide: slides.length + 1,
        message: 'Error extracting slides from subtopic',
        error: err
      });
    }
  }

  return slides;
}
