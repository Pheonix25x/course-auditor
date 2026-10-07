import fs from 'fs';

/**
 * Escape HTML special characters for safe rendering in the HTML report.
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format the Markdown report in the exact structure requested in Step 9 & Step 12.
 */
export function buildMarkdownReport(auditData) {
  const { course, auditDate, summary, issues = [], crawlErrors = [] } = auditData;

  const lines = [
    '# COURSE CONTENT AUDIT',
    '',
    'Course:',
    course,
    '',
    'Audit date:',
    auditDate,
    '',
    '## SUMMARY',
    '',
    `Total modules: ${summary.totalModules}`,
    `Total subtopics: ${summary.totalSubtopics}`,
    `Total slides: ${summary.totalSlides}`,
    `Matched: ${summary.matched}`,
    `Minor differences: ${summary.minorDifferences}`,
    `Missing content: ${summary.missingContent}`,
    `Major differences: ${summary.majorDifferences}`,
    `Critical errors: ${summary.criticalErrors}`,
    `Review required: ${summary.reviewRequired}`,
    ''
  ];

  if (issues.length === 0) {
    lines.push('---', '', 'No content discrepancies or errors were detected.', '');
  } else {
    issues.forEach((issue, index) => {
      lines.push(
        '---',
        '',
        `### ERROR #${index + 1}`,
        '',
        'Module:',
        issue.module || 'N/A',
        '',
        'Subtopic:',
        issue.subtopic || 'N/A',
        '',
        'Slide:',
        String(issue.slide ?? 'N/A'),
        '',
        'Type:',
        issue.differenceType || 'UNKNOWN',
        '',
        'Severity:',
        issue.severity || 'MEDIUM',
        '',
        'COURSE CONTENT:',
        `"${issue.courseText || ''}"`,
        '',
        'SOURCE CONTENT:',
        `"${issue.sourceText || ''}"`,
        ...(issue.sourceUrl && issue.sourceUrl !== 'N/A'
          ? ['', 'SOURCE URL:', issue.sourceUrl]
          : []),
        '',
        'EXPLANATION:',
        issue.explanation || '',
        ''
      );
    });
  }

  // Step 12: Crawl-errors section at the end of the report
  lines.push('---', '', '## CRAWL ERRORS', '');
  if (crawlErrors.length === 0) {
    lines.push('No crawl or runtime errors occurred during the audit.', '');
  } else {
    crawlErrors.forEach((err, idx) => {
      lines.push(
        `### CRAWL ERROR #${idx + 1}`,
        `- **Stage:** ${err.stage || 'GENERAL'}`,
        `- **Timestamp:** ${err.timestamp || ''}`,
        `- **URL:** ${err.url || 'N/A'}`,
        `- **Module:** ${err.module || 'N/A'}`,
        `- **Subtopic:** ${err.subtopic || 'N/A'}`,
        `- **Slide:** ${err.slide || 'N/A'}`,
        `- **Error Message:** ${err.errorMessage || ''}`,
        ''
      );
    });
  }

  return lines.join('\n');
}

/**
 * Format a clean, interactive, self-contained HTML report.
 */
export function buildHtmlReport(auditData) {
  const { course, auditDate, summary, issues = [], crawlErrors = [] } = auditData;

  const severityColor = (sev) => {
    switch ((sev || '').toUpperCase()) {
      case 'CRITICAL':
        return '#dc2626';
      case 'HIGH':
        return '#ea580c';
      case 'MEDIUM':
        return '#d97706';
      case 'LOW':
      default:
        return '#2563eb';
    }
  };

  const issuesHtml =
    issues.length === 0
      ? `<div class="empty-state">No content differences or errors were detected across the audited slides.</div>`
      : issues
          .map(
            (issue, idx) => `
      <div class="issue-card" data-severity="${escapeHtml(issue.severity)}">
        <div class="issue-header">
          <span class="issue-number">ERROR #${idx + 1}</span>
          <span class="badge type-badge">${escapeHtml(issue.differenceType)}</span>
          <span class="badge severity-badge" style="background:${severityColor(
            issue.severity
          )}">${escapeHtml(issue.severity)}</span>
        </div>
        <div class="meta-grid">
          <div><strong>Module:</strong> ${escapeHtml(issue.module)}</div>
          <div><strong>Subtopic:</strong> ${escapeHtml(issue.subtopic)}</div>
          <div><strong>Slide:</strong> ${escapeHtml(issue.slide)}</div>
          ${
            issue.sourceUrl && issue.sourceUrl !== 'N/A'
              ? `<div><strong>Source URL:</strong> <a href="${escapeHtml(
                  issue.sourceUrl
                )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
                  issue.sourceUrl
                )}</a></div>`
              : ''
          }
        </div>
        <div class="comparison-boxes">
          <div class="content-box course-box">
            <div class="box-label">COURSE CONTENT</div>
            <p>"${escapeHtml(issue.courseText)}"</p>
          </div>
          <div class="content-box source-box">
            <div class="box-label">SOURCE CONTENT</div>
            <p>"${escapeHtml(issue.sourceText)}"</p>
          </div>
        </div>
        <div class="explanation">
          <strong>EXPLANATION:</strong> ${escapeHtml(issue.explanation)}
        </div>
      </div>`
          )
          .join('\n');

  const crawlErrorsHtml =
    crawlErrors.length === 0
      ? `<p class="clean-note">No crawl or runtime errors occurred during the audit.</p>`
      : `<table class="errors-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Stage</th>
              <th>Module</th>
              <th>Subtopic</th>
              <th>Slide</th>
              <th>URL</th>
              <th>Error Message</th>
            </tr>
          </thead>
          <tbody>
            ${crawlErrors
              .map(
                (e, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${escapeHtml(e.stage)}</td>
                <td>${escapeHtml(e.module)}</td>
                <td>${escapeHtml(e.subtopic)}</td>
                <td>${escapeHtml(e.slide)}</td>
                <td>${escapeHtml(e.url)}</td>
                <td>${escapeHtml(e.errorMessage)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Course Content Audit — ${escapeHtml(course)}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --border: #e2e8f0;
      --text: #0f172a;
      --muted: #475569;
    }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 32px 20px;
      line-height: 1.55;
    }
    .container {
      max-width: 1120px;
      margin: 0 auto;
    }
    header {
      background: #0f172a;
      color: #ffffff;
      padding: 28px 32px;
      border-radius: 12px;
      margin-bottom: 24px;
    }
    header h1 {
      margin: 0 0 8px 0;
      font-size: 24px;
      letter-spacing: 0.5px;
    }
    header .meta {
      color: #cbd5e1;
      font-size: 15px;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 14px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .stat-card .label {
      font-size: 12px;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 600;
    }
    .stat-card .value {
      font-size: 26px;
      font-weight: 700;
      margin-top: 4px;
    }
    .filter-bar {
      margin-bottom: 20px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .filter-btn {
      background: #ffffff;
      border: 1px solid var(--border);
      padding: 7px 14px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
    }
    .filter-btn.active {
      background: #0f172a;
      color: #ffffff;
      border-color: #0f172a;
    }
    .issue-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 22px;
      margin-bottom: 18px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .issue-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
    }
    .issue-number {
      font-weight: 800;
      font-size: 16px;
    }
    .badge {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      color: #ffffff;
    }
    .type-badge {
      background: #334155;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 8px 16px;
      background: #f1f5f9;
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 16px;
    }
    .comparison-boxes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 14px;
    }
    @media (max-width: 768px) {
      .comparison-boxes {
        grid-template-columns: 1fr;
      }
    }
    .content-box {
      padding: 14px 16px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .course-box {
      background: #fffbeb;
      border-color: #fde68a;
    }
    .source-box {
      background: #f0fdf4;
      border-color: #bbf7d0;
    }
    .box-label {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .content-box p {
      margin: 0;
      white-space: pre-wrap;
      font-size: 14px;
    }
    .explanation {
      font-size: 14px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }
    .errors-table {
      width: 100%;
      border-collapse: collapse;
      background: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .errors-table th, .errors-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      font-size: 13px;
    }
    .errors-table th {
      background: #f1f5f9;
    }
    .empty-state, .clean-note {
      background: #ffffff;
      padding: 20px;
      border-radius: 8px;
      border: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>COURSE CONTENT AUDIT</h1>
      <div class="meta">
        <div><strong>Course:</strong> ${escapeHtml(course)}</div>
        <div><strong>Audit date:</strong> ${escapeHtml(auditDate)}</div>
      </div>
    </header>

    <h2>SUMMARY</h2>
    <div class="summary-grid">
      <div class="stat-card"><div class="label">Total modules</div><div class="value">${
        summary.totalModules
      }</div></div>
      <div class="stat-card"><div class="label">Total subtopics</div><div class="value">${
        summary.totalSubtopics
      }</div></div>
      <div class="stat-card"><div class="label">Total slides</div><div class="value">${
        summary.totalSlides
      }</div></div>
      <div class="stat-card"><div class="label">Matched</div><div class="value" style="color:#16a34a">${
        summary.matched
      }</div></div>
      <div class="stat-card"><div class="label">Minor differences</div><div class="value" style="color:#2563eb">${
        summary.minorDifferences
      }</div></div>
      <div class="stat-card"><div class="label">Missing content</div><div class="value" style="color:#d97706">${
        summary.missingContent
      }</div></div>
      <div class="stat-card"><div class="label">Major differences</div><div class="value" style="color:#ea580c">${
        summary.majorDifferences
      }</div></div>
      <div class="stat-card"><div class="label">Critical errors</div><div class="value" style="color:#dc2626">${
        summary.criticalErrors
      }</div></div>
      <div class="stat-card"><div class="label">Review required</div><div class="value" style="color:#7c3aed">${
        summary.reviewRequired
      }</div></div>
    </div>

    <h2>DETECTED ISSUES (${issues.length})</h2>
    <div class="filter-bar">
      <button class="filter-btn active" onclick="filterIssues('ALL', this)">All (${
        issues.length
      })</button>
      <button class="filter-btn" onclick="filterIssues('CRITICAL', this)">Critical (${
        summary.criticalErrors
      })</button>
      <button class="filter-btn" onclick="filterIssues('HIGH', this)">High</button>
      <button class="filter-btn" onclick="filterIssues('MEDIUM', this)">Medium</button>
      <button class="filter-btn" onclick="filterIssues('LOW', this)">Low</button>
    </div>

    <div id="issues-container">
      ${issuesHtml}
    </div>

    <h2>CRAWL ERRORS (${crawlErrors.length})</h2>
    ${crawlErrorsHtml}
  </div>

  <script>
    function filterIssues(severity, btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.issue-card').forEach(card => {
        if (severity === 'ALL' || card.dataset.severity === severity) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });
    }
  </script>
</body>
</html>`;
}

/**
 * Step 9 — Generate JSON, Markdown, and HTML audit reports in data/reports/.
 */
export function generateReports(config, errorLogger) {
  console.log('\n==================================================');
  console.log('STEP 9 — GENERATING AUDIT REPORTS (JSON, MD, HTML)');
  console.log('==================================================');

  if (!fs.existsSync(config.paths.comparisonResults)) {
    throw new Error(
      `Comparison results not found at ${config.paths.comparisonResults}. Run \`npm run compare\` first.`
    );
  }

  const auditData = JSON.parse(fs.readFileSync(config.paths.comparisonResults, 'utf-8'));

  // Attach latest crawl errors from errorLogger if available
  if (errorLogger) {
    auditData.crawlErrors = errorLogger.getAll();
  }

  // 1. Save JSON Report
  fs.writeFileSync(config.paths.reportJson, JSON.stringify(auditData, null, 2), 'utf-8');

  // 2. Save Markdown Report
  const mdContent = buildMarkdownReport(auditData);
  fs.writeFileSync(config.paths.reportMd, mdContent, 'utf-8');

  // 3. Save HTML Report
  const htmlContent = buildHtmlReport(auditData);
  fs.writeFileSync(config.paths.reportHtml, htmlContent, 'utf-8');

  console.log(`[Report] JSON Report saved to:     ${config.paths.reportJson}`);
  console.log(`[Report] Markdown Report saved to: ${config.paths.reportMd}`);
  console.log(`[Report] HTML Report saved to:     ${config.paths.reportHtml}`);

  return {
    jsonPath: config.paths.reportJson,
    mdPath: config.paths.reportMd,
    htmlPath: config.paths.reportHtml,
    auditData
  };
}
