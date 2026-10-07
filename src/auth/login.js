import fs from 'fs';
import readline from 'readline';
import { chromium } from 'playwright';

/**
 * Determine whether the current page appears to be an unauthenticated login screen.
 */
export async function isLoginPage(page, config) {
  try {
    const currentUrl = page.url().toLowerCase();
    const loginPatterns = config.loginDetection?.loginUrlPatterns || [
      '/login',
      '/signin',
      '/sign-in',
      '/auth'
    ];

    const urlMatchesLogin = loginPatterns.some((pattern) =>
      currentUrl.includes(pattern.toLowerCase())
    );

    // Check if there is a visible password input on the page
    const loginSelectors = config.loginDetection?.loginFormSelectors || [
      "input[type='password']",
      "form[action*='login' i]",
      "form[action*='signin' i]"
    ];

    let hasVisibleLoginForm = false;
    for (const selector of loginSelectors) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        const firstVisible = await page
          .locator(selector)
          .first()
          .isVisible()
          .catch(() => false);
        if (firstVisible) {
          hasVisibleLoginForm = true;
          break;
        }
      }
    }

    if (hasVisibleLoginForm) {
      return true;
    }

    // Check if authenticated course indicators are present
    const authSelectors = config.loginDetection?.authenticatedSelectors || [];
    for (const selector of authSelectors) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false);
      if (visible) {
        return false;
      }
    }

    return urlMatchesLogin;
  } catch {
    return false;
  }
}

/**
 * Wait for user to press ENTER in the terminal OR click the in-browser "Save Session" helper.
 */
function waitForUserLoginSignal(page) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (source) => {
      if (resolved) return;
      resolved = true;
      rl.close();
      clearInterval(pollTimer);
      resolve(source);
    };

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(
      '\n>>> Log in inside the opened Chromium browser window.\n' +
        '>>> Once you reach the course dashboard/content page, press [ENTER] here (or click "Save Session & Continue" in the browser): ',
      () => finish('terminal')
    );

    const pollTimer = setInterval(async () => {
      try {
        if (page.isClosed()) {
          finish('browser-closed');
          return;
        }
        const clickedInBrowser = await page
          .evaluate(() => Boolean(window.__COURSE_AUDITOR_LOGIN_DONE__))
          .catch(() => false);
        if (clickedInBrowser) {
          finish('browser-button');
        }
      } catch {
        // Ignore transient navigation errors while user is logging in
      }
    }, 800);
  });
}

/**
 * Inject a purely local, non-persistent floating button in the browser viewport
 * so the user can confirm login directly from the browser window if desired.
 */
async function injectLoginHelperOverlay(page) {
  try {
    await page.addInitScript(() => {
      window.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('__course_auditor_helper__')) return;
        const box = document.createElement('div');
        box.id = '__course_auditor_helper__';
        box.style.cssText = [
          'position:fixed',
          'bottom:16px',
          'right:16px',
          'z-index:2147483647',
          'background:#0f172a',
          'color:#f8fafc',
          'padding:12px 16px',
          'border-radius:8px',
          'box-shadow:0 10px 25px rgba(0,0,0,0.35)',
          'font-family:system-ui,-apple-system,sans-serif',
          'font-size:13px',
          'display:flex',
          'align-items:center',
          'gap:12px',
          'border:1px solid #334155'
        ].join(';');

        const label = document.createElement('span');
        label.textContent = 'Course Auditor: Log in, open the course page, then click:';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Save Session & Continue';
        btn.style.cssText = [
          'background:#2563eb',
          'color:#ffffff',
          'border:none',
          'padding:6px 12px',
          'border-radius:6px',
          'cursor:pointer',
          'font-weight:600',
          'font-size:12px'
        ].join(';');
        btn.onclick = () => {
          window.__COURSE_AUDITOR_LOGIN_DONE__ = true;
          btn.textContent = 'Saving Session...';
          btn.style.background = '#16a34a';
        };

        box.appendChild(label);
        box.appendChild(btn);
        document.body.appendChild(box);
      });
    });
  } catch {
    // Non-critical helper
  }
}

/**
 * Perform interactive manual login in headed Chromium and save storage state to auth/browser-state.json.
 */
export async function performInteractiveLogin(config, errorLogger) {
  if (!config.courseUrl) {
    throw new Error(
      'COURSE_URL is not configured. Please set COURSE_URL in your .env file or config/config.json.'
    );
  }

  console.log('\n==================================================');
  console.log('STEP 2 — MANUAL COURSE LOGIN');
  console.log('==================================================');
  console.log(`Opening Chromium in visible (headed) mode...`);
  console.log(`Navigating to: ${config.courseUrl}`);

  const browser = await chromium.launch({
    headless: false,
    slowMo: config.browser?.slowMo ?? 50
  });

  const context = await browser.newContext({
    viewport: config.browser?.viewport || { width: 1440, height: 900 }
  });

  const page = await context.newPage();
  await injectLoginHelperOverlay(page);

  try {
    await page.goto(config.courseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser?.navigationTimeoutMs || 45000
    });

    let authenticated = false;
    while (!authenticated) {
      const signal = await waitForUserLoginSignal(page);
      if (signal === 'browser-closed') {
        throw new Error('Browser window was closed before session state could be saved.');
      }

      // Wait briefly for any pending redirects to settle
      await page.waitForTimeout(1000);
      const stillOnLogin = await isLoginPage(page, config);
      if (stillOnLogin) {
        console.warn(
          '\n[Login Check] The current page still appears to be a login page (' +
            page.url() +
            ').\nIf you have already logged in and are viewing the course, press [ENTER] again to force-save.'
        );
        const secondSignal = await waitForUserLoginSignal(page);
        if (secondSignal === 'browser-closed') {
          throw new Error('Browser window was closed before session state could be saved.');
        }
      }
      authenticated = true;
    }

    // Remove helper overlay from DOM if present before saving state
    await page
      .evaluate(() => {
        const el = document.getElementById('__course_auditor_helper__');
        if (el) el.remove();
        delete window.__COURSE_AUDITOR_LOGIN_DONE__;
      })
      .catch(() => {});

    // Save storage state (cookies + localStorage) to auth/browser-state.json
    await context.storageState({ path: config.paths.browserState });
    console.log(`\n[Auth] Authenticated session saved to: ${config.paths.browserState}`);
    console.log(`[Auth] Current course URL: ${page.url()}`);

    await browser.close();
    return true;
  } catch (err) {
    if (errorLogger) {
      errorLogger.log({
        stage: 'LOGIN',
        url: config.courseUrl,
        message: 'Interactive course login failed',
        error: err
      });
    }
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Ensure a valid authenticated browser session exists.
 * - If auth/browser-state.json does not exist, launches interactive login.
 * - If it exists, loads it, opens COURSE_URL, and verifies the session hasn't expired.
 * - If expired, prompts the user to log in again in headed mode.
 *
 * Returns an active { browser, context, page } ready for course inspection/crawling.
 */
export async function getAuthenticatedCourseSession(config, errorLogger) {
  if (!config.courseUrl) {
    throw new Error(
      'COURSE_URL is not configured. Please set COURSE_URL in your .env file or config/config.json.'
    );
  }

  // 1. Check if storage state exists
  if (!fs.existsSync(config.paths.browserState)) {
    console.log('[Auth] No saved browser session found at auth/browser-state.json.');
    console.log('[Auth] Launching first-time interactive login...');
    await performInteractiveLogin(config, errorLogger);
  }

  // 2. Launch browser with saved storage state
  const launchBrowserWithState = async () => {
    const browser = await chromium.launch({
      headless: config.browser?.headless ?? false,
      slowMo: config.browser?.slowMo ?? 50
    });
    const context = await browser.newContext({
      storageState: config.paths.browserState,
      viewport: config.browser?.viewport || { width: 1440, height: 900 }
    });
    const page = await context.newPage();
    return { browser, context, page };
  };

  let { browser, context, page } = await launchBrowserWithState();

  try {
    console.log(`[Auth] Loading course with saved session: ${config.courseUrl}`);
    await page.goto(config.courseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.browser?.navigationTimeoutMs || 45000
    });
    await page.waitForTimeout(config.browser?.slideWaitMs || 1500);

    // 3. Check if session expired
    const expired = await isLoginPage(page, config);
    if (expired) {
      console.warn(
        '\n[Auth] Saved session in auth/browser-state.json has expired or requires re-authentication!'
      );
      if (errorLogger) {
        errorLogger.log({
          stage: 'LOGIN',
          url: page.url(),
          message: 'Saved course login session expired; prompting user to log in again.'
        });
      }
      await browser.close().catch(() => {});

      // Re-run interactive login in visible/headed mode
      await performInteractiveLogin(config, errorLogger);

      // Re-open with refreshed state
      ({ browser, context, page } = await launchBrowserWithState());
      await page.goto(config.courseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: config.browser?.navigationTimeoutMs || 45000
      });
      await page.waitForTimeout(config.browser?.slideWaitMs || 1500);
    }

    console.log('[Auth] Course session verified and active.');
    return { browser, context, page };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}
