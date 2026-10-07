#!/usr/bin/env node
import { loadConfig } from './src/config/index.js';
import { ErrorLogger } from './src/utils/errorLogger.js';
import { performInteractiveLogin, getAuthenticatedCourseSession } from './src/auth/login.js';
import { inspectCourseDom } from './src/course/inspectDom.js';
import { crawlCourse } from './src/course/crawlCourse.js';
import { crawlSourceWebsite } from './src/source/crawlSource.js';
import { compareCourseAndSource } from './src/comparison/compare.js';
import { generateReports } from './src/reports/generateReport.js';
import { exportReportToGoogleDocs } from './src/google/googleDocs.js';

/**
 * Parse command-line arguments and flags.
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.find((a) => !a.startsWith('-')) || 'audit';
  return {
    command: command.toLowerCase(),
    single: args.includes('--single') || args.includes('-s'),
    fresh: args.includes('--fresh'),
    courseOnly: args.includes('--course-only'),
    sourceOnly: args.includes('--source-only'),
    headless: args.includes('--headless')
      ? true
      : args.includes('--headed')
      ? false
      : undefined
  };
}

async function main() {
  const cliOptions = parseArgs(process.argv);
  const config = loadConfig(cliOptions);
  const errorLogger = new ErrorLogger(config.paths.crawlErrors);

  console.log('==================================================');
  console.log(`COURSE CONTENT AUDITOR — Command: "${cliOptions.command}"`);
  console.log('==================================================');

  try {
    switch (cliOptions.command) {
      case 'login': {
        await performInteractiveLogin(config, errorLogger);
        break;
      }

      case 'inspect': {
        const { browser, page } = await getAuthenticatedCourseSession(config, errorLogger);
        try {
          const report = await inspectCourseDom(page, config);
          console.log('\n[DOM Inspection Summary]');
          for (const frame of report.frames) {
            console.log(`- Frame: ${frame.frameLabel} | URL: ${frame.url || 'N/A'}`);
            console.log(`  Headings found:           ${frame.headings?.length || 0}`);
            console.log(`  Navigation candidates:    ${frame.navCandidates?.length || 0}`);
            console.log(`  Next/Prev btn candidates: ${frame.buttonCandidates?.length || 0}`);
            console.log(`  Content containers:       ${frame.contentCandidates?.length || 0}`);
          }
        } finally {
          await browser.close().catch(() => {});
        }
        break;
      }

      case 'crawl': {
        if (!cliOptions.sourceOnly) {
          await crawlCourse(config, errorLogger);
        }
        if (!cliOptions.courseOnly && config.sourceUrl) {
          await crawlSourceWebsite(config, errorLogger);
        } else if (!cliOptions.courseOnly && !config.sourceUrl) {
          console.log(
            '\n[Notice] SOURCE_URL is not set yet; skipped source website crawl. Set SOURCE_URL in .env to crawl the source site.'
          );
        }
        break;
      }

      case 'compare': {
        compareCourseAndSource(config, errorLogger);
        break;
      }

      case 'report': {
        generateReports(config, errorLogger);
        break;
      }

      case 'google-doc': {
        const { auditData } = generateReports(config, errorLogger);
        await exportReportToGoogleDocs(auditData, config, errorLogger);
        break;
      }

      case 'audit': {
        // Full end-to-end audit workflow:
        // login/session check -> course crawl -> source crawl -> normalization & comparison -> local reports -> Google Docs
        errorLogger.clear();

        await crawlCourse(config, errorLogger);
        await crawlSourceWebsite(config, errorLogger);
        compareCourseAndSource(config, errorLogger);
        const { auditData } = generateReports(config, errorLogger);
        await exportReportToGoogleDocs(auditData, config, errorLogger);

        console.log('\n==================================================');
        console.log('AUDIT WORKFLOW COMPLETE');
        console.log('==================================================');
        console.log(`- Course Manifest:  ${config.paths.manifest}`);
        console.log(`- Course Content:   ${config.paths.courseContent}`);
        console.log(`- Source Content:   ${config.paths.sourceContent}`);
        console.log(`- JSON Report:      ${config.paths.reportJson}`);
        console.log(`- Markdown Report:  ${config.paths.reportMd}`);
        console.log(`- HTML Report:      ${config.paths.reportHtml}`);
        break;
      }

      default: {
        console.error(
          `Unknown command: "${cliOptions.command}". Available commands: login, inspect, crawl, compare, report, audit`
        );
        process.exitCode = 1;
      }
    }
  } catch (err) {
    console.error(`\n[FATAL ERROR] ${err.message}`);
    process.exitCode = 1;
  }
}

main();
