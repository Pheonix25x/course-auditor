import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..', '..');

// Load .env from project root if present
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

/**
 * Deep merge two configuration objects
 */
function deepMerge(target, source) {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach((key) => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = deepMerge(target[key], source[key]);
        }
      } else if (source[key] !== undefined && source[key] !== '') {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

function parseBool(val, defaultVal) {
  if (val === undefined || val === null || val === '') return defaultVal;
  if (typeof val === 'boolean') return val;
  return ['true', '1', 'yes', 'y'].includes(String(val).toLowerCase().trim());
}

function parseIntSafe(val, defaultVal) {
  if (val === undefined || val === null || val === '') return defaultVal;
  const parsed = Number.parseInt(String(val), 10);
  return Number.isNaN(parsed) ? defaultVal : parsed;
}

/**
 * Load configuration from config/config.example.json, config/config.json (if present),
 * environment variables (.env), and CLI flags.
 */
export function loadConfig(cliOptions = {}) {
  const exampleConfigPath = path.join(ROOT_DIR, 'config', 'config.example.json');
  const userConfigPath = path.join(ROOT_DIR, 'config', 'config.json');

  let baseConfig = {};
  if (fs.existsSync(exampleConfigPath)) {
    baseConfig = JSON.parse(fs.readFileSync(exampleConfigPath, 'utf-8'));
  }

  if (fs.existsSync(userConfigPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
      baseConfig = deepMerge(baseConfig, userConfig);
    } catch (err) {
      console.warn(`[Config] Warning: Failed to parse config/config.json: ${err.message}`);
    }
  }

  // Override with environment variables if provided
  const envOverrides = {
    courseUrl: process.env.COURSE_URL || baseConfig.courseUrl || '',
    sourceUrl: process.env.SOURCE_URL || baseConfig.sourceUrl || '',
    courseName: process.env.COURSE_NAME || baseConfig.courseName || '',
    googleDocId: process.env.GOOGLE_DOC_ID || baseConfig.googleDocId || '',
    browser: {
      headless: parseBool(process.env.HEADLESS, baseConfig.browser?.headless ?? false),
      slowMo: parseIntSafe(process.env.SLOW_MO, baseConfig.browser?.slowMo ?? 50),
      navigationTimeoutMs: parseIntSafe(
        process.env.NAVIGATION_TIMEOUT_MS,
        baseConfig.browser?.navigationTimeoutMs ?? 45000
      ),
      slideWaitMs: parseIntSafe(
        process.env.SLIDE_WAIT_MS,
        baseConfig.browser?.slideWaitMs ?? 1500
      )
    },
    crawl: {
      resumeEnabled: parseBool(
        process.env.RESUME_ENABLED,
        baseConfig.crawl?.resumeEnabled ?? true
      ),
      singleTestMode: parseBool(
        process.env.SINGLE_TEST_MODE,
        baseConfig.crawl?.singleTestMode ?? false
      ),
      maxSourcePages: parseIntSafe(
        process.env.MAX_SOURCE_PAGES,
        baseConfig.crawl?.maxSourcePages ?? 200
      )
    }
  };

  const merged = deepMerge(baseConfig, envOverrides);

  // Apply CLI options overrides
  if (cliOptions.single) {
    merged.crawl.singleTestMode = true;
    merged.crawl.maxModules = 1;
    merged.crawl.maxSubtopicsPerModule = 1;
    merged.crawl.maxSlidesPerSubtopic = 1;
  }
  if (cliOptions.fresh) {
    merged.crawl.resumeEnabled = false;
  }
  if (cliOptions.headless !== undefined) {
    merged.browser.headless = cliOptions.headless;
  }

  // Standard file system paths
  merged.paths = {
    root: ROOT_DIR,
    authDir: path.join(ROOT_DIR, 'auth'),
    browserState: path.join(ROOT_DIR, 'auth', 'browser-state.json'),
    courseDataDir: path.join(ROOT_DIR, 'data', 'course'),
    manifest: path.join(ROOT_DIR, 'data', 'course', 'manifest.json'),
    courseContent: path.join(ROOT_DIR, 'data', 'course', 'course-content.json'),
    progress: path.join(ROOT_DIR, 'data', 'course', 'progress.json'),
    domInspection: path.join(ROOT_DIR, 'data', 'course', 'dom-inspection.json'),
    sourceDataDir: path.join(ROOT_DIR, 'data', 'source'),
    sourceContent: path.join(ROOT_DIR, 'data', 'source', 'source-content.json'),
    reportsDir: path.join(ROOT_DIR, 'data', 'reports'),
    comparisonResults: path.join(ROOT_DIR, 'data', 'reports', 'comparison-results.json'),
    crawlErrors: path.join(ROOT_DIR, 'data', 'reports', 'crawl-errors.json'),
    reportJson: path.join(ROOT_DIR, 'data', 'reports', 'audit-report.json'),
    reportHtml: path.join(ROOT_DIR, 'data', 'reports', 'audit-report.html'),
    reportMd: path.join(ROOT_DIR, 'data', 'reports', 'audit-report.md'),
    googleCredentials: path.resolve(
      ROOT_DIR,
      process.env.GOOGLE_CREDENTIALS_PATH || './credentials/google-credentials.json'
    ),
    googleToken: path.resolve(
      ROOT_DIR,
      process.env.GOOGLE_TOKEN_PATH || './credentials/google-token.json'
    )
  };

  // Ensure data directories exist
  for (const dir of [
    merged.paths.authDir,
    merged.paths.courseDataDir,
    merged.paths.sourceDataDir,
    merged.paths.reportsDir
  ]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return merged;
}
