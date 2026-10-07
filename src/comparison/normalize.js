/**
 * Step 6 — Content Normalization
 * Normalizes text for comparison while strictly preserving meaningful numbers,
 * percentages, dates, financial values, and domain/legal/medical/technical terminology.
 */

const HTML_ENTITIES = {
  '&amp;': 'and',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '-',
  '&mdash;': '-'
};

/**
 * Strip HTML tags and decode common HTML entities.
 */
export function stripHtml(text) {
  if (!text) return '';
  let cleaned = String(text).replace(/<[^>]+>/g, ' ');
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    cleaned = cleaned.split(entity).join(replacement);
  }
  return cleaned;
}

/**
 * Normalize text for fair content comparison:
 * - Lowercases text
 * - Normalizes smart quotes, dashes, and typographic symbols
 * - Preserves numbers, decimals (e.g. 3.5), percentages (5%), currency ($1,000 -> $1000),
 *   dates, and alphanumeric technical/legal/medical terms
 * - Removes harmless punctuation (commas, periods at end of sentences, colons, semicolons, quotes)
 * - Collapses extra whitespace and line breaks
 */
export function normalizeText(text) {
  if (!text) return '';

  let norm = stripHtml(text)
    .toLowerCase()
    // Normalize typographic quotes and apostrophes
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035`']/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036"]/g, ' ')
    // Normalize en-dash / em-dash / hyphens to spaces unless between digits
    .replace(/(\d)\s*[\u2013\u2014-]\s*(\d)/g, '$1-$2')
    .replace(/[\u2013\u2014]/g, ' ')
    // Normalize bullet characters
    .replace(/^[\s•·▪▸►\-*]+/gm, ' ')
    // Normalize commas inside numbers (e.g. $10,000 -> $10000) so formatting doesn't break numeric match
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    // Preserve decimal points between digits (e.g. 3.14), remove sentence punctuation
    .replace(/(\d)\.(\d)/g, '$1__DEC__$2')
    // Remove non-essential punctuation while keeping $, %, /, -, and alphanumeric words
    .replace(/[.,;:!?()[\]{}<>|\\~^•·]/g, ' ')
    .replace(/__DEC__/g, '.')
    // Collapse multiple spaces, tabs, and newlines
    .replace(/\s+/g, ' ')
    .trim();

  return norm;
}

/**
 * Split a block of text into individual sentences (preserving original casing for display,
 * alongside normalized form for comparison).
 */
export function splitIntoSentences(text) {
  if (!text) return [];
  const rawLines = String(text)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const sentences = [];
  for (const line of rawLines) {
    // Split on sentence boundaries (. ! ?) that are not decimals or common abbreviations
    const parts = line
      .replace(/([.!?])\s+(?=[A-Z0-9"“•])/g, '$1\n')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const part of parts) {
      const normalized = normalizeText(part);
      if (normalized.length > 0) {
        sentences.push({
          raw: part.replace(/^[\s•·\-*]+/, '').trim(),
          normalized
        });
      }
    }
  }
  return sentences;
}

/**
 * Tokenize normalized text into meaningful keywords (excluding ultra-common filler stopwords,
 * while keeping numbers, domain terms, and negation words).
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'as',
  'by',
  'at',
  'from',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'and',
  'or',
  'if',
  'then',
  'so',
  'such',
  'into',
  'about',
  'which',
  'who',
  'whom',
  'can',
  'will',
  'may',
  'also',
  'has',
  'have',
  'had'
]);

export function extractKeywords(text) {
  const norm = normalizeText(text);
  if (!norm) return [];
  return norm
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Extract numbers, percentages, currency values, and dates from text.
 * Used to detect NUMBER/VALUE DIFFERENCE with high precision.
 */
export function extractNumericValues(text) {
  if (!text) return [];
  const cleaned = String(text)
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/(\d),(\d{3})\b/g, '$1$2');

  // Matches currency ($500, $1000.50), percentages (12.5%), ranges (10-15), or standalone numbers
  const matches = cleaned.match(/[$€£¥]?\d+(?:\.\d+)?%?(?:-\d+(?:\.\d+)?%?)?/g) || [];
  return matches.map((m) => m.toLowerCase());
}

/**
 * Extract negation or critical qualifier tokens from a sentence to detect
 * POSSIBLE FACTUAL DIFFERENCE (e.g. "is guaranteed" vs "is not guaranteed", "fixed" vs "variable").
 */
export function extractFactualPolarities(text) {
  const norm = ` ${normalizeText(text)} `;
  const negations = (
    norm.match(/\b(not|never|no|none|neither|nor|cannot|cant|without|prohibited|excluded|unlawful)\b/g) ||
    []
  ).length;

  const antonymPairs = [
    ['fixed', 'variable'],
    ['guaranteed', 'non-guaranteed'],
    ['mandatory', 'optional'],
    ['required', 'optional'],
    ['taxable', 'tax-free'],
    ['permanent', 'temporary'],
    ['active', 'passive'],
    ['minimum', 'maximum'],
    ['before', 'after'],
    ['increase', 'decrease'],
    ['include', 'exclude'],
    ['always', 'never']
  ];

  const detectedAntonyms = {};
  for (const [a, b] of antonymPairs) {
    const hasA = new RegExp(`\\b${a}\\b`, 'i').test(norm);
    const hasB = new RegExp(`\\b${b}\\b`, 'i').test(norm);
    if (hasA || hasB) {
      detectedAntonyms[`${a}/${b}`] = { [a]: hasA, [b]: hasB };
    }
  }

  return {
    hasNegation: negations % 2 === 1,
    negationCount: negations,
    detectedAntonyms
  };
}
