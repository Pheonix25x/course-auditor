import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file'
];

/**
 * Load or obtain an authenticated Google OAuth2 / Service Account client.
 * Returns null if credentials are not configured yet.
 */
async function getGoogleAuthClient(config) {
  const credPath = config.paths.googleCredentials;
  const tokenPath = config.paths.googleToken;

  if (!fs.existsSync(credPath)) {
    return null;
  }

  const rawCreds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));

  // Case 1: Service Account JSON
  if (rawCreds.type === 'service_account') {
    const auth = new google.auth.GoogleAuth({
      keyFile: credPath,
      scopes: SCOPES
    });
    return auth.getClient();
  }

  // Case 2: OAuth 2.0 Client ID (installed / desktop or web application)
  const clientConfig = rawCreds.installed || rawCreds.web;
  if (!clientConfig) {
    throw new Error(
      'Invalid Google credentials JSON format. Expected an OAuth 2.0 Client ID ("installed" or "web") or a "service_account" key file.'
    );
  }

  const { client_secret, client_id, redirect_uris } = clientConfig;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob'
  );

  if (fs.existsSync(tokenPath)) {
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // Interactive OAuth2 authorization if token does not exist yet
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });

  console.log('\n[Google Docs] First-time Google OAuth authorization required.');
  console.log('1. Open this URL in your browser:\n   ' + authUrl);

  const code = await new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question('\n2. Paste the authorization code from the browser here: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  const tokenDir = path.dirname(tokenPath);
  if (!fs.existsSync(tokenDir)) {
    fs.mkdirSync(tokenDir, { recursive: true });
  }
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), 'utf-8');
  console.log(`[Google Docs] OAuth token saved to: ${tokenPath}`);

  return oAuth2Client;
}

/**
 * Build Google Docs batchUpdate requests to insert formatted headings, summary,
 * and issues grouped by severity (CRITICAL, HIGH, MEDIUM, LOW).
 */
function buildGoogleDocRequests(auditData) {
  const { course, courseUrl, sourceUrl, auditDate, summary, issues = [], crawlErrors = [] } =
    auditData;

  const segments = [];
  const pushHeading = (text, style = 'HEADING_1') => {
    segments.push({ text: `${text}\n`, headingStyle: style });
  };
  const pushParagraph = (text, boldPrefix = '') => {
    segments.push({ text: `${text}\n`, boldPrefix });
  };

  pushHeading('COURSE CONTENT AUDIT', 'TITLE');
  pushParagraph(`Course: ${course}`, 'Course:');
  pushParagraph(`Audit Date: ${auditDate}`, 'Audit Date:');
  if (courseUrl) pushParagraph(`Course URL: ${courseUrl}`, 'Course URL:');
  if (sourceUrl) pushParagraph(`Reference Source URL: ${sourceUrl}`, 'Reference Source URL:');
  pushParagraph('');

  pushHeading('SUMMARY', 'HEADING_1');
  pushParagraph(`Total modules: ${summary.totalModules}`, 'Total modules:');
  pushParagraph(`Total subtopics: ${summary.totalSubtopics}`, 'Total subtopics:');
  pushParagraph(`Total slides: ${summary.totalSlides}`, 'Total slides:');
  pushParagraph(`Matched: ${summary.matched}`, 'Matched:');
  pushParagraph(`Minor differences: ${summary.minorDifferences}`, 'Minor differences:');
  pushParagraph(`Missing content: ${summary.missingContent}`, 'Missing content:');
  pushParagraph(`Major differences: ${summary.majorDifferences}`, 'Major differences:');
  pushParagraph(`Critical errors: ${summary.criticalErrors}`, 'Critical errors:');
  pushParagraph(`Review required: ${summary.reviewRequired}`, 'Review required:');
  pushParagraph('');

  // Separate issues by severity as requested in Step 10
  const severities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  let globalErrorIndex = 1;

  for (const sev of severities) {
    const group = issues.filter((i) => (i.severity || 'MEDIUM').toUpperCase() === sev);
    pushHeading(`${sev} SEVERITY ISSUES (${group.length})`, 'HEADING_1');

    if (group.length === 0) {
      pushParagraph(`No ${sev.toLowerCase()} severity issues detected.\n`);
      continue;
    }

    for (const issue of group) {
      pushHeading(`ERROR #${globalErrorIndex} — ${issue.differenceType}`, 'HEADING_2');
      pushParagraph(`Module: ${issue.module || 'N/A'}`, 'Module:');
      pushParagraph(`Subtopic: ${issue.subtopic || 'N/A'}`, 'Subtopic:');
      pushParagraph(`Slide: ${issue.slide ?? 'N/A'}`, 'Slide:');
      pushParagraph(`Type: ${issue.differenceType}`, 'Type:');
      pushParagraph(`Severity: ${issue.severity}`, 'Severity:');
      if (issue.sourceUrl && issue.sourceUrl !== 'N/A') {
        pushParagraph(`Source Reference: ${issue.sourceUrl}`, 'Source Reference:');
      }
      pushParagraph(`COURSE CONTENT:\n"${issue.courseText || ''}"`, 'COURSE CONTENT:');
      pushParagraph(`SOURCE CONTENT:\n"${issue.sourceText || ''}"`, 'SOURCE CONTENT:');
      pushParagraph(`EXPLANATION:\n${issue.explanation || ''}\n`, 'EXPLANATION:');
      globalErrorIndex += 1;
    }
  }

  // Crawl errors section
  pushHeading(`CRAWL ERRORS (${crawlErrors.length})`, 'HEADING_1');
  if (crawlErrors.length === 0) {
    pushParagraph('No crawl or runtime errors occurred during the audit.');
  } else {
    crawlErrors.forEach((err, i) => {
      pushHeading(`CRAWL ERROR #${i + 1} [${err.stage}]`, 'HEADING_2');
      pushParagraph(`URL: ${err.url}`, 'URL:');
      pushParagraph(`Module: ${err.module} | Subtopic: ${err.subtopic} | Slide: ${err.slide}`);
      pushParagraph(`Error: ${err.errorMessage}\n`, 'Error:');
    });
  }

  // Convert segments into sequential insertText + styling requests starting at index 1
  const requests = [];
  let currentIndex = 1;

  for (const seg of segments) {
    const len = seg.text.length;
    if (len === 0) continue;

    requests.push({
      insertText: {
        location: { index: currentIndex },
        text: seg.text
      }
    });

    if (seg.headingStyle) {
      requests.push({
        updateParagraphStyle: {
          range: {
            startIndex: currentIndex,
            endIndex: currentIndex + len
          },
          paragraphStyle: {
            namedStyleType: seg.headingStyle
          },
          fields: 'namedStyleType'
        }
      });
    } else if (seg.boldPrefix && seg.text.startsWith(seg.boldPrefix)) {
      requests.push({
        updateTextStyle: {
          range: {
            startIndex: currentIndex,
            endIndex: currentIndex + seg.boldPrefix.length
          },
          textStyle: {
            bold: true
          },
          fields: 'bold'
        }
      });
    }

    currentIndex += len;
  }

  return requests;
}

/**
 * Step 10 — Publish the structured audit report to Google Docs.
 * If Google Docs credentials are not configured yet, logs a clear setup message
 * without crashing the audit workflow.
 */
export async function exportReportToGoogleDocs(auditData, config, errorLogger) {
  console.log('\n==================================================');
  console.log('STEP 10 — GOOGLE DOCS REPORT INTEGRATION');
  console.log('==================================================');

  try {
    const authClient = await getGoogleAuthClient(config);
    if (!authClient) {
      console.log(
        '[Google Docs] Google OAuth credentials are not configured yet.\n' +
          `  -> Local reports (JSON, Markdown, HTML) have been generated in: ${config.paths.reportsDir}\n` +
          `  -> To enable Google Docs export, place your Google OAuth 2.0 Client credentials at:\n` +
          `     ${config.paths.googleCredentials}\n` +
          '     (See README.md "Google OAuth Setup" for step-by-step instructions.)'
      );
      return null;
    }

    const docs = google.docs({ version: 'v1', auth: authClient });
    let documentId = config.googleDocId;

    if (documentId) {
      console.log(`[Google Docs] Updating configured Google Doc ID: ${documentId}`);
      // Fetch existing document to clear previous content before writing fresh report
      const existingDoc = await docs.documents.get({ documentId });
      const contentArray = existingDoc.data.body?.content || [];
      const lastElement = contentArray[contentArray.length - 1];
      const endIndex = lastElement?.endIndex ? lastElement.endIndex - 1 : 1;

      if (endIndex > 1) {
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                deleteContentRange: {
                  range: {
                    startIndex: 1,
                    endIndex
                  }
                }
              }
            ]
          }
        });
      }
    } else {
      const docTitle = `Course Content Audit — ${auditData.course} (${auditData.auditDate})`;
      console.log(`[Google Docs] Creating new Google Doc: "${docTitle}"`);
      const created = await docs.documents.create({
        requestBody: {
          title: docTitle
        }
      });
      documentId = created.data.documentId;
    }

    const requests = buildGoogleDocRequests(auditData);
    if (requests.length > 0) {
      await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests
        }
      });
    }

    const docUrl = `https://docs.google.com/document/d/${documentId}/edit`;
    console.log(`[Google Docs] Successfully published audit report to Google Docs!`);
    console.log(`[Google Docs] Document URL: ${docUrl}`);

    return { documentId, docUrl };
  } catch (err) {
    if (errorLogger) {
      errorLogger.log({
        stage: 'GOOGLE_DOCS',
        url: config.googleDocId
          ? `https://docs.google.com/document/d/${config.googleDocId}/edit`
          : 'https://docs.googleapis.com',
        message: 'Google Docs export failed (local reports are still preserved)',
        error: err
      });
    }
    console.warn(
      `\n[Google Docs] Warning: Could not publish to Google Docs (${err.message}).\n` +
        `Local reports are safely saved in ${config.paths.reportsDir}.`
    );
    return null;
  }
}
