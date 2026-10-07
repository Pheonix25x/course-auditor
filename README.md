# Automated Course Content Auditor

An end-to-end automated auditing tool built with **Node.js**, **Crawlee**, **Playwright**, and the **Google Docs API**.

It logs into an online course (`Course → Modules → Subtopics → Slides`), discovers the course structure, extracts visible slide content, crawls an authoritative reference/source website, normalizes and intelligently matches content, detects discrepancies across 13 difference categories, and generates **JSON**, **Markdown**, **HTML**, and **Google Docs** audit reports.

> **Read-Only Safety Guarantee:** This tool is strictly for auditing. It never modifies, edits, deletes, or publishes changes to the original course website.

---

## Project Structure

```text
course-auditor/
├── src/
│   ├── auth/
│   │   └── login.js            # Interactive manual login & session storageState reuse
│   ├── config/
│   │   └── index.js            # .env + config.json + CLI options loader
│   ├── course/
│   │   ├── inspectDom.js       # Live DOM structure inspector for selector tuning
│   │   ├── discoverCourse.js   # Course -> Module -> Subtopic -> Slide hierarchy discovery
│   │   ├── extractSlides.js    # Meaningful slide content extraction & Next-button pagination
│   │   └── crawlCourse.js      # Course crawler with checkpointing & resume support
│   ├── source/
│   │   ├── crawlSource.js      # Crawlee + Playwright crawler for authoritative source site
│   │   └── extractSource.js    # Clean content & topical section extractor
│   ├── comparison/
│   │   ├── normalize.js        # Text normalization preserving numbers, dates, and domain terms
│   │   └── compare.js          # Multi-signal semantic matching & 13-type error detection
│   ├── reports/
│   │   └── generateReport.js   # JSON, Markdown, and interactive HTML report generators
│   ├── google/
│   │   └── googleDocs.js       # Official Google Docs API integration
│   └── utils/
│       └── errorLogger.js      # Non-fatal crawl/runtime error logger
├── data/
│   ├── course/                 # Saved manifest.json, course-content.json, progress.json
│   ├── source/                 # Saved source-content.json
│   └── reports/                # Generated audit-report.json, .md, and .html
├── auth/                       # Local authenticated Playwright browser state (git-ignored)
├── config/
│   └── config.example.json     # Configurable selectors and crawler settings template
├── .env.example                # Environment variable template
├── .gitignore                  # Excludes secrets, sessions, credentials, and raw JSON data
├── package.json
├── README.md
└── audit.js                    # Main CLI entrypoint
```

---

## 1. Node.js Installation

Ensure you have **Node.js v18+** (LTS recommended) installed:

```bash
node --version
npm --version
```

If Node.js is not installed, download and install it from [https://nodejs.org/](https://nodejs.org/).

---

## 2. Install Project Dependencies

From the `course-auditor` folder, install the Node.js dependencies:

```bash
npm install
```

*(Note on Windows PowerShell: if script execution policy blocks `npm.ps1`, use `npm.cmd install`.)*

---

## 3. Playwright Browser Installation

Install the Chromium browser binary used by Playwright and Crawlee:

```bash
npx playwright install chromium
```

---

## 4. Configuration

1. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and fill in your URLs:

   ```env
   COURSE_URL=https://your-course-platform.example.com/courses/your-course
   SOURCE_URL=https://your-reference-source.example.com/guide
   GOOGLE_DOC_ID=
   ```

3. *(Optional)* If you want to customize CSS selectors for your specific course platform after running the DOM inspector, copy `config/config.example.json` to `config/config.json` and adjust `courseSelectors` or `sourceSelectors`. Both `.env` and `config/config.json` are excluded from Git by `.gitignore`.

---

## 5. First-Time Course Login & Incremental Verification

### Step 5a: Log in and save your browser session

Run:

```bash
npm run login
```

1. A visible Chromium browser window will open and navigate to `COURSE_URL`.
2. Log in manually using your credentials (including 2FA/SSO if applicable) and navigate to the main course view.
3. Click the **"Save Session & Continue"** button in the bottom-right corner of the browser window (or press `ENTER` in the terminal).
4. Your authenticated session will be saved locally to `auth/browser-state.json` (ignored by Git) and automatically reused on future runs. If the session ever expires, the auditor will detect it and prompt you to log in again.

### Step 5b: Inspect the course DOM structure

Before running a full crawl on a new course platform, inspect how modules, subtopics, slides, and Next buttons are structured in the DOM:

```bash
npm run inspect
```

This saves a detailed breakdown of frames, navigation containers, buttons, and content selectors to `data/course/dom-inspection.json`.

### Step 5c: Test 1 Module → 1 Subtopic → 1 Slide incrementally

To verify course discovery and slide extraction on **1 module, 1 subtopic, and 1 slide** before crawling the entire course:

```bash
npm run test:single
```

Check `data/course/manifest.json` and `data/course/course-content.json` to verify the extracted output.

---

## 6. Google OAuth Setup (Optional)

Local reports (`JSON`, `Markdown`, `HTML`) work out of the box without Google Docs configured. To enable automatic publishing to Google Docs:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project and enable the **Google Docs API** and **Google Drive API**.
3. Create credentials:
   - **Option A (OAuth 2.0 Client ID):** Create an **OAuth client ID** of type **Desktop app**, download the JSON file, and save it as `credentials/google-credentials.json`. On the first run, the CLI will print an authorization URL and save the token to `credentials/google-token.json`.
   - **Option B (Service Account):** Create a **Service Account**, download its JSON key to `credentials/google-credentials.json`, and share your target Google Doc (`GOOGLE_DOC_ID`) with the service account's email address as an **Editor**.
4. Set `GOOGLE_DOC_ID` in `.env` to update an existing Google Doc, or leave `GOOGLE_DOC_ID` blank to create a new Google Doc automatically.

---

## 7. Running the Commands

| Command | Description |
| :--- | :--- |
| `npm run login` | Opens Chromium in visible mode so you can log in and save `auth/browser-state.json`. |
| `npm run inspect` | Inspects the live course DOM and saves selector analysis to `data/course/dom-inspection.json`. |
| `npm run test:single` | Incremental test: crawls 1 module → 1 subtopic → 1 slide. |
| `npm run crawl` | Crawls the full course (with resume support) and the reference source website. |
| `npm run compare` | Normalizes, matches, and compares saved course slides against source content. |
| `npm run report` | Generates `audit-report.json`, `audit-report.md`, and `audit-report.html` in `data/reports/`. |
| `npm run audit` | Runs the complete pipeline (`login check → course crawl → source crawl → compare → report → Google Docs`). |

### Resume Support

Course crawling automatically saves progress after every subtopic in `data/course/progress.json`. If a crawl of hundreds of slides is interrupted, running `npm run crawl` or `npm run audit` again will automatically resume from the last completed subtopic. To force a fresh crawl from scratch, pass `--fresh`:

```bash
node audit.js crawl --fresh
```
