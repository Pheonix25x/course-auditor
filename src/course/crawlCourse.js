import fs from 'fs';
import { getAuthenticatedCourseSession, isLoginPage } from '../auth/login.js';
import { discoverCourseStructure, saveCourseManifest } from './discoverCourse.js';
import { extractSubtopicSlides } from './extractSlides.js';

/**
 * Load saved crawl progress if resume support is enabled.
 */
function loadProgress(config) {
  if (!config.crawl?.resumeEnabled) {
    return { completedSubtopicKeys: [], updatedAt: null };
  }
  try {
    if (fs.existsSync(config.paths.progress)) {
      const parsed = JSON.parse(fs.readFileSync(config.paths.progress, 'utf-8'));
      if (Array.isArray(parsed.completedSubtopicKeys)) {
        return parsed;
      }
    }
  } catch {
    // ignore corrupt progress file
  }
  return { completedSubtopicKeys: [], updatedAt: null };
}

/**
 * Save crawl progress after each subtopic.
 */
function saveProgress(progress, config) {
  progress.updatedAt = new Date().toISOString();
  fs.writeFileSync(config.paths.progress, JSON.stringify(progress, null, 2), 'utf-8');
}

/**
 * Load existing extracted course content when resuming.
 */
function loadExistingCourseContent(config) {
  if (!config.crawl?.resumeEnabled) return null;
  try {
    if (fs.existsSync(config.paths.courseContent)) {
      return JSON.parse(fs.readFileSync(config.paths.courseContent, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Save extracted course content to data/course/course-content.json.
 */
function saveCourseContent(courseData, config) {
  courseData.updatedAt = new Date().toISOString();
  fs.writeFileSync(config.paths.courseContent, JSON.stringify(courseData, null, 2), 'utf-8');
}

/**
 * Crawl the authenticated course website:
 * 1. Verify / perform login
 * 2. Discover modules and subtopics
 * 3. Extract slides for each subtopic (with resume support & single-test mode support)
 * 4. Save manifest and structured course JSON
 */
export async function crawlCourse(config, errorLogger) {
  console.log('\n==================================================');
  console.log('STEP 4 — CRAWLING & EXTRACTING COURSE CONTENT');
  console.log('==================================================');

  if (config.crawl?.singleTestMode) {
    console.log(
      '[Mode] Running in INCREMENTAL SINGLE-ITEM TEST MODE (1 Module -> 1 Subtopic -> 1 Slide)'
    );
  }

  const progress = loadProgress(config);
  const completedSet = new Set(progress.completedSubtopicKeys || []);
  const existingData = loadExistingCourseContent(config);

  const { browser, page } = await getAuthenticatedCourseSession(config, errorLogger);

  try {
    // Discover course hierarchy (or reuse manifest if resuming)
    let manifest = null;
    if (
      config.crawl?.resumeEnabled &&
      completedSet.size > 0 &&
      fs.existsSync(config.paths.manifest)
    ) {
      try {
        manifest = JSON.parse(fs.readFileSync(config.paths.manifest, 'utf-8'));
        console.log(
          `[Resume] Loaded existing course manifest ("${manifest.course}") with ${completedSet.size} completed subtopic(s).`
        );
      } catch {
        manifest = null;
      }
    }

    if (!manifest) {
      manifest = await discoverCourseStructure(page, config, errorLogger);
    }

    const courseContent = existingData || {
      course: manifest.course,
      courseUrl: config.courseUrl,
      extractedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      slides: []
    };

    const maxModules = config.crawl?.singleTestMode
      ? 1
      : config.crawl?.maxModules > 0
      ? config.crawl.maxModules
      : manifest.modules.length;

    const modulesToProcess = manifest.modules.slice(0, maxModules);

    for (let mIdx = 0; mIdx < modulesToProcess.length; mIdx++) {
      const moduleObj = modulesToProcess[mIdx];
      console.log(
        `\n[Module ${mIdx + 1}/${modulesToProcess.length}] "${moduleObj.name}"`
      );

      const subtopics = moduleObj.subtopics || [];
      const maxSubtopics = config.crawl?.singleTestMode
        ? 1
        : config.crawl?.maxSubtopicsPerModule > 0
        ? config.crawl.maxSubtopicsPerModule
        : subtopics.length;

      const subtopicsToProcess = subtopics.slice(0, maxSubtopics);

      for (let sIdx = 0; sIdx < subtopicsToProcess.length; sIdx++) {
        const subtopicObj = subtopicsToProcess[sIdx];
        const subtopicKey = `${moduleObj.name}::${subtopicObj.name}`;

        if (
          config.crawl?.resumeEnabled &&
          !config.crawl?.singleTestMode &&
          completedSet.has(subtopicKey)
        ) {
          console.log(
            `  [Resume] Skipping already-completed subtopic: "${subtopicObj.name}"`
          );
          continue;
        }

        // Check if session expired mid-crawl
        if (await isLoginPage(page, config)) {
          errorLogger?.log({
            stage: 'SLIDE_EXTRACTION',
            url: page.url(),
            module: moduleObj.name,
            subtopic: subtopicObj.name,
            message: 'Course session expired during crawl.'
          });
          throw new Error(
            'Course login session expired during crawl. Run `npm run login` and re-run to resume from the last saved subtopic.'
          );
        }

        const extractedSlides = await extractSubtopicSlides(
          page,
          moduleObj,
          subtopicObj,
          config,
          errorLogger
        );

        // Update manifest slide summaries for this subtopic
        subtopicObj.slides = extractedSlides.map((s) => ({
          number: s.slideNumber,
          title: s.slideTitle
        }));

        // Remove any prior slides for this module+subtopic before appending fresh ones
        courseContent.slides = courseContent.slides.filter(
          (s) => !(s.module === moduleObj.name && s.subtopic === subtopicObj.name)
        );
        courseContent.slides.push(...extractedSlides);

        // Save checkpoint immediately (Step 13 — Resume Support)
        saveCourseManifest(manifest, config);
        saveCourseContent(courseContent, config);

        if (!config.crawl?.singleTestMode) {
          completedSet.add(subtopicKey);
          progress.completedSubtopicKeys = Array.from(completedSet);
          saveProgress(progress, config);
        }
      }
    }

    console.log(
      `\n[Course Crawl Complete] Total slides saved: ${courseContent.slides.length}`
    );
    console.log(`[Course Crawl Complete] Saved to: ${config.paths.courseContent}`);

    return { manifest, courseContent };
  } finally {
    await browser.close().catch(() => {});
  }
}
