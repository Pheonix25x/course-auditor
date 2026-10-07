import fs from 'fs';
import { inspectCourseDom } from './inspectDom.js';

/**
 * Find the active content frame (either an embedded course player iframe or the main page).
 */
export async function getCourseTargetFrame(page, config) {
  const frameSelectors = config.courseSelectors?.slideFrame || [];
  for (const selector of frameSelectors) {
    const count = await page.locator(selector).count().catch(() => 0);
    if (count > 0) {
      const elementHandle = await page.locator(selector).first().elementHandle().catch(() => null);
      if (elementHandle) {
        const contentFrame = await elementHandle.contentFrame().catch(() => null);
        if (contentFrame) {
          return contentFrame;
        }
      }
    }
  }

  // Also check if any child frame has significant course navigation/slide content
  const childFrames = page.frames().filter((f) => f !== page.mainFrame());
  for (const frame of childFrames) {
    const url = frame.url();
    if (!url || url === 'about:blank' || /analytics|gtm|doubleclick|facebook|recaptcha/i.test(url)) {
      continue;
    }
    const hasCourseElements = await frame
      .evaluate(() => {
        return Boolean(
          document.querySelector(
            '[class*="slide" i], [class*="module" i], [class*="lesson" i], [class*="course" i]'
          )
        );
      })
      .catch(() => false);
    if (hasCourseElements) {
      return frame;
    }
  }

  return page.mainFrame();
}

/**
 * Safely expand collapsed navigation accordions so nested subtopic links become visible.
 */
async function expandNavigationAccordions(frame) {
  try {
    await frame.evaluate(async () => {
      const expandables = document.querySelectorAll(
        'nav [aria-expanded="false"], aside [aria-expanded="false"], [class*="module" i] [aria-expanded="false"], [class*="accordion" i] [aria-expanded="false"], details:not([open]) > summary'
      );
      for (const el of Array.from(expandables).slice(0, 50)) {
        if (el.tagName.toLowerCase() === 'summary' && el.parentElement) {
          el.parentElement.setAttribute('open', 'true');
        } else if (typeof el.click === 'function') {
          try {
            el.click();
            await new Promise((r) => setTimeout(r, 120));
          } catch {
            // ignore
          }
        }
      }
    });
  } catch {
    // Non-fatal if page doesn't use accordions
  }
}

/**
 * Discover the course structure (Course -> Modules -> Subtopics -> Slides)
 * from the live authenticated course page.
 */
export async function discoverCourseStructure(page, config, errorLogger) {
  console.log('\n==================================================');
  console.log('STEP 3 — DISCOVERING COURSE STRUCTURE');
  console.log('==================================================');

  try {
    // 1. Inspect DOM first (Important Development Rule)
    await inspectCourseDom(page, config);

    // 2. Determine whether course navigation lives in main frame or an iframe
    const targetFrame = await getCourseTargetFrame(page, config);

    // 3. Expand collapsed accordions in both main frame and target frame
    await expandNavigationAccordions(page.mainFrame());
    if (targetFrame !== page.mainFrame()) {
      await expandNavigationAccordions(targetFrame);
    }
    await page.waitForTimeout(800);

    // 4. Extract hierarchy from frame
    const extractFromFrame = async (frame) => {
      return frame.evaluate((selectorsConfig) => {
        const cleanText = (str) =>
          (str || '')
            .replace(/\s+/g, ' ')
            .trim();

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

        const isIgnoredLink = (text, href) => {
          const lower = text.toLowerCase();
          if (
            !text ||
            text.length < 2 ||
            /^(log\s*out|sign\s*out|profile|settings|account|help|support|privacy|terms|cookie|skip to|home|back to dashboard)$/i.test(
              lower
            )
          ) {
            return true;
          }
          if (
            href &&
            /^(javascript:void|mailto:|tel:|#$)/i.test(href.trim()) &&
            !text
          ) {
            return true;
          }
          if (href && /\/(logout|signout|login|signin|profile|settings|privacy|terms)/i.test(href)) {
            return true;
          }
          return false;
        };

        const resolveUrl = (href) => {
          if (!href || href.startsWith('javascript:') || href === '#') return null;
          try {
            return new URL(href, window.location.href).href;
          } catch {
            return null;
          }
        };

        // Detect course name
        let courseName = '';
        for (const sel of selectorsConfig.courseTitle || ['h1']) {
          const el = document.querySelector(sel);
          if (el && isVisible(el) && cleanText(el.innerText).length > 2) {
            courseName = cleanText(el.innerText);
            break;
          }
        }
        if (!courseName) {
          courseName = cleanText(document.title.split('|')[0].split('-')[0]) || 'Online Course';
        }

        const modules = [];
        const seenSubtopicKeys = new Set();

        // Strategy A: Configured or standard module containers containing subtopic items
        const containerSelectors = selectorsConfig.moduleContainers || [];
        let moduleElements = [];
        for (const sel of containerSelectors) {
          const found = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          if (found.length > 0) {
            moduleElements = found;
            break;
          }
        }

        if (moduleElements.length > 0) {
          moduleElements.forEach((modEl, modIdx) => {
            // Find module title
            let modName = '';
            for (const titleSel of selectorsConfig.moduleTitle || ['h2', 'h3', 'button', 'summary']) {
              const titleEl = modEl.querySelector(titleSel);
              if (titleEl && cleanText(titleEl.innerText)) {
                modName = cleanText(titleEl.innerText);
                break;
              }
            }
            if (!modName) {
              modName =
                cleanText(modEl.getAttribute('aria-label') || modEl.getAttribute('data-title')) ||
                `Module ${modIdx + 1}`;
            }

            // Find subtopics inside this module container
            const subtopicEls = Array.from(
              modEl.querySelectorAll('a, [role="treeitem"], [data-subtopic], [data-lesson], li')
            );

            const subtopics = [];
            subtopicEls.forEach((subEl) => {
              // Avoid picking a parent <li> that wraps another list if we can pick its leaf link
              if (
                subEl.tagName.toLowerCase() === 'li' &&
                subEl.querySelector('a, button, ul, ol')
              ) {
                return;
              }
              const text = cleanText(subEl.innerText || subEl.textContent);
              const href = subEl.getAttribute('href');
              if (!text || text === modName || isIgnoredLink(text, href)) return;

              const resolved = resolveUrl(href);
              const key = `${modName}::${text}::${resolved || ''}`;
              if (seenSubtopicKeys.has(key)) return;
              seenSubtopicKeys.add(key);

              subtopics.push({
                name: text,
                url: resolved,
                slides: []
              });
            });

            if (subtopics.length > 0) {
              modules.push({
                name: modName,
                subtopics
              });
            }
          });
        }

        // Strategy B: Nested lists or headed sections in <nav>, <aside>, or curriculum containers
        if (modules.length === 0) {
          const navRoots = Array.from(
            document.querySelectorAll(
              'nav, aside, [role="navigation"], [class*="curriculum" i], [class*="syllabus" i], [class*="sidebar" i], [class*="toc" i], [class*="menu" i], main'
            )
          ).filter(isVisible);

          for (const root of navRoots) {
            // Look for top-level list items that have nested lists (Module -> Subtopics)
            const topListItems = Array.from(root.querySelectorAll('ul > li, ol > li')).filter(
              (li) => li.querySelector('ul, ol')
            );

            if (topListItems.length > 0) {
              topListItems.forEach((li, idx) => {
                const clone = li.cloneNode(true);
                clone.querySelectorAll('ul, ol').forEach((nested) => nested.remove());
                const modName = cleanText(clone.innerText) || `Module ${idx + 1}`;

                const childLinks = Array.from(li.querySelectorAll('ul a, ol a, ul button, ol button'));
                const subtopics = [];
                childLinks.forEach((link) => {
                  const text = cleanText(link.innerText || link.textContent);
                  const href = link.getAttribute('href');
                  if (!text || text === modName || isIgnoredLink(text, href)) return;
                  const resolved = resolveUrl(href);
                  const key = `${modName}::${text}::${resolved || ''}`;
                  if (seenSubtopicKeys.has(key)) return;
                  seenSubtopicKeys.add(key);
                  subtopics.push({
                    name: text,
                    url: resolved,
                    slides: []
                  });
                });

                if (subtopics.length > 0) {
                  modules.push({ name: modName, subtopics });
                }
              });
            }

            if (modules.length > 0) break;
          }
        }

        // Strategy C: Headings (h2/h3) followed by links/cards on a course overview page,
        // or a flat list of course lessons/subtopics
        if (modules.length === 0) {
          const allLinks = Array.from(
            document.querySelectorAll(
              'nav a, aside a, [class*="course" i] a, [class*="lesson" i] a, [class*="module" i] a, [class*="topic" i] a, main a'
            )
          ).filter(isVisible);

          const subtopics = [];
          allLinks.forEach((link) => {
            const text = cleanText(link.innerText || link.textContent);
            const href = link.getAttribute('href');
            if (isIgnoredLink(text, href)) return;
            const resolved = resolveUrl(href);
            // Only keep links on the same host
            if (resolved) {
              try {
                if (new URL(resolved).host !== window.location.host) return;
              } catch {
                return;
              }
            }
            const key = `Default::${text}::${resolved || ''}`;
            if (seenSubtopicKeys.has(key)) return;
            seenSubtopicKeys.add(key);

            subtopics.push({
              name: text,
              url: resolved,
              slides: []
            });
          });

          if (subtopics.length > 0) {
            modules.push({
              name: courseName || 'Module 1',
              subtopics
            });
          }
        }

        // Strategy D: Single-page / direct slide player where the current URL is already inside a subtopic
        if (modules.length === 0) {
          modules.push({
            name: courseName || 'Module 1',
            subtopics: [
              {
                name: courseName || 'Subtopic 1',
                url: window.location.href,
                slides: []
              }
            ]
          });
        }

        return {
          course: courseName,
          modules
        };
      }, config.courseSelectors || {});
    };

    let discovered = await extractFromFrame(targetFrame);

    // If targetFrame was an iframe that only had slide content and no module navigation,
    // also check mainFrame for module/subtopic navigation!
    if (
      targetFrame !== page.mainFrame() &&
      discovered.modules.length === 1 &&
      discovered.modules[0].subtopics.length <= 1
    ) {
      const mainDiscovered = await extractFromFrame(page.mainFrame());
      if (
        mainDiscovered.modules.length > 1 ||
        (mainDiscovered.modules[0]?.subtopics?.length || 0) > 1
      ) {
        discovered = mainDiscovered;
      }
    }

    const courseName = config.courseName || discovered.course || 'Online Course';
    const manifest = {
      course: courseName,
      courseUrl: config.courseUrl,
      discoveredAt: new Date().toISOString(),
      modules: discovered.modules
    };

    // Save initial manifest
    saveCourseManifest(manifest, config);

    const totalModules = manifest.modules.length;
    const totalSubtopics = manifest.modules.reduce(
      (sum, m) => sum + (m.subtopics ? m.subtopics.length : 0),
      0
    );

    console.log(`[Discovery] Course: "${manifest.course}"`);
    console.log(`[Discovery] Discovered ${totalModules} module(s) and ${totalSubtopics} subtopic(s).`);
    console.log(`[Discovery] Saved course manifest to: ${config.paths.manifest}`);

    return manifest;
  } catch (err) {
    if (errorLogger) {
      errorLogger.log({
        stage: 'COURSE_DISCOVERY',
        url: page.url(),
        message: 'Failed to discover course structure',
        error: err
      });
    }
    throw err;
  }
}

/**
 * Save the course manifest to data/course/manifest.json.
 * Produces clean manifest matching Step 3 specifications.
 */
export function saveCourseManifest(manifest, config) {
  if (!config.paths?.manifest) return;
  fs.writeFileSync(config.paths.manifest, JSON.stringify(manifest, null, 2), 'utf-8');
}
