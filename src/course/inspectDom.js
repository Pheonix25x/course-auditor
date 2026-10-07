import fs from 'fs';

/**
 * Inspect the live course DOM (and any embedded course player iframes)
 * to identify how modules, subtopics, slides, Next buttons, and content containers
 * are structured on the actual course website.
 *
 * Saves the detailed inspection report to data/course/dom-inspection.json.
 */
export async function inspectCourseDom(page, config) {
  console.log('\n[DOM Inspector] Analyzing course page structure...');

  const evaluateFrameStructure = async (frame, frameLabel) => {
    try {
      return await frame.evaluate((label) => {
        const getCssSignature = (el) => {
          if (!el || !el.tagName) return '';
          const tag = el.tagName.toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const classes =
            typeof el.className === 'string' && el.className.trim()
              ? '.' +
                el.className
                  .trim()
                  .split(/\s+/)
                  .slice(0, 3)
                  .join('.')
              : '';
          const role = el.getAttribute('role') ? `[role="${el.getAttribute('role')}"]` : '';
          return `${tag}${id}${classes}${role}`;
        };

        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            parseFloat(style.opacity) === 0
          ) {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        // 1. Candidate Navigation / Module / Subtopic containers
        const navCandidates = [];
        const navElements = document.querySelectorAll(
          'nav, aside, [role="navigation"], [role="tree"], [class*="module" i], [class*="sidebar" i], [class*="curriculum" i], [class*="syllabus" i], [class*="menu" i], [class*="toc" i], [class*="lesson" i], [class*="topic" i], .accordion'
        );

        navElements.forEach((el) => {
          if (!isVisible(el)) return;
          const links = Array.from(el.querySelectorAll('a, button, [role="treeitem"], li')).filter(
            isVisible
          );
          if (links.length >= 2 && navCandidates.length < 15) {
            navCandidates.push({
              signature: getCssSignature(el),
              itemCount: links.length,
              sampleItems: links
                .slice(0, 6)
                .map((item) => ({
                  signature: getCssSignature(item),
                  text: (item.innerText || item.textContent || '').trim().slice(0, 80),
                  href: item.getAttribute('href') || null,
                  ariaExpanded: item.getAttribute('aria-expanded') || null
                }))
                .filter((x) => x.text.length > 0)
            });
          }
        });

        // 2. Candidate Next / Previous slide controls
        const buttonCandidates = [];
        const controls = document.querySelectorAll(
          'button, a, [role="button"], [class*="next" i], [class*="prev" i], [id*="next" i], [id*="prev" i], [aria-label*="next" i], [aria-label*="prev" i], [title*="next" i]'
        );
        controls.forEach((el) => {
          if (!isVisible(el)) return;
          const text = (el.innerText || el.textContent || '').trim();
          const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
          const combined = `${text} ${aria} ${el.className || ''} ${el.id || ''}`.toLowerCase();
          if (
            /next|prev|back|forward|continue|slide|arrow|chevron/i.test(combined) &&
            buttonCandidates.length < 20
          ) {
            buttonCandidates.push({
              signature: getCssSignature(el),
              text: text.slice(0, 50),
              ariaLabel: aria.slice(0, 80),
              disabled: el.hasAttribute('disabled') || el.classList.contains('disabled'),
              href: el.getAttribute('href') || null
            });
          }
        });

        // 3. Candidate Content / Slide Containers
        const contentCandidates = [];
        const containers = document.querySelectorAll(
          'main, article, [role="main"], [class*="slide" i], [class*="content" i], [class*="lesson" i], [class*="stage" i], [class*="player" i], #content, #main'
        );
        containers.forEach((el) => {
          if (!isVisible(el)) return;
          const text = (el.innerText || '').trim();
          if (text.length > 40 && contentCandidates.length < 12) {
            contentCandidates.push({
              signature: getCssSignature(el),
              textLength: text.length,
              headingsCount: el.querySelectorAll('h1, h2, h3, h4').length,
              paragraphsCount: el.querySelectorAll('p').length,
              listsCount: el.querySelectorAll('ul, ol').length,
              sampleText: text.replace(/\s+/g, ' ').slice(0, 140)
            });
          }
        });

        // 4. Headings overview
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .filter(isVisible)
          .slice(0, 15)
          .map((h) => ({
            tag: h.tagName.toLowerCase(),
            signature: getCssSignature(h),
            text: (h.innerText || '').trim().slice(0, 100)
          }));

        return {
          frameLabel: label,
          url: window.location.href,
          title: document.title,
          headings,
          navCandidates,
          buttonCandidates,
          contentCandidates
        };
      }, frameLabel);
    } catch (err) {
      return {
        frameLabel,
        error: err.message
      };
    }
  };

  const framesReport = [];
  const mainReport = await evaluateFrameStructure(page.mainFrame(), 'mainFrame');
  framesReport.push(mainReport);

  const childFrames = page.frames().filter((f) => f !== page.mainFrame());
  for (let i = 0; i < childFrames.length; i++) {
    const f = childFrames[i];
    const url = f.url();
    if (!url || url === 'about:blank' || /analytics|gtm|doubleclick|facebook/i.test(url)) {
      continue;
    }
    const subReport = await evaluateFrameStructure(f, `iframe[${i}] (${url.slice(0, 80)})`);
    framesReport.push(subReport);
  }

  const inspectionResult = {
    inspectedAt: new Date().toISOString(),
    courseUrl: page.url(),
    pageTitle: await page.title().catch(() => ''),
    totalFrames: framesReport.length,
    frames: framesReport
  };

  if (config.paths?.domInspection) {
    fs.writeFileSync(
      config.paths.domInspection,
      JSON.stringify(inspectionResult, null, 2),
      'utf-8'
    );
    console.log(`[DOM Inspector] Saved DOM structure analysis to: ${config.paths.domInspection}`);
  }

  return inspectionResult;
}
