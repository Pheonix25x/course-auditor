import fs from 'fs';
import path from 'path';

/**
 * Structured error logger for Step 12 — Error Handling.
 * Captures URL, module, subtopic, slide, stage, and error message,
 * persists to disk so errors survive restarts, and exposes all logged errors for reporting.
 */
export class ErrorLogger {
  constructor(errorFilePath) {
    this.errorFilePath = errorFilePath;
    this.errors = [];
    this.loadExisting();
  }

  loadExisting() {
    try {
      if (this.errorFilePath && fs.existsSync(this.errorFilePath)) {
        const raw = fs.readFileSync(this.errorFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.errors = parsed;
        }
      }
    } catch {
      this.errors = [];
    }
  }

  clear() {
    this.errors = [];
    this.save();
  }

  /**
   * Log an error without crashing the overall audit.
   * @param {Object} details
   * @param {string} [details.stage] - e.g. 'LOGIN', 'COURSE_DISCOVERY', 'SLIDE_EXTRACTION', 'SOURCE_CRAWL', 'GOOGLE_DOCS'
   * @param {string} [details.url]
   * @param {string} [details.module]
   * @param {string} [details.subtopic]
   * @param {string|number} [details.slide]
   * @param {string} details.message
   * @param {Error} [details.error]
   */
  log({
    stage = 'GENERAL',
    url = '',
    module = '',
    subtopic = '',
    slide = '',
    message = 'Unknown error',
    error = null
  }) {
    const entry = {
      timestamp: new Date().toISOString(),
      stage,
      url: url || 'N/A',
      module: module || 'N/A',
      subtopic: subtopic || 'N/A',
      slide: slide !== undefined && slide !== null && slide !== '' ? String(slide) : 'N/A',
      errorMessage: error ? `${message}: ${error.message}` : message
    };

    this.errors.push(entry);
    this.save();

    console.error(
      `\n[ERROR][${entry.stage}] ${entry.errorMessage}\n` +
        `  URL: ${entry.url} | Module: ${entry.module} | Subtopic: ${entry.subtopic} | Slide: ${entry.slide}`
    );

    return entry;
  }

  save() {
    if (!this.errorFilePath) return;
    try {
      const dir = path.dirname(this.errorFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.errorFilePath, JSON.stringify(this.errors, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[ErrorLogger] Failed to write error log: ${err.message}`);
    }
  }

  getAll() {
    return this.errors;
  }
}
