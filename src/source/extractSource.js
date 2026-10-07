/**
 * Extract structured, clean, meaningful content from a reference/source webpage.
 * Ignores navigation, headers, footers, cookie notices, advertisements, menus,
 * tracking elements, and hidden UI.
 */
export async function extractSourcePageContent(page, config) {
  const sourceSelectors = config.sourceSelectors || {};

  return page.evaluate((selectors) => {
    const cleanText = (str) =>
      (str || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const excludeList = selectors.excludeSelectors || [
      'nav',
      'header',
      'footer',
      'aside',
      '.sidebar',
      '.menu',
      '.navigation',
      '.navbar',
      '.breadcrumbs',
      '.cookie-banner',
      '.cookie-notice',
      '[class*="cookie" i]',
      '[id*="cookie" i]',
      '.ad',
      '.ads',
      '.advertisement',
      '[class*="advert" i]',
      '.social-share',
      '.comments',
      '.related-posts',
      '[role="navigation"]',
      '[role="banner"]',
      '[role="contentinfo"]',
      '[aria-hidden="true"]',
      '.sr-only',
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
      return rect.width > 0 && rect.height > 0;
    };

    const isExcluded = (el) => {
      if (!el || el.nodeType !== 1) return true;
      try {
        if (el.matches(excludeSelectorStr) || el.closest(excludeSelectorStr)) {
          return true;
        }
      } catch {
        // ignore invalid selector
      }
      return false;
    };

    // Find primary content container
    let root = null;
    for (const sel of selectors.contentContainer || ['article', 'main', '[role="main"]', 'body']) {
      try {
        const candidates = Array.from(document.querySelectorAll(sel)).filter(isVisible);
        if (candidates.length > 0) {
          root = candidates.sort(
            (a, b) => (b.innerText || '').length - (a.innerText || '').length
          )[0];
          break;
        }
      } catch {
        // continue
      }
    }
    if (!root) root = document.body;

    const pageTitle =
      cleanText(root.querySelector('h1')?.innerText) ||
      cleanText(document.querySelector('h1')?.innerText) ||
      cleanText(document.title);

    // Headings
    const headings = [];
    const seenHeadings = new Set();
    Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6')).forEach((h) => {
      if (!isVisible(h) || isExcluded(h)) return;
      const text = cleanText(h.innerText);
      if (!text || seenHeadings.has(text)) return;
      seenHeadings.add(text);
      headings.push({
        level: h.tagName.toLowerCase(),
        text
      });
    });

    // Paragraphs
    const paragraphs = [];
    const seenParagraphs = new Set();
    Array.from(root.querySelectorAll('p')).forEach((p) => {
      if (!isVisible(p) || isExcluded(p)) return;
      if (p.closest('table, ul, ol')) return;
      const text = cleanText(p.innerText);
      if (!text || seenParagraphs.has(text)) return;
      seenParagraphs.add(text);
      paragraphs.push(text);
    });

    // Lists (both unordered and ordered)
    const lists = [];
    const bulletPoints = [];
    const numberedLists = [];
    const seenListItems = new Set();

    Array.from(root.querySelectorAll('ul > li, ol > li')).forEach((li) => {
      if (!isVisible(li) || isExcluded(li)) return;
      const clone = li.cloneNode(true);
      clone.querySelectorAll('ul, ol, button, script, style').forEach((n) => n.remove());
      const text = cleanText(clone.innerText || clone.textContent);
      if (!text || seenListItems.has(text)) return;
      seenListItems.add(text);

      const parentTag = li.parentElement?.tagName?.toLowerCase() || 'ul';
      lists.push({ type: parentTag, text });
      if (parentTag === 'ol') {
        numberedLists.push(text);
      } else {
        bulletPoints.push(text);
      }
    });

    // Tables
    const tables = [];
    Array.from(root.querySelectorAll('table')).forEach((table) => {
      if (!isVisible(table) || isExcluded(table)) return;
      const headers = Array.from(table.querySelectorAll('th'))
        .map((th) => cleanText(th.innerText))
        .filter(Boolean);
      const rows = [];
      Array.from(table.querySelectorAll('tr')).forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll('td'))
          .map((td) => cleanText(td.innerText))
          .filter(Boolean);
        if (cells.length > 0) rows.push(cells);
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

    // Build topical sections (grouped by heading) to allow fine-grained slide-to-section matching
    const sections = [];
    let currentSection = {
      heading: pageTitle,
      level: 'h1',
      paragraphs: [],
      bulletPoints: [],
      numberedLists: [],
      tables: []
    };

    const contentNodes = Array.from(
      root.querySelectorAll('h1, h2, h3, h4, p, ul > li, ol > li, table, dl > dt, dl > dd, blockquote')
    );

    contentNodes.forEach((node) => {
      if (!isVisible(node) || isExcluded(node)) return;
      const tag = node.tagName.toLowerCase();

      if (/^h[1-4]$/.test(tag)) {
        const hText = cleanText(node.innerText);
        if (!hText) return;
        if (
          currentSection.paragraphs.length > 0 ||
          currentSection.bulletPoints.length > 0 ||
          currentSection.numberedLists.length > 0 ||
          currentSection.tables.length > 0
        ) {
          sections.push({
            ...currentSection,
            meaningfulText: [
              currentSection.heading,
              ...currentSection.paragraphs,
              ...currentSection.bulletPoints.map((b) => `• ${b}`),
              ...currentSection.numberedLists.map((n, i) => `${i + 1}. ${n}`),
              ...currentSection.tables.map((t) => t.text)
            ]
              .filter(Boolean)
              .join('\n')
          });
        }
        currentSection = {
          heading: hText,
          level: tag,
          paragraphs: [],
          bulletPoints: [],
          numberedLists: [],
          tables: []
        };
      } else if (tag === 'p' || tag === 'blockquote' || tag === 'dd' || tag === 'dt') {
        if (node.closest('table, ul, ol')) return;
        const pText = cleanText(node.innerText);
        if (pText && !currentSection.paragraphs.includes(pText)) {
          currentSection.paragraphs.push(pText);
        }
      } else if (tag === 'li') {
        const clone = node.cloneNode(true);
        clone.querySelectorAll('ul, ol, button, script, style').forEach((n) => n.remove());
        const liText = cleanText(clone.innerText || clone.textContent);
        if (!liText) return;
        if (node.parentElement?.tagName?.toLowerCase() === 'ol') {
          if (!currentSection.numberedLists.includes(liText)) {
            currentSection.numberedLists.push(liText);
          }
        } else if (!currentSection.bulletPoints.includes(liText)) {
          currentSection.bulletPoints.push(liText);
        }
      }
    });

    if (
      currentSection.paragraphs.length > 0 ||
      currentSection.bulletPoints.length > 0 ||
      currentSection.numberedLists.length > 0 ||
      currentSection.tables.length > 0
    ) {
      sections.push({
        ...currentSection,
        meaningfulText: [
          currentSection.heading,
          ...currentSection.paragraphs,
          ...currentSection.bulletPoints.map((b) => `• ${b}`),
          ...currentSection.numberedLists.map((n, i) => `${i + 1}. ${n}`),
          ...currentSection.tables.map((t) => t.text)
        ]
          .filter(Boolean)
          .join('\n')
      });
    }

    // Assemble full page meaningful text
    const meaningfulText = [
      ...headings.map((h) => h.text),
      ...paragraphs,
      ...bulletPoints.map((b) => `• ${b}`),
      ...numberedLists.map((n, i) => `${i + 1}. ${n}`),
      ...tables.map((t) => t.text)
    ]
      .filter(Boolean)
      .join('\n');

    return {
      url: window.location.href,
      pageTitle,
      headings,
      paragraphs,
      lists,
      bulletPoints,
      numberedLists,
      tables,
      sections,
      meaningfulText
    };
  }, sourceSelectors);
}
