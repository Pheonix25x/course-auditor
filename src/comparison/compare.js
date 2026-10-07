import fs from 'fs';
import {
  normalizeText,
  splitIntoSentences,
  extractKeywords,
  extractNumericValues,
  extractFactualPolarities
} from './normalize.js';

/**
 * Compute character bigram Dice similarity between two normalized strings (0.0 to 1.0).
 */
export function computeDiceSimilarity(strA, strB) {
  const a = normalizeText(strA);
  const b = normalizeText(strB);
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  if (a === b) return 1.0;

  if (a.length < 2 || b.length < 2) {
    return a === b ? 1.0 : 0.0;
  }

  const bigramsA = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
  }

  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigramsA.get(bg) || 0;
    if (count > 0) {
      bigramsA.set(bg, count - 1);
      intersection++;
    }
  }

  return (2.0 * intersection) / (a.length - 1 + (b.length - 1));
}

/**
 * Compute keyword overlap score (weighted Jaccard + containment) between two texts.
 */
export function computeKeywordSimilarity(textA, textB) {
  const kwA = extractKeywords(textA);
  const kwB = extractKeywords(textB);
  if (kwA.length === 0 && kwB.length === 0) return 1.0;
  if (kwA.length === 0 || kwB.length === 0) return 0.0;

  const setA = new Set(kwA);
  const setB = new Set(kwB);

  let shared = 0;
  for (const token of setA) {
    if (setB.has(token)) shared++;
  }

  const union = new Set([...setA, ...setB]).size;
  const jaccard = union > 0 ? shared / union : 0;
  const containmentA = setA.size > 0 ? shared / setA.size : 0;
  const containmentB = setB.size > 0 ? shared / setB.size : 0;

  // Blend Jaccard with containment so a concise slide matching a longer source paragraph scores fairly
  return jaccard * 0.45 + Math.max(containmentA, containmentB) * 0.55;
}

/**
 * Combined semantic/lexical similarity between two text blocks (0.0 to 1.0).
 */
export function computeCombinedSimilarity(textA, textB) {
  const normA = normalizeText(textA);
  const normB = normalizeText(textB);
  if (!normA && !normB) return 1.0;
  if (!normA || !normB) return 0.0;
  if (normA === normB) return 1.0;

  const dice = computeDiceSimilarity(normA, normB);
  const kw = computeKeywordSimilarity(normA, normB);
  return dice * 0.5 + kw * 0.5;
}

/**
 * Build candidate units from crawled source pages.
 * Each candidate can be either a topical section within a page or a whole source page.
 */
function buildSourceCandidates(sourcePages) {
  const candidates = [];

  for (const page of sourcePages) {
    // 1. Add individual sections if the page has multiple sections
    if (Array.isArray(page.sections) && page.sections.length > 0) {
      page.sections.forEach((sec, idx) => {
        candidates.push({
          id: `${page.url}#section-${idx + 1}`,
          url: page.url,
          pageTitle: page.pageTitle || '',
          heading: sec.heading || page.pageTitle || '',
          headings: [{ level: sec.level || 'h2', text: sec.heading || page.pageTitle || '' }],
          paragraphs: sec.paragraphs || [],
          bulletPoints: [...(sec.bulletPoints || []), ...(sec.numberedLists || [])],
          tables: sec.tables || [],
          meaningfulText: sec.meaningfulText || '',
          isSection: true
        });
      });
    }

    // 2. Also add the full page as a candidate (for slides that summarize a whole short page)
    candidates.push({
      id: `${page.url}#full-page`,
      url: page.url,
      pageTitle: page.pageTitle || '',
      heading: page.pageTitle || page.headings?.[0]?.text || '',
      headings: page.headings || [],
      paragraphs: page.paragraphs || [],
      bulletPoints: [...(page.bulletPoints || []), ...(page.numberedLists || [])],
      tables: page.tables || [],
      meaningfulText: page.meaningfulText || '',
      isSection: false
    });
  }

  return candidates;
}

/**
 * Step 8 — Intelligently match a course slide to the best authoritative source candidate
 * using module name, subtopic name, slide title, headings, keywords, and body text similarity.
 */
export function findBestSourceMatch(slide, candidates) {
  if (!candidates || candidates.length === 0) {
    return { bestCandidate: null, confidence: 0 };
  }

  const slideTitleText = [slide.slideTitle, ...(slide.headings || []).map((h) => h.text)]
    .filter(Boolean)
    .join(' ');
  const slideTopicContext = [slide.module, slide.subtopic, slide.slideTitle]
    .filter(Boolean)
    .join(' ');
  const slideBodyText = slide.meaningfulText || '';

  let bestCandidate = null;
  let bestScore = -1;

  for (const cand of candidates) {
    const candTitleText = [
      cand.pageTitle,
      cand.heading,
      ...(cand.headings || []).map((h) => h.text)
    ]
      .filter(Boolean)
      .join(' ');

    // 1. Heading / Title similarity
    const titleSim = Math.max(
      computeCombinedSimilarity(slide.slideTitle || '', cand.heading || ''),
      computeCombinedSimilarity(slide.subtopic || '', cand.heading || ''),
      computeCombinedSimilarity(slideTitleText, candTitleText)
    );

    // 2. Topic / Subtopic context similarity
    const topicSim = computeKeywordSimilarity(slideTopicContext, `${candTitleText} ${cand.meaningfulText}`);

    // 3. Body content similarity
    const bodySim = computeCombinedSimilarity(slideBodyText, cand.meaningfulText);

    // 4. Sentence-level max containment boost (if slide sentences appear verbatim in candidate)
    const slideSentences = splitIntoSentences(slideBodyText);
    const candNorm = normalizeText(cand.meaningfulText);
    let sentenceHitRatio = 0;
    if (slideSentences.length > 0 && candNorm.length > 0) {
      let hits = 0;
      for (const s of slideSentences) {
        if (s.normalized.length > 10 && candNorm.includes(s.normalized)) {
          hits += 1;
        }
      }
      sentenceHitRatio = hits / slideSentences.length;
    }

    // Weighted composite match score
    const compositeScore =
      titleSim * 0.35 +
      bodySim * 0.4 +
      topicSim * 0.15 +
      sentenceHitRatio * 0.1 +
      (cand.isSection ? 0.02 : 0); // Slight preference for focused topical section over giant page

    if (compositeScore > bestScore) {
      bestScore = compositeScore;
      bestCandidate = cand;
    }
  }

  return {
    bestCandidate,
    confidence: Math.min(1.0, Math.max(0.0, bestScore))
  };
}

/**
 * Check if two matched sentences have a NUMBER/VALUE DIFFERENCE or POSSIBLE FACTUAL DIFFERENCE.
 */
function analyzeFactualAndNumericDifferences(courseSentence, sourceSentence) {
  const courseNums = extractNumericValues(courseSentence);
  const sourceNums = extractNumericValues(sourceSentence);

  // Check for numeric / percentage / financial discrepancy
  if (courseNums.length > 0 || sourceNums.length > 0) {
    const courseNumSet = new Set(courseNums);
    const sourceNumSet = new Set(sourceNums);
    const missingFromCourse = sourceNums.filter((n) => !courseNumSet.has(n));
    const extraInCourse = courseNums.filter((n) => !sourceNumSet.has(n));

    if (missingFromCourse.length > 0 && extraInCourse.length > 0) {
      return {
        type: 'NUMBER/VALUE DIFFERENCE',
        severity: 'CRITICAL',
        explanation: `Numeric/financial value mismatch: Course states "${extraInCourse.join(
          ', '
        )}" whereas the authoritative source states "${missingFromCourse.join(', ')}".`
      };
    }
  }

  // Check for negation / antonym polarity inversion (POSSIBLE FACTUAL DIFFERENCE)
  const coursePol = extractFactualPolarities(courseSentence);
  const sourcePol = extractFactualPolarities(sourceSentence);

  if (coursePol.hasNegation !== sourcePol.hasNegation) {
    return {
      type: 'POSSIBLE FACTUAL DIFFERENCE',
      severity: 'CRITICAL',
      explanation:
        'Contradictory negation detected between course statement and source statement (e.g., affirmative vs. negative).'
    };
  }

  for (const [pairKey, courseFlags] of Object.entries(coursePol.detectedAntonyms)) {
    const sourceFlags = sourcePol.detectedAntonyms[pairKey];
    if (sourceFlags) {
      const [termA, termB] = pairKey.split('/');
      if (
        (courseFlags[termA] && !courseFlags[termB] && sourceFlags[termB] && !sourceFlags[termA]) ||
        (courseFlags[termB] && !courseFlags[termA] && sourceFlags[termA] && !sourceFlags[termB])
      ) {
        return {
          type: 'POSSIBLE FACTUAL DIFFERENCE',
          severity: 'CRITICAL',
          explanation: `Opposing domain qualifier detected (${pairKey}): Course and source use opposite terms.`
        };
      }
    }
  }

  return null;
}

/**
 * Compare a single course slide against its matched source candidate and return all detected issues.
 */
function compareSlideWithCandidate(slide, candidate, confidence, config) {
  const issues = [];
  const exactThreshold = config.comparison?.exactMatchThreshold ?? 0.98;
  const minorThreshold = config.comparison?.minorDifferenceThreshold ?? 0.85;

  const normSlideFull = normalizeText(slide.meaningfulText);
  const normSourceFull = normalizeText(candidate.meaningfulText);

  // 1. Check for full EXACT MATCH
  if (normSlideFull === normSourceFull || normSourceFull.includes(normSlideFull)) {
    // Still check if the source section had additional critical sentences that the course omitted
    const sourceSentences = splitIntoSentences(candidate.meaningfulText);
    const slideSentences = splitIntoSentences(slide.meaningfulText);

    if (
      normSlideFull === normSourceFull ||
      sourceSentences.length <= slideSentences.length
    ) {
      return {
        status: 'EXACT MATCH',
        issues: []
      };
    }
  }

  // 2. Compare Headings (MISSING HEADING / CHANGED HEADING)
  const slideHeadings = (slide.headings || []).map((h) => h.text).filter(Boolean);
  const sourceHeadings = [
    candidate.heading,
    ...(candidate.headings || []).map((h) => h.text)
  ].filter(Boolean);

  if (sourceHeadings.length > 0 && slideHeadings.length === 0 && !slide.slideTitle) {
    issues.push({
      module: slide.module,
      subtopic: slide.subtopic,
      slide: slide.slideNumber,
      courseText: '(No heading present on slide)',
      sourceText: sourceHeadings[0],
      sourceUrl: candidate.url,
      differenceType: 'MISSING HEADING',
      severity: 'LOW',
      explanation: `The slide is missing the section heading "${sourceHeadings[0]}".`
    });
  } else if (slide.slideTitle && candidate.heading) {
    const headingSim = computeCombinedSimilarity(slide.slideTitle, candidate.heading);
    const subtopicSim = computeCombinedSimilarity(slide.subtopic, candidate.heading);
    if (headingSim < 0.65 && subtopicSim < 0.65 && headingSim > 0.25) {
      issues.push({
        module: slide.module,
        subtopic: slide.subtopic,
        slide: slide.slideNumber,
        courseText: slide.slideTitle,
        sourceText: candidate.heading,
        sourceUrl: candidate.url,
        differenceType: 'CHANGED HEADING',
        severity: 'LOW',
        explanation: `Slide heading "${slide.slideTitle}" differs from source heading "${candidate.heading}".`
      });
    }
  }

  // 3. Compare Bullet Points (MISSING BULLET / CHANGED BULLET)
  const slideBullets = [...(slide.bulletPoints || []), ...(slide.numberedLists || [])];
  const sourceBullets = candidate.bulletPoints || [];

  if (sourceBullets.length > 0 && slideBullets.length > 0) {
    const matchedSourceBulletIndices = new Set();

    for (const cBullet of slideBullets) {
      const normCB = normalizeText(cBullet);
      let bestIdx = -1;
      let bestSim = 0;

      sourceBullets.forEach((sBullet, idx) => {
        const sim = computeCombinedSimilarity(cBullet, sBullet);
        if (sim > bestSim) {
          bestSim = sim;
          bestIdx = idx;
        }
      });

      if (bestIdx !== -1 && bestSim >= 0.4) {
        matchedSourceBulletIndices.add(bestIdx);
        const sBullet = sourceBullets[bestIdx];
        if (normalizeText(sBullet) !== normCB) {
          const factualIssue = analyzeFactualAndNumericDifferences(cBullet, sBullet);
          if (factualIssue) {
            issues.push({
              module: slide.module,
              subtopic: slide.subtopic,
              slide: slide.slideNumber,
              courseText: cBullet,
              sourceText: sBullet,
              sourceUrl: candidate.url,
              differenceType: factualIssue.type,
              severity: factualIssue.severity,
              explanation: factualIssue.explanation
            });
          } else if (bestSim < exactThreshold) {
            issues.push({
              module: slide.module,
              subtopic: slide.subtopic,
              slide: slide.slideNumber,
              courseText: cBullet,
              sourceText: sBullet,
              sourceUrl: candidate.url,
              differenceType:
                bestSim >= minorThreshold ? 'MINOR WORDING DIFFERENCE' : 'CHANGED BULLET',
              severity: bestSim >= minorThreshold ? 'LOW' : 'MEDIUM',
              explanation:
                bestSim >= minorThreshold
                  ? 'Bullet point has minor wording differences compared to the source.'
                  : 'Bullet point wording has been significantly altered from the source bullet.'
            });
          }
        }
      }
    }

    // Check for source bullets that were completely omitted from the slide
    sourceBullets.forEach((sBullet, idx) => {
      if (!matchedSourceBulletIndices.has(idx)) {
        const normSB = normalizeText(sBullet);
        if (!normSlideFull.includes(normSB)) {
          issues.push({
            module: slide.module,
            subtopic: slide.subtopic,
            slide: slide.slideNumber,
            courseText: slideBullets.join(' | ') || slide.meaningfulText,
            sourceText: sBullet,
            sourceUrl: candidate.url,
            differenceType: 'MISSING BULLET',
            severity: 'MEDIUM',
            explanation: `The course slide is missing the bullet item: "${sBullet}".`
          });
        }
      }
    });
  }

  // 4. Sentence-level Comparison for Paragraphs / Full Text
  // (EXACT MATCH, MINOR WORDING DIFFERENCE, CHANGED CONTENT, MISSING CONTENT, EXTRA CONTENT, NUMBER/VALUE DIFFERENCE, POSSIBLE FACTUAL DIFFERENCE)
  const slideSentences = splitIntoSentences(
    [...(slide.paragraphs || []), ...(slide.labels || [])].join('\n') || slide.meaningfulText
  ).filter((s) => s.normalized !== normalizeText(slide.slideTitle));

  const sourceSentences = splitIntoSentences(
    (candidate.paragraphs || []).join('\n') || candidate.meaningfulText
  ).filter((s) => s.normalized !== normalizeText(candidate.heading));

  const matchedSourceSentIndices = new Set();

  for (const cSent of slideSentences) {
    let bestIdx = -1;
    let bestSim = 0;

    sourceSentences.forEach((sSent, idx) => {
      const sim = computeCombinedSimilarity(cSent.normalized, sSent.normalized);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = idx;
      }
    });

    if (bestIdx !== -1 && bestSim >= 0.38) {
      matchedSourceSentIndices.add(bestIdx);
      const sSent = sourceSentences[bestIdx];

      if (cSent.normalized !== sSent.normalized && !normSourceFull.includes(cSent.normalized)) {
        // Check for numeric or factual difference first
        const factualOrNumeric = analyzeFactualAndNumericDifferences(cSent.raw, sSent.raw);
        if (factualOrNumeric) {
          issues.push({
            module: slide.module,
            subtopic: slide.subtopic,
            slide: slide.slideNumber,
            courseText: cSent.raw,
            sourceText: sSent.raw,
            sourceUrl: candidate.url,
            differenceType: factualOrNumeric.type,
            severity: factualOrNumeric.severity,
            explanation: factualOrNumeric.explanation
          });
        } else if (bestSim >= minorThreshold && bestSim < exactThreshold) {
          issues.push({
            module: slide.module,
            subtopic: slide.subtopic,
            slide: slide.slideNumber,
            courseText: cSent.raw,
            sourceText: sSent.raw,
            sourceUrl: candidate.url,
            differenceType: 'MINOR WORDING DIFFERENCE',
            severity: 'LOW',
            explanation:
              'The course sentence has minor phrasing differences from the source without changing core meaning.'
          });
        } else if (bestSim < minorThreshold) {
          issues.push({
            module: slide.module,
            subtopic: slide.subtopic,
            slide: slide.slideNumber,
            courseText: cSent.raw,
            sourceText: sSent.raw,
            sourceUrl: candidate.url,
            differenceType: 'CHANGED CONTENT',
            severity: 'MEDIUM',
            explanation:
              'The course statement differs substantially from the corresponding statement in the source.'
          });
        }
      }
    } else if (!normSourceFull.includes(cSent.normalized) && cSent.normalized.split(' ').length >= 5) {
      // Course has a substantive sentence not found anywhere in the matched source section
      issues.push({
        module: slide.module,
        subtopic: slide.subtopic,
        slide: slide.slideNumber,
        courseText: cSent.raw,
        sourceText: candidate.meaningfulText,
        sourceUrl: candidate.url,
        differenceType: 'EXTRA CONTENT',
        severity: 'LOW',
        explanation:
          'The course contains additional statement(s) not present in the matched authoritative source section.'
      });
    }
  }

  // Check for MISSING CONTENT (sentences in the matched source section that are missing from the course slide)
  const missingSourceSentences = [];
  sourceSentences.forEach((sSent, idx) => {
    if (!matchedSourceSentIndices.has(idx)) {
      if (
        !normSlideFull.includes(sSent.normalized) &&
        sSent.normalized.split(' ').length >= 4
      ) {
        missingSourceSentences.push(sSent.raw);
      }
    }
  });

  if (missingSourceSentences.length > 0) {
    issues.push({
      module: slide.module,
      subtopic: slide.subtopic,
      slide: slide.slideNumber,
      courseText: (slide.paragraphs || []).join(' ') || slide.meaningfulText,
      sourceText: candidate.paragraphs?.join(' ') || candidate.meaningfulText,
      sourceUrl: candidate.url,
      differenceType: 'MISSING CONTENT',
      severity: missingSourceSentences.length > 1 ? 'HIGH' : 'MEDIUM',
      explanation: `The course appears to be missing ${
        missingSourceSentences.length === 1
          ? 'a sentence from the source: "' + missingSourceSentences[0] + '"'
          : missingSourceSentences.length +
            ' sentences from the source: "' +
            missingSourceSentences.join(' ') +
            '"'
      }`
    });
  }

  return {
    status: issues.length === 0 ? 'EXACT MATCH' : 'DIFFERENCES FOUND',
    issues
  };
}

/**
 * Step 7 & Step 8 — Compare all extracted course slides against the extracted source pages.
 * Detects all 13 difference types + REVIEW REQUIRED, saves results to data/reports/comparison-results.json.
 */
export function compareCourseAndSource(config, errorLogger) {
  console.log('\n==================================================');
  console.log('STEP 6, 7 & 8 — NORMALIZING, MATCHING & COMPARING CONTENT');
  console.log('==================================================');

  if (!fs.existsSync(config.paths.courseContent)) {
    throw new Error(
      `Course content file not found at ${config.paths.courseContent}. Run \`npm run crawl\` first.`
    );
  }
  if (!fs.existsSync(config.paths.sourceContent)) {
    throw new Error(
      `Source content file not found at ${config.paths.sourceContent}. Run \`npm run crawl\` first.`
    );
  }

  const courseData = JSON.parse(fs.readFileSync(config.paths.courseContent, 'utf-8'));
  const sourceData = JSON.parse(fs.readFileSync(config.paths.sourceContent, 'utf-8'));

  let manifest = null;
  if (fs.existsSync(config.paths.manifest)) {
    try {
      manifest = JSON.parse(fs.readFileSync(config.paths.manifest, 'utf-8'));
    } catch {
      manifest = null;
    }
  }

  const slides = courseData.slides || [];
  const sourcePages = sourceData.pages || [];
  const candidates = buildSourceCandidates(sourcePages);

  const matchThreshold = config.comparison?.matchConfidenceThreshold ?? 0.32;
  const allIssues = [];
  const slideComparisons = [];
  const seenSlideTextMap = new Map();
  const matchedSectionIds = new Set();

  let exactMatchesCount = 0;
  let reviewRequiredCount = 0;

  for (const slide of slides) {
    const normSlideBody = normalizeText(slide.meaningfulText);

    // Check for DUPLICATE CONTENT across slides
    if (normSlideBody.length > 25) {
      if (seenSlideTextMap.has(normSlideBody)) {
        const prev = seenSlideTextMap.get(normSlideBody);
        allIssues.push({
          module: slide.module,
          subtopic: slide.subtopic,
          slide: slide.slideNumber,
          courseText: slide.meaningfulText,
          sourceText: `Duplicate of Module "${prev.module}" -> Subtopic "${prev.subtopic}" -> Slide ${prev.slideNumber}`,
          sourceUrl: slide.url || 'N/A',
          differenceType: 'DUPLICATE CONTENT',
          severity: 'LOW',
          explanation: `This slide duplicates the exact content already presented in "${prev.subtopic}" (Slide ${prev.slideNumber}).`
        });
      } else {
        seenSlideTextMap.set(normSlideBody, slide);
      }
    }

    // Match slide to best source candidate (Step 8)
    const { bestCandidate, confidence } = findBestSourceMatch(slide, candidates);

    if (!bestCandidate || confidence < matchThreshold) {
      reviewRequiredCount += 1;
      const reviewIssue = {
        module: slide.module,
        subtopic: slide.subtopic,
        slide: slide.slideNumber,
        courseText: slide.meaningfulText || slide.slideTitle,
        sourceText: bestCandidate
          ? `[Closest candidate (${(confidence * 100).toFixed(0)}% confidence): "${
              bestCandidate.heading
            }"] ${bestCandidate.meaningfulText.slice(0, 300)}`
          : 'No matching source page found.',
        sourceUrl: bestCandidate?.url || 'N/A',
        differenceType: 'REVIEW REQUIRED',
        severity: 'MEDIUM',
        explanation:
          'An exact authoritative source match could not be confidently determined automatically. Marked REVIEW REQUIRED for human verification.'
      };
      allIssues.push(reviewIssue);
      slideComparisons.push({
        module: slide.module,
        subtopic: slide.subtopic,
        slideNumber: slide.slideNumber,
        slideTitle: slide.slideTitle,
        matchStatus: 'REVIEW REQUIRED',
        matchConfidence: Number(confidence.toFixed(3)),
        matchedSourceUrl: bestCandidate?.url || null,
        matchedSourceHeading: bestCandidate?.heading || null,
        issues: [reviewIssue]
      });
      continue;
    }

    matchedSectionIds.add(bestCandidate.id);

    const comparison = compareSlideWithCandidate(slide, bestCandidate, confidence, config);
    if (comparison.status === 'EXACT MATCH') {
      exactMatchesCount += 1;
    } else {
      allIssues.push(...comparison.issues);
    }

    slideComparisons.push({
      module: slide.module,
      subtopic: slide.subtopic,
      slideNumber: slide.slideNumber,
      slideTitle: slide.slideTitle,
      matchStatus: comparison.status,
      matchConfidence: Number(confidence.toFixed(3)),
      matchedSourceUrl: bestCandidate.url,
      matchedSourceHeading: bestCandidate.heading,
      issues: comparison.issues
    });
  }

  // Check for MISSING SLIDE:
  // 1) If a subtopic in the manifest had 0 slides extracted, OR
  // 2) If a source section clearly belongs to a crawled course subtopic/module by title but has no slide covering it
  if (manifest && Array.isArray(manifest.modules)) {
    for (const mod of manifest.modules) {
      for (const sub of mod.subtopics || []) {
        const subSlides = slides.filter(
          (s) => s.module === mod.name && s.subtopic === sub.name
        );
        if (subSlides.length === 0 && !config.crawl?.singleTestMode) {
          allIssues.push({
            module: mod.name,
            subtopic: sub.name,
            slide: 'N/A',
            courseText: '(No slides found in subtopic)',
            sourceText: `Expected slide content for subtopic "${sub.name}"`,
            sourceUrl: sub.url || 'N/A',
            differenceType: 'MISSING SLIDE',
            severity: 'HIGH',
            explanation: `Subtopic "${sub.name}" in module "${mod.name}" contains no extractable slides.`
          });
        }
      }
    }
  }

  // Also check if any source section on a matched page was completely skipped (MISSING SLIDE)
  if (!config.crawl?.singleTestMode && slides.length > 0) {
    const matchedPageUrls = new Set(
      slideComparisons.map((sc) => sc.matchedSourceUrl).filter(Boolean)
    );
    const sectionCandidatesOnMatchedPages = candidates.filter(
      (c) => c.isSection && matchedPageUrls.has(c.url) && !matchedSectionIds.has(c.id)
    );

    for (const unmatchedSec of sectionCandidatesOnMatchedPages) {
      // Check if its content was already covered inside another slide's text
      const normSec = normalizeText(unmatchedSec.meaningfulText);
      if (normSec.length < 40) continue;

      const coveredByAnySlide = slides.some(
        (s) => computeCombinedSimilarity(s.meaningfulText, unmatchedSec.meaningfulText) >= 0.45
      );

      if (!coveredByAnySlide) {
        // Associate with the module/subtopic that matched this source page
        const relatedSlide =
          slideComparisons.find((sc) => sc.matchedSourceUrl === unmatchedSec.url) || slides[0];
        allIssues.push({
          module: relatedSlide.module || 'Course',
          subtopic: relatedSlide.subtopic || unmatchedSec.pageTitle || 'General',
          slide: 'Missing',
          courseText: '(No corresponding slide found in course)',
          sourceText: `${unmatchedSec.heading}: ${unmatchedSec.meaningfulText}`,
          sourceUrl: unmatchedSec.url,
          differenceType: 'MISSING SLIDE',
          severity: 'HIGH',
          explanation: `The source website contains a section titled "${unmatchedSec.heading}" on a matched reference page, but no corresponding slide was found in the course.`
        });
      }
    }
  }

  // Compute summary metrics
  const totalModules = manifest?.modules?.length || new Set(slides.map((s) => s.module)).size;
  const totalSubtopics =
    manifest?.modules?.reduce((acc, m) => acc + (m.subtopics?.length || 0), 0) ||
    new Set(slides.map((s) => `${s.module}::${s.subtopic}`)).size;
  const totalSlides = slides.length;

  const minorDifferences = allIssues.filter(
    (i) => i.differenceType === 'MINOR WORDING DIFFERENCE' || i.severity === 'LOW'
  ).length;
  const missingContent = allIssues.filter((i) =>
    ['MISSING CONTENT', 'MISSING HEADING', 'MISSING BULLET', 'MISSING SLIDE'].includes(
      i.differenceType
    )
  ).length;
  const majorDifferences = allIssues.filter(
    (i) =>
      i.severity === 'HIGH' ||
      (i.severity === 'MEDIUM' && i.differenceType !== 'REVIEW REQUIRED')
  ).length;
  const criticalErrors = allIssues.filter((i) => i.severity === 'CRITICAL').length;

  const result = {
    course: courseData.course || manifest?.course || config.courseName || 'Online Course',
    courseUrl: courseData.courseUrl || config.courseUrl,
    sourceUrl: sourceData.sourceUrl || config.sourceUrl,
    auditDate: new Date().toISOString().split('T')[0],
    auditedAt: new Date().toISOString(),
    summary: {
      totalModules,
      totalSubtopics,
      totalSlides,
      matched: exactMatchesCount,
      minorDifferences,
      missingContent,
      majorDifferences,
      criticalErrors,
      reviewRequired: reviewRequiredCount,
      totalIssues: allIssues.length
    },
    issues: allIssues,
    slideComparisons,
    crawlErrors: errorLogger ? errorLogger.getAll() : []
  };

  fs.writeFileSync(
    config.paths.comparisonResults,
    JSON.stringify(result, null, 2),
    'utf-8'
  );

  console.log(`[Comparison Complete] Total slides compared: ${totalSlides}`);
  console.log(
    `[Comparison Complete] Exact Matches: ${exactMatchesCount} | Issues Found: ${allIssues.length} | Review Required: ${reviewRequiredCount}`
  );
  console.log(`[Comparison Complete] Saved comparison results to: ${config.paths.comparisonResults}`);

  return result;
}
