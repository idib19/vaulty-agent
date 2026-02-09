// Inject overlay once (skip on internal/protected pages)
(function injectOverlay() {
  const p = location.protocol;
  // Skip internal/protected protocols where injection is blocked or pointless
  if (
    p === "chrome:" ||
    p === "chrome-extension:" ||
    p === "chrome-search:" ||
    p === "chrome-untrusted:" ||
    p === "about:" ||
    p === "edge:" ||
    p === "brave:" ||
    p === "moz-extension:"
  ) {
    return;
  }
  
  // Only inject overlay in the top frame, not in iframes (prevents duplicate HUD in reCAPTCHA, etc.)
  if (window.top !== window.self) return;
  
  if (window.__agentOverlayInjected) return;
  window.__agentOverlayInjected = true;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("mini-overlay.js");
  script.type = "text/javascript";
  document.documentElement.appendChild(script);
})();

// Track highlighted elements for cleanup
let highlightedElements = [];
let pendingAskUserResponse = null;

// Candidate registry (executor v2)
let vaultyRegistry = null;
let vaultyRegistryVersion = 0;
const VAULTY_ID_ATTR = "data-vaulty-id";

// ============================================================================
// OBSERVATION GATING: Network idle, SPA route changes, DOM stability
// ============================================================================

// Configuration defaults (tunable)
const OBSERVATION_CONFIG = {
  networkIdleMs: 800,
  networkMaxMs: 8000,
  domStableMs: 400,
  domMaxMs: 5000,
  scrollDwellMs: { min: 80, max: 150 }
};

// Network idle tracking
let pendingRequests = 0;
let lastActivityTimestamp = Date.now();

// Patch fetch to track requests
const originalFetch = window.fetch;
window.fetch = function(...args) {
  pendingRequests++;
  lastActivityTimestamp = Date.now();
  const promise = originalFetch.apply(this, args);
  promise.finally(() => {
    pendingRequests = Math.max(0, pendingRequests - 1);
    lastActivityTimestamp = Date.now();
  });
  return promise;
};

// Patch XMLHttpRequest to track requests
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function(...args) {
  this._agentTracked = true;
  return originalXHROpen.apply(this, args);
};

XMLHttpRequest.prototype.send = function(...args) {
  if (this._agentTracked) {
    pendingRequests++;
    lastActivityTimestamp = Date.now();
    this.addEventListener('loadend', () => {
      pendingRequests = Math.max(0, pendingRequests - 1);
      lastActivityTimestamp = Date.now();
    }, { once: true });
    this.addEventListener('error', () => {
      pendingRequests = Math.max(0, pendingRequests - 1);
      lastActivityTimestamp = Date.now();
    }, { once: true });
  }
  return originalXHRSend.apply(this, args);
};

// Wait for network idle
async function waitForNetworkIdle({ idleMs = OBSERVATION_CONFIG.networkIdleMs, maxMs = OBSERVATION_CONFIG.networkMaxMs } = {}) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxMs) {
    if (pendingRequests === 0) {
      const idleStart = Date.now();
      while (Date.now() - idleStart < idleMs) {
        if (pendingRequests > 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      if (pendingRequests === 0) return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

// SPA route-change tracking
let routeVersion = 0;
let lastNavAt = Date.now();
let lastHref = location.href;

// Wrap history.pushState
const originalPushState = history.pushState;
history.pushState = function(...args) {
  routeVersion++;
  lastNavAt = Date.now();
  const newHref = location.href;
  if (newHref !== lastHref) {
    lastHref = newHref;
    try {
      chrome.runtime.sendMessage({ type: "ROUTE_CHANGED", href: newHref }).catch(() => {});
    } catch (e) {
      // Ignore errors (e.g., extension context invalidated)
    }
  }
  return originalPushState.apply(this, args);
};

// Wrap history.replaceState
const originalReplaceState = history.replaceState;
history.replaceState = function(...args) {
  routeVersion++;
  lastNavAt = Date.now();
  const newHref = location.href;
  if (newHref !== lastHref) {
    lastHref = newHref;
    try {
      chrome.runtime.sendMessage({ type: "ROUTE_CHANGED", href: newHref }).catch(() => {});
    } catch (e) {
      // Ignore errors
    }
  }
  return originalReplaceState.apply(this, args);
};

// Listen to popstate
window.addEventListener('popstate', () => {
  routeVersion++;
  lastNavAt = Date.now();
  const newHref = location.href;
  if (newHref !== lastHref) {
    lastHref = newHref;
    try {
      chrome.runtime.sendMessage({ type: "ROUTE_CHANGED", href: newHref }).catch(() => {});
    } catch (e) {
      // Ignore errors
    }
  }
});

// DOM stability tracking
async function waitForDomStability({ stableMs = OBSERVATION_CONFIG.domStableMs, maxMs = OBSERVATION_CONFIG.domMaxMs } = {}) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let lastMutationTime = Date.now();
    let stableTimeout = null;
    
    // Compute a simple hash of DOM structure (bounding box count + text size)
    function computeDomHash() {
      const elements = document.querySelectorAll('*');
      let hash = elements.length;
      // Add text content length as a factor
      hash += (document.body?.innerText?.length || 0) % 1000;
      return hash;
    }
    
    let lastHash = computeDomHash();
    
    const observer = new MutationObserver(() => {
      lastMutationTime = Date.now();
      const currentHash = computeDomHash();
      
      // If hash changed, reset stability timer
      if (currentHash !== lastHash) {
        lastHash = currentHash;
        if (stableTimeout) clearTimeout(stableTimeout);
        stableTimeout = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, stableMs);
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
    
    // Initial stability check
    stableTimeout = setTimeout(() => {
      observer.disconnect();
      resolve();
    }, stableMs);
    
    // Max timeout
    setTimeout(() => {
      if (stableTimeout) clearTimeout(stableTimeout);
      observer.disconnect();
      resolve();
    }, maxMs);
  });
}

// Compose waitForPageReady
let pageReadyPromise = null;
let pageReadyReason = null;

async function waitForPageReady(reason = "initial") {
  // If there's already a pending promise, reuse it (unless reason suggests we should re-check)
  if (pageReadyPromise && reason === "initial") {
    return pageReadyPromise;
  }
  
  pageReadyReason = reason;
  pageReadyPromise = (async () => {
    const maxTotalMs = Math.max(
      OBSERVATION_CONFIG.networkMaxMs,
      OBSERVATION_CONFIG.domMaxMs
    ) + 2000; // Add buffer
    const startTime = Date.now();
    
    // Step 1: Wait for document ready
    if (document.readyState !== "complete" && document.readyState !== "loaded") {
      await new Promise((resolve) => {
        if (document.readyState === "complete" || document.readyState === "loaded") {
          resolve();
        } else {
          window.addEventListener('load', resolve, { once: true });
          // Timeout after 5 seconds
          setTimeout(resolve, 5000);
        }
      });
    }
    
    // Check timeout
    if (Date.now() - startTime > maxTotalMs) return;
    
    // Step 2: Wait for network idle
    await waitForNetworkIdle();
    
    // Check timeout
    if (Date.now() - startTime > maxTotalMs) return;
    
    // Step 3: Wait for DOM stability
    await waitForDomStability();
    
    return { reason, routeVersion, lastNavAt };
  })();
  
  return pageReadyPromise;
}

// ============================================================================
// EFFICIENT INTERACTION HELPERS
// ============================================================================

// Scroll element into view with minimal delay
async function scrollIntoViewEfficient(el) {
  const rect = el.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  // Check if element is already in viewport (with small margin)
  const margin = 5;
  const inViewport =
    rect.top >= -margin &&
    rect.left >= -margin &&
    rect.bottom <= viewportHeight + margin &&
    rect.right <= viewportWidth + margin;

  if (!inViewport) {
    // Use instant scroll for efficiency
    el.scrollIntoView({
      behavior: "instant",
      block: "center",
      inline: "center"
    });
    // Minimal wait for scroll
    await new Promise(r => setTimeout(r, 10));
  }
}

// Fast click using optimized synthetic mouse events
async function clickEfficient(el) {
  try {
    await scrollIntoViewEfficient(el);

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // Optimized synthetic mouse events for maximum efficiency
    const mouseOpts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      // Add realistic timing properties
      timeStamp: Date.now(),
      screenX: x + window.screenX,
      screenY: y + window.screenY
    };

    // Minimal event sequence for maximum efficiency
    el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
    el.dispatchEvent(new MouseEvent('click', mouseOpts));

  } catch (e) {
    // Ultimate fallback
    console.info("[agent] falling back to basic click", { reason: e.message });
    el.click();
  }
}

// Smart dropdown click with adaptive waiting
async function clickDropdownTrigger(el) {
  try {
    await scrollIntoViewEfficient(el);

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // Check if already expanded
    const isExpanded = el.getAttribute("aria-expanded") === "true" ||
                       el.classList.contains("open") ||
                       el.classList.contains("expanded");

    if (isExpanded) return true;

    // Fast click
    const mouseOpts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1
    };

    el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
    el.dispatchEvent(new MouseEvent('click', mouseOpts));

    // Smart wait: poll for expansion instead of fixed delay
    const startTime = Date.now();
    while (Date.now() - startTime < 1000) { // Max 1 second
      await new Promise(r => setTimeout(r, 10)); // Poll every 10ms

      const nowExpanded = el.getAttribute("aria-expanded") === "true" ||
                          el.classList.contains("open") ||
                          el.classList.contains("expanded");

      if (nowExpanded) {
        return true;
      }
    }

    // If we get here, expansion wasn't detected - try fallback
    console.info("[agent] dropdown expansion not detected, using fallback");
    el.click();
    await new Promise(r => setTimeout(r, 100)); // Brief fallback wait
    return true;

  } catch (e) {
    console.info("[agent] dropdown click failed, using basic click", { reason: e.message });
    el.click();
    await new Promise(r => setTimeout(r, 100));
    return false;
  }
}

// Ultra-fast element interaction
async function interactElement(el, action = 'click') {
  await scrollIntoViewEfficient(el);

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const baseOpts = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1
  };

  try {
    switch (action) {
      case 'click':
        el.dispatchEvent(new MouseEvent('mousedown', baseOpts));
        el.dispatchEvent(new MouseEvent('mouseup', baseOpts));
        el.dispatchEvent(new MouseEvent('click', baseOpts));
        break;

      case 'mousedown':
        el.dispatchEvent(new MouseEvent('mousedown', baseOpts));
        break;

      case 'mouseup':
        el.dispatchEvent(new MouseEvent('mouseup', baseOpts));
        break;

      case 'hover':
        el.dispatchEvent(new MouseEvent('mouseover', baseOpts));
        el.dispatchEvent(new MouseEvent('mouseenter', { ...baseOpts, bubbles: false }));
        break;

      default:
        el[action]?.(); // Direct method call as fallback
    }
  } catch (e) {
    // Fallback to direct method
    if (typeof el[action] === 'function') {
      el[action]();
    }
  }
}

// Fast focus method
async function focusEfficient(el) {
  try {
    await scrollIntoViewEfficient(el);

    // For focusable elements, quick click if needed
    const needsClick = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
                      el.getAttribute('contenteditable') === 'true';

    if (needsClick && document.activeElement !== el) {
      await clickEfficient(el);
      // Very brief wait
      await new Promise(r => setTimeout(r, 10));
    }

    // Ensure focus
    if (document.activeElement !== el) {
      el.focus({ preventScroll: true });
    }
  } catch (e) {
    console.info("[agent] focus failed, using direct focus", { reason: e.message });
    el.focus({ preventScroll: true });
  }
}

// Type value with incremental input events
async function typeValue(el, value, clear = true) {
  try {
    await focusEfficient(el);
    
    if (clear) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    
    // Try setRangeText if available (for inputs/textarea)
    if (el.setRangeText && typeof el.setRangeText === 'function') {
      try {
        el.setRangeText(value, 0, el.value.length, 'end');
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      } catch (e) {
        // Fall through to incremental typing
      }
    }
    
    // Incremental typing simulation (for better compatibility)
    const chars = value.split('');
    for (let i = 0; i < chars.length; i++) {
      el.value += chars[i];
      el.dispatchEvent(new KeyboardEvent('keydown', { 
        bubbles: true, 
        key: chars[i],
        code: `Key${chars[i].toUpperCase()}` 
      }));
      el.dispatchEvent(new KeyboardEvent('keypress', { 
        bubbles: true, 
        key: chars[i] 
      }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { 
        bubbles: true, 
        key: chars[i] 
      }));
      
      // Small delay between characters (5-15ms)
      if (i < chars.length - 1) {
        await new Promise(r => setTimeout(r, 5 + Math.random() * 10));
      }
    }
    
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } catch (e) {
    console.info("[agent] falling back to DOM fill", { reason: e.message });
    // Fallback to direct assignment
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function norm(s) {
  return (s || "").trim().toLowerCase();
}

// Find label text for an input element
function findLabelForElement(el) {
  // Check for explicit label via 'for' attribute
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id}"]`);
    if (label) return label.innerText.trim();
  }
  
  // Check for wrapping label
  const parentLabel = el.closest("label");
  if (parentLabel) {
    // Get text content excluding the input itself
    const clone = parentLabel.cloneNode(true);
    const inputs = clone.querySelectorAll("input, textarea, select");
    inputs.forEach(i => i.remove());
    return clone.innerText.trim();
  }
  
  // Check for aria-label
  if (el.getAttribute("aria-label")) {
    return el.getAttribute("aria-label");
  }
  
  // Check for aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return labelEl.innerText.trim();
  }
  
  // Check for preceding sibling that might be a label
  const prev = el.previousElementSibling;
  if (prev && (prev.tagName === "LABEL" || prev.tagName === "SPAN" || prev.tagName === "DIV")) {
    const text = prev.innerText.trim();
    if (text.length < 100) return text;
  }
  
  return "";
}

// Detect special elements on the page (captcha, OAuth, file upload, etc.)
function detectSpecialElements() {
  const special = {
    hasCaptcha: false,
    captchaType: null,
    hasOAuthButtons: [],
    hasFileUpload: false,
    hasPasswordField: false,
    hasCookieBanner: false
  };

  // Detect CAPTCHA - ONLY VISIBLE CAPTCHAs that block user interaction
  // Helper function to check if element is visible and has meaningful size
  const isVisibleCaptcha = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    // Must be visible (not hidden, has size > 50x50 pixels - typical CAPTCHA size)
    return rect.width > 50 && rect.height > 50 && 
           window.getComputedStyle(el).visibility !== 'hidden' &&
           window.getComputedStyle(el).display !== 'none';
  };
  
  // reCAPTCHA v2 (visible checkbox) - NOT v3/Enterprise which is invisible
  const recaptchaWidget = document.querySelector('.g-recaptcha');
  if (recaptchaWidget && isVisibleCaptcha(recaptchaWidget)) {
    special.hasCaptcha = true;
    special.captchaType = "recaptcha";
  }
  
  // hCaptcha (visible)
  const hcaptchaWidget = document.querySelector('.h-captcha');
  if (hcaptchaWidget && isVisibleCaptcha(hcaptchaWidget)) {
    special.hasCaptcha = true;
    special.captchaType = "hcaptcha";
  }
  
  // Cloudflare Turnstile (visible)
  const turnstileWidget = document.querySelector('.cf-turnstile');
  if (turnstileWidget && isVisibleCaptcha(turnstileWidget)) {
    special.hasCaptcha = true;
    special.captchaType = "cloudflare";
  }
  
  // "I'm not a robot" checkbox (very specific, must be visible)
  const robotCheckbox = document.querySelector('.recaptcha-checkbox, input[type="checkbox"][id*="recaptcha"]');
  if (robotCheckbox && isVisibleCaptcha(robotCheckbox)) {
    special.hasCaptcha = true;
    special.captchaType = "recaptcha";
  }
  
  // NOTE: We do NOT detect:
  // - iframe[src*="recaptcha"] - this catches invisible reCAPTCHA Enterprise
  // - [data-sitekey] - this is just the config attribute, not a visible CAPTCHA
  // - iframe[src*="challenge"] - too broad, catches non-blocking elements
  
  // NOTE: Removed text-based detection ("verify you are human", etc.) 
  // as it causes too many false positives on job posting pages

  // Detect OAuth buttons
  const oauthPatterns = [
    { pattern: /continue\s*(with|using)?\s*google|sign\s*in\s*(with|using)?\s*google|google\s*sign\s*in/i, provider: "google" },
    { pattern: /continue\s*(with|using)?\s*linkedin|sign\s*in\s*(with|using)?\s*linkedin/i, provider: "linkedin" },
    { pattern: /continue\s*(with|using)?\s*github|sign\s*in\s*(with|using)?\s*github/i, provider: "github" },
    { pattern: /continue\s*(with|using)?\s*facebook|sign\s*in\s*(with|using)?\s*facebook/i, provider: "facebook" },
    { pattern: /continue\s*(with|using)?\s*apple|sign\s*in\s*(with|using)?\s*apple/i, provider: "apple" },
    { pattern: /continue\s*(with|using)?\s*microsoft|sign\s*in\s*(with|using)?\s*microsoft/i, provider: "microsoft" },
  ];

  const buttons = document.querySelectorAll("button, a[role='button'], [role='button']");
  buttons.forEach(btn => {
    const text = (btn.innerText || btn.getAttribute("aria-label") || "").trim();
    oauthPatterns.forEach(({ pattern, provider }) => {
      if (pattern.test(text) && !special.hasOAuthButtons.includes(provider)) {
        special.hasOAuthButtons.push(provider);
      }
    });
  });

  // Detect file upload
  if (document.querySelector('input[type="file"]')) {
    special.hasFileUpload = true;
  }

  // Detect password field
  if (document.querySelector('input[type="password"]')) {
    special.hasPasswordField = true;
  }

  // Detect cookie/GDPR banners
  const cookieSelectors = [
    '[class*="cookie"]', '[id*="cookie"]',
    '[class*="consent"]', '[id*="consent"]',
    '[class*="gdpr"]', '[id*="gdpr"]',
    '[aria-label*="cookie"]', '[aria-label*="consent"]'
  ];
  if (document.querySelector(cookieSelectors.join(', '))) {
    special.hasCookieBanner = true;
  }

  // Detect OTP/verification code fields
  // OTP fields are typically multiple single-digit text inputs in sequence
  special.hasOtpField = false;
  special.otpFieldCount = 0;
  special.otpFieldIndices = [];
  
  // Method 1: Look for common OTP patterns in labels/placeholders/aria
  const otpIndicators = [
    /otp/i, /one.?time/i, /verification.?code/i, /verify.?code/i,
    /security.?code/i, /auth.?code/i, /2fa/i, /two.?factor/i,
    /enter.?code/i, /confirm.?code/i, /sms.?code/i, /email.?code/i
  ];
  
  const pageText = document.body?.innerText || "";
  const hasOtpContext = otpIndicators.some(pattern => pattern.test(pageText));
  
  // Method 2: Look for multiple single-character inputs (typical OTP pattern)
  // These are usually 4-8 inputs with maxLength=1 or single character inputs
  const allInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="tel"], input[type="number"], input:not([type])'));
  
  // Find sequences of single-digit inputs
  const singleDigitInputs = allInputs.filter(input => {
    const maxLen = input.getAttribute("maxlength");
    const inputMode = input.getAttribute("inputmode");
    const pattern = input.getAttribute("pattern");
    const value = input.value || "";
    
    // Likely OTP field if:
    // - maxlength is 1
    // - inputmode is numeric
    // - pattern is for single digit
    // - input is part of a row of similar inputs
    const isSingleDigit = maxLen === "1" || 
                          (inputMode === "numeric" && !maxLen) ||
                          (pattern && /\d/.test(pattern) && pattern.length < 10);
    
    // Also check if input is small (typical for OTP fields)
    const rect = input.getBoundingClientRect();
    const isSmall = rect.width > 0 && rect.width < 80;
    
    return isSingleDigit || (hasOtpContext && isSmall && inputMode === "numeric");
  });
  
  // If we have 4-8 single-digit inputs, likely OTP
  if (singleDigitInputs.length >= 4 && singleDigitInputs.length <= 8) {
    // Verify they're visually grouped (near each other)
    const firstRect = singleDigitInputs[0].getBoundingClientRect();
    const lastRect = singleDigitInputs[singleDigitInputs.length - 1].getBoundingClientRect();
    
    // Check if they're roughly on the same row (within 50px vertical)
    const sameRow = Math.abs(firstRect.top - lastRect.top) < 50;
    
    // Check if they're close together horizontally (total span < 500px)
    const closeHorizontally = Math.abs(lastRect.right - firstRect.left) < 500;
    
    if (sameRow && closeHorizontally) {
      special.hasOtpField = true;
      special.otpFieldCount = singleDigitInputs.length;
      // Get indices of OTP fields from the main fields extraction
      // This will be populated when we extract form fields
    }
  }
  
  // Method 3: Check for explicit OTP-labeled inputs
  if (!special.hasOtpField) {
    const otpLabeledInputs = allInputs.filter(input => {
      const label = input.getAttribute("aria-label") || "";
      const placeholder = input.getAttribute("placeholder") || "";
      const name = input.getAttribute("name") || "";
      const id = input.getAttribute("id") || "";
      
      const combined = `${label} ${placeholder} ${name} ${id}`.toLowerCase();
      return otpIndicators.some(pattern => pattern.test(combined));
    });
    
    if (otpLabeledInputs.length >= 1) {
      special.hasOtpField = true;
      special.otpFieldCount = otpLabeledInputs.length;
    }
  }
  
  // Log for debugging
  if (special.hasOtpField) {
    console.log(`[content.js] OTP fields detected: ${special.otpFieldCount} fields`);
  }

  return special;
}

// Extract accessibility tree info for better element targeting
function extractAccessibilityInfo(el) {
  return {
    role: el.getAttribute("role") || el.tagName.toLowerCase(),
    ariaLabel: el.getAttribute("aria-label"),
    ariaDescribedBy: el.getAttribute("aria-describedby"),
    ariaRequired: el.getAttribute("aria-required") === "true",
    ariaInvalid: el.getAttribute("aria-invalid") === "true",
  };
}

// Detect validation errors for a form field
function detectFieldValidationError(el) {
  let hasError = false;
  let errorMessage = null;
  
  // Check 1: aria-invalid attribute
  if (el.getAttribute("aria-invalid") === "true") {
    hasError = true;
  }
  
  // Check 2: CSS classes indicating error
  const errorClasses = ["error", "invalid", "has-error", "is-invalid", "field-error", "input-error"];
  const elClasses = el.className.toLowerCase();
  if (errorClasses.some(c => elClasses.includes(c))) {
    hasError = true;
  }
  
  // Check 3: Parent element has error class
  const parent = el.closest(".form-group, .field-wrapper, .input-group, .form-field");
  if (parent) {
    const parentClasses = parent.className.toLowerCase();
    if (errorClasses.some(c => parentClasses.includes(c))) {
      hasError = true;
    }
  }
  
  // Check 4: Red border (common error indicator)
  const style = window.getComputedStyle(el);
  const borderColor = style.borderColor.toLowerCase();
  // Check for red-ish border colors (rgb values where red > green and red > blue significantly)
  const rgbMatch = borderColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch.map(Number);
    if (r > 180 && g < 100 && b < 100) {
      hasError = true;
    }
  }
  
  // Check 5: Look for nearby error message elements
  if (hasError) {
    // Try aria-describedby first
    const describedBy = el.getAttribute("aria-describedby");
    if (describedBy) {
      const errorEl = document.getElementById(describedBy);
      if (errorEl) {
        errorMessage = errorEl.textContent.trim().slice(0, 200);
      }
    }
    
    // Look for adjacent error elements
    if (!errorMessage) {
      const siblings = [];
      let next = el.nextElementSibling;
      for (let i = 0; i < 3 && next; i++) {
        siblings.push(next);
        next = next.nextElementSibling;
      }
      
      for (const sib of siblings) {
        const sibClasses = (sib.className || "").toLowerCase();
        const sibText = sib.textContent.trim();
        if (
          (sibClasses.includes("error") || sibClasses.includes("invalid") || sibClasses.includes("help-block")) &&
          sibText.length > 0 && sibText.length < 300
        ) {
          errorMessage = sibText;
          break;
        }
      }
    }
    
    // Look for error message in parent container
    if (!errorMessage && parent) {
      const errorEl = parent.querySelector(".error-message, .field-error, .invalid-feedback, .help-block.error, [role='alert']");
      if (errorEl) {
        errorMessage = errorEl.textContent.trim().slice(0, 200);
      }
    }
  }
  
  return { hasError, errorMessage };
}

// Detect if an element is a custom dropdown/combobox (not native <select>)
function detectCustomDropdown(el) {
  const role = el.getAttribute("role");
  const ariaHasPopup = el.getAttribute("aria-haspopup");
  const ariaExpanded = el.getAttribute("aria-expanded");
  const ariaControls = el.getAttribute("aria-controls");
  const classes = (el.className || "").toLowerCase();
  
  // Check for combobox role
  const isCombobox = role === "combobox";
  
  // Check for listbox trigger patterns
  const hasListboxPopup = ariaHasPopup === "listbox" || ariaHasPopup === "true";
  
  // Check for aria-expanded (indicates expandable element)
  const hasExpandedAttr = ariaExpanded !== null;
  
  // Check for common dropdown class patterns
  const dropdownClasses = ["dropdown", "combobox", "autocomplete", "select2", "choices", "multiselect", "typeahead"];
  const hasDropdownClass = dropdownClasses.some(c => classes.includes(c));
  
  // Determine if this is a custom dropdown
  const isCustomDropdown = isCombobox || (hasListboxPopup && hasExpandedAttr) || (hasExpandedAttr && hasDropdownClass);
  
  if (!isCustomDropdown) {
    return { isCustomDropdown: false };
  }
  
  // Get expanded state
  const dropdownExpanded = ariaExpanded === "true";
  
  // Try to find associated listbox options
  let dropdownOptions = [];
  
  if (dropdownExpanded) {
    // Look for listbox by aria-controls
    let listbox = null;
    if (ariaControls) {
      listbox = document.getElementById(ariaControls);
    }
    
    // Fallback: look for nearby listbox
    if (!listbox) {
      listbox = el.parentElement?.querySelector('[role="listbox"]') ||
                document.querySelector('[role="listbox"]:not([hidden])');
    }
    
    // Fallback: look for dropdown menu / options container
    if (!listbox) {
      const dropdownMenu = el.parentElement?.querySelector('.dropdown-menu, .select-options, .choices__list, .autocomplete-results');
      if (dropdownMenu) listbox = dropdownMenu;
    }
    
    if (listbox) {
      // Extract options from listbox
      const optionElements = listbox.querySelectorAll('[role="option"], li, .dropdown-item, .select-option');
      optionElements.forEach((opt, idx) => {
        const text = opt.textContent.trim();
        if (text && text.length < 200) {
          dropdownOptions.push({
            index: idx,
            text: text,
            value: opt.getAttribute("data-value") || opt.getAttribute("value") || text,
            selected: opt.getAttribute("aria-selected") === "true" || opt.classList.contains("selected")
          });
        }
      });
      // Limit options
      dropdownOptions = dropdownOptions.slice(0, 50);
    }
  }
  
  return {
    isCustomDropdown: true,
    dropdownExpanded,
    dropdownOptions,
    ariaControls
  };
}

// Extract custom dropdown elements (div-based comboboxes, not native selects)
function extractCustomDropdowns(scopeElement = document) {
  const dropdowns = [];
  
  // Query for elements that might be custom dropdowns
  const selectors = [
    '[role="combobox"]',
    '[aria-haspopup="listbox"]',
    '[aria-expanded][class*="dropdown"]',
    '[aria-expanded][class*="select"]',
    '[aria-expanded][class*="combobox"]',
    '.select2-container',
    '.choices',
    '[data-dropdown]'
  ];
  
  const elements = scopeElement.querySelectorAll(selectors.join(", "));
  
  elements.forEach((el, index) => {
    // Skip invisible elements
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || el.offsetParent === null) return;
    
    // Skip native selects (handled separately)
    if (el.tagName === "SELECT") return;
    
    const dropdownInfo = detectCustomDropdown(el);
    if (!dropdownInfo.isCustomDropdown) return;
    
    // Get element context
    const context = getElementContext(el);
    
    // Try to find a label
    let label = null;
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) label = labelEl.textContent.trim();
    }
    if (!label) {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) label = ariaLabel;
    }
    if (!label) {
      // Look for nearby label
      const parent = el.closest(".form-group, .field-wrapper, .form-field");
      if (parent) {
        const labelEl = parent.querySelector("label");
        if (labelEl) label = labelEl.textContent.trim();
      }
    }
    
    // Get current displayed value
    let currentValue = "";
    const valueDisplay = el.querySelector('.select2-selection__rendered, .choices__inner, [class*="value"], [class*="placeholder"]');
    if (valueDisplay) {
      currentValue = valueDisplay.textContent.trim();
    } else {
      currentValue = el.textContent.trim().slice(0, 100);
    }
    
    dropdowns.push({
      index: 1000 + index, // Offset to avoid collision with regular field indices
      tag: "custom-dropdown",
      type: "custom-dropdown",
      id: el.id || null,
      label,
      placeholder: el.getAttribute("placeholder") || null,
      required: el.getAttribute("aria-required") === "true",
      disabled: el.getAttribute("aria-disabled") === "true",
      value: currentValue,
      context,
      isCustomDropdown: true,
      dropdownExpanded: dropdownInfo.dropdownExpanded,
      dropdownOptions: dropdownInfo.dropdownOptions,
      ariaControls: dropdownInfo.ariaControls,
      ...extractAccessibilityInfo(el)
    });
  });
  
  return dropdowns.slice(0, 30); // Limit
}

// Extract all form fields with structured data
function extractFormFields(scopeElement = document) {
  const fields = [];
  const elements = scopeElement.querySelectorAll("input, textarea, select");
  
  elements.forEach((el, index) => {
    // Skip hidden and submit/button inputs
    const type = el.getAttribute("type") || (el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : "text");
    if (type === "hidden" || type === "submit" || type === "button" || type === "image") return;
    
    // Skip invisible elements
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || el.offsetParent === null) return;
    
    // Check for validation errors on this field
    const validationError = detectFieldValidationError(el);
    
    // Get element context (MODAL, NAV, MAIN, etc.)
    const context = getElementContext(el);
    
    const field = {
      index,
      tag: el.tagName.toLowerCase(),
      type,
      id: el.id || null,
      name: el.getAttribute("name") || null,
      label: findLabelForElement(el),
      placeholder: el.getAttribute("placeholder") || null,
      required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
      disabled: el.disabled,
      readonly: el.readOnly,
      value: el.value || "",
      // For select elements, include options
      options: el.tagName === "SELECT" ? Array.from(el.options).map(o => ({ value: o.value, text: o.text, selected: o.selected })) : null,
      // For checkboxes/radios
      checked: (type === "checkbox" || type === "radio") ? el.checked : null,
      // Additional attributes that might help identify the field
      autocomplete: el.getAttribute("autocomplete") || null,
      pattern: el.getAttribute("pattern") || null,
      maxLength: el.getAttribute("maxlength") ? parseInt(el.getAttribute("maxlength")) : null,
      // Validation error detection
      hasError: validationError.hasError,
      errorMessage: validationError.errorMessage,
      // Element context (MODAL, NAV, MAIN, etc.)
      context,
      // Accessibility info
      ...extractAccessibilityInfo(el),
    };
    
    fields.push(field);
  });
  
  return fields.slice(0, 100); // Limit to 100 fields
}

// Check if a link looks like an action button based on text
function isActionLink(el) {
  if (el.tagName !== "A") return false;
  const text = (el.innerText || "").toLowerCase().trim();
  const actionKeywords = [
    "apply", "submit", "continue", "next", "sign in", "log in", "login", 
    "sign up", "register", "create account", "get started", "start application",
    "begin application", "apply now", "apply for this job", "easy apply", "quick apply"
  ];
  return actionKeywords.some(keyword => text.includes(keyword));
}

// Extract clickable buttons
function extractButtons(scopeElement = document) {
  const buttons = [];
  
  // Standard button selectors
  const standardElements = scopeElement.querySelectorAll("button, input[type='submit'], input[type='button'], a[role='button'], [role='button']");
  
  // Also find action-looking links (for Lever, Greenhouse, etc.)
  const allLinks = scopeElement.querySelectorAll("a");
  const actionLinks = Array.from(allLinks).filter(isActionLink);
  
  // Combine and dedupe
  const allElements = new Set([...standardElements, ...actionLinks]);
  
  let index = 0;
  allElements.forEach((el) => {
    // Skip invisible elements
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || el.offsetParent === null) return;
    
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
    if (!text) return;
    
    // Get element context (MODAL, NAV, MAIN, etc.)
    const context = getElementContext(el);
    
    buttons.push({
      index: index++,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || (el.tagName === "BUTTON" ? "button" : "link"),
      text,
      id: el.id || null,
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
      // Element context (MODAL, NAV, MAIN, etc.)
      context,
      // Accessibility info
      ...extractAccessibilityInfo(el),
    });
  });
  
  return buttons.slice(0, 40); // Limit to 40 buttons (increased for action links)
}

// ============================================================================
// CANDIDATE REGISTRY (EXECUTOR V2)
// ============================================================================

function cssEscapeSafe(value) {
  if (window.CSS && typeof CSS.escape === "function") return CSS.escape(value);
  return (value || "").replace(/["\\]/g, "\\$&");
}

function stableHash(input) {
  let hash = 5381;
  const str = String(input || "");
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash.toString(36);
}

function buildStableKeyForElement(el) {
  const parts = [
    el.getAttribute("name") || "",
    el.getAttribute("data-testid") || el.getAttribute("data-test-id") || "",
    el.getAttribute("aria-label") || "",
    (el.innerText || el.value || "").trim(),
    (el.getAttribute("role") || el.tagName || "").toLowerCase()
  ];
  return parts.join("|").trim();
}

function getOrAssignVaultyId(el) {
  if (!el) return null;
  const existing = el.getAttribute(VAULTY_ID_ATTR);
  if (existing) return existing;
  if (el.id) return `id:${el.id}`;
  const key = buildStableKeyForElement(el);
  const hash = stableHash(key || "node");
  const vaultyId = `v-${hash}`;
  try {
    el.setAttribute(VAULTY_ID_ATTR, vaultyId);
  } catch (e) {
    // Ignore setAttribute failures for protected nodes
  }
  return vaultyId;
}

function collectElementsDeep(root, selectors) {
  const results = [];
  const visit = (node) => {
    if (!node || !node.querySelectorAll) return;
    results.push(...node.querySelectorAll(selectors));
    const all = node.querySelectorAll("*");
    all.forEach(el => {
      if (el.shadowRoot) visit(el.shadowRoot);
    });
  };
  visit(root);
  return results;
}

function getDomPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part += `#${node.id}`;
    } else if (node.className) {
      const cls = String(node.className).trim().split(/\s+/)[0];
      if (cls) part += `.${cls}`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(">");
}

function getShadowPath(el) {
  const path = [];
  let current = el;
  while (current) {
    const root = current.getRootNode();
    if (root && root.host) {
      const host = root.host;
      const desc = host.id ? `#${host.id}` : host.tagName.toLowerCase();
      path.push(desc);
      current = host;
    } else {
      break;
    }
  }
  return path;
}

function getVisibilityInfo(el) {
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const isVisible = style.display !== "none" &&
    style.visibility !== "hidden" &&
    rect.width > 0 &&
    rect.height > 0;
  const isEnabled = !(el.disabled || el.getAttribute("aria-disabled") === "true");
  return { isVisible, isEnabled };
}

function getCandidateText(el) {
  return (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
}

function findSectionHeading(el) {
  const container = el.closest("section, fieldset, form, [role='group']");
  if (container) {
    const heading = container.querySelector("legend, h1, h2, h3, h4, h5");
    if (heading) return heading.textContent.trim().slice(0, 120);
  }
  let prev = el.previousElementSibling;
  for (let i = 0; i < 3 && prev; i++) {
    if (/H[1-6]/.test(prev.tagName)) {
      return prev.textContent.trim().slice(0, 120);
    }
    prev = prev.previousElementSibling;
  }
  return null;
}

function classifyCandidateType(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    if (t === "submit" || t === "button" || t === "image") return "button";
    return "input";
  }
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  return "element";
}

function buildCandidateFromElement(el) {
  const visibility = getVisibilityInfo(el);
  const type = classifyCandidateType(el);
  const dropdownInfo = detectCustomDropdown(el);
  const isCustomDropdown = dropdownInfo.isCustomDropdown;
  const role = el.getAttribute("role") ||
    (isCustomDropdown ? "combobox" :
      type === "button" ? "button" :
        type === "link" ? "link" :
          type === "input" ? "textbox" :
            el.tagName.toLowerCase());
  const rect = el.getBoundingClientRect();
  const form = el.closest("form");

  return {
    vaultyId: null,
    type: isCustomDropdown ? "custom-dropdown" : type,
    role,
    text: getCandidateText(el),
    label: findLabelForElement(el),
    placeholder: el.getAttribute("placeholder") || null,
    ariaLabel: el.getAttribute("aria-label") || null,
    attributes: {
      id: el.id || null,
      name: el.getAttribute("name") || null,
      dataTestId: el.getAttribute("data-testid") || el.getAttribute("data-test-id") || null,
      type: el.getAttribute("type") || null
    },
    context: getElementContext(el),
    formId: form?.id || form?.getAttribute("name") || null,
    sectionHeading: findSectionHeading(el),
    visibility,
    bbox: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    },
    domPath: getDomPath(el),
    shadowPath: getShadowPath(el),
    isCustomDropdown
  };
}

function buildPublicCandidate(candidate) {
  return {
    vaultyId: candidate.vaultyId,
    type: candidate.type,
    role: candidate.role,
    text: candidate.text,
    label: candidate.label,
    placeholder: candidate.placeholder,
    ariaLabel: candidate.ariaLabel,
    attributes: candidate.attributes,
    context: candidate.context,
    formId: candidate.formId,
    sectionHeading: candidate.sectionHeading,
    isVisible: candidate.visibility.isVisible,
    isEnabled: candidate.visibility.isEnabled
  };
}

function buildCandidateRegistry(scope = document, scopeKey = "PAGE") {
  const elements = new Set();
  const usedIds = new Map();
  const candidates = [];
  const publicCandidates = [];
  const elementMap = new Map();
  const candidateById = new Map();

  const fieldElements = collectElementsDeep(scope, "input, textarea, select");
  fieldElements.forEach(el => {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "hidden" || type === "submit" || type === "button" || type === "image") return;
    elements.add(el);
  });

  const buttonElements = collectElementsDeep(scope, "button, input[type='submit'], input[type='button'], a[role='button'], [role='button']");
  buttonElements.forEach(el => elements.add(el));

  const linkElements = collectElementsDeep(scope, "a");
  linkElements.forEach(el => {
    if (isActionLink(el)) elements.add(el);
  });

  const dropdownTriggers = collectElementsDeep(scope, "[role='combobox'], [aria-haspopup='listbox'], [aria-expanded][class*='dropdown'], [aria-expanded][class*='select']");
  dropdownTriggers.forEach(el => elements.add(el));

  elements.forEach(el => {
    const visibility = getVisibilityInfo(el);
    if (!visibility.isVisible) return;
    const text = getCandidateText(el);
    if (!text && el.tagName !== "INPUT" && el.tagName !== "SELECT" && el.tagName !== "TEXTAREA") {
      return;
    }

    const candidate = buildCandidateFromElement(el);
    let vaultyId = getOrAssignVaultyId(el);
    if (!vaultyId) return;
    if (usedIds.has(vaultyId)) {
      const count = usedIds.get(vaultyId) + 1;
      usedIds.set(vaultyId, count);
      vaultyId = `${vaultyId}~${count}`;
      if (!el.id) {
        try {
          el.setAttribute(VAULTY_ID_ATTR, vaultyId);
        } catch (e) {
          // Ignore setAttribute failures
        }
      }
    } else {
      usedIds.set(vaultyId, 0);
    }

    candidate.vaultyId = vaultyId;
    candidates.push(candidate);
    publicCandidates.push(buildPublicCandidate(candidate));
    elementMap.set(vaultyId, el);
    candidateById.set(vaultyId, candidate);
  });

  vaultyRegistry = {
    version: ++vaultyRegistryVersion,
    builtAt: Date.now(),
    url: location.href,
    routeVersion,
    scopeKey,
    candidates,
    publicCandidates,
    elementMap,
    candidateById
  };

  return vaultyRegistry;
}

function getCandidateRegistry({ scope = document, scopeKey = "PAGE", force = false } = {}) {
  if (!force && vaultyRegistry &&
      vaultyRegistry.url === location.href &&
      vaultyRegistry.routeVersion === routeVersion &&
      vaultyRegistry.scopeKey === scopeKey) {
    return vaultyRegistry;
  }
  return buildCandidateRegistry(scope, scopeKey);
}

function findByLabel(text) {
  const labels = Array.from(document.querySelectorAll("label"));
  const wanted = norm(text);
  // Also create a version without special "required" markers (✱, *, etc.)
  const wantedClean = wanted.replace(/[✱✳*★†‡§]/g, "").trim();
  
  // Try exact match first
  let label = labels.find(l => norm(l.innerText) === wanted);
  
  // Try without special markers
  if (!label) {
    label = labels.find(l => {
      const labelClean = norm(l.innerText).replace(/[✱✳*★†‡§]/g, "").trim();
      return labelClean === wantedClean;
    });
  }
  
  // Try partial/includes match as last resort
  if (!label) {
    label = labels.find(l => {
      const labelClean = norm(l.innerText).replace(/[✱✳*★†‡§]/g, "").trim();
      return labelClean.includes(wantedClean) || wantedClean.includes(labelClean);
    });
  }
  
  if (!label) return null;
  const forId = label.getAttribute("for");
  if (forId) return document.getElementById(forId);
  return label.querySelector("input, textarea, select");
}

function findByText(text, exact = false) {
  const wanted = norm(text);
  // Include all links (not just role=button) to catch action links like "Apply for this job"
  const candidates = Array.from(
    document.querySelectorAll("button, a, [role='button'], input[type='submit'], input[type='button']")
  ).filter(el => {
    // Filter to visible elements only
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
  });
  return candidates.find(el => {
    const t = norm(el.innerText || el.value || "");
    return exact ? t === wanted : t.includes(wanted);
  }) || null;
}

function findByRole(role, name) {
  const r = norm(role);
  const candidates = Array.from(document.querySelectorAll(`[role="${role}"], button, a`));
  const byRole = candidates.filter(el => norm(el.getAttribute("role") || (el.tagName === "BUTTON" ? "button" : "")) === r);
  if (!name) return byRole[0] || null;
  const wanted = norm(name);
  return byRole.find(el => norm(el.innerText).includes(wanted)) || null;
}

function findById(id) {
  return document.getElementById(id);
}

function findByIndex(index, type = "field") {
  if (type === "field") {
    const elements = document.querySelectorAll("input, textarea, select");
    return elements[index] || null;
  } else if (type === "button") {
    // Match the same logic as extractButtons - include action links
    const standardElements = document.querySelectorAll("button, input[type='submit'], input[type='button'], a[role='button'], [role='button']");
    const allLinks = document.querySelectorAll("a");
    const actionLinks = Array.from(allLinks).filter(isActionLink);
    
    // Combine and dedupe, then filter visible
    const allElements = [...new Set([...standardElements, ...actionLinks])].filter(el => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.offsetParent !== null;
    });
    
    return allElements[index] || null;
  }
  return null;
}

function isTopmost(el) {
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
    const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
    const topEl = document.elementFromPoint(x, y);
    return topEl === el || el.contains(topEl);
  } catch (e) {
    return false;
  }
}

function computeTextMatchScore(targetText, candidate) {
  if (!targetText) return { score: 0, reason: null };
  const pool = [candidate.text, candidate.ariaLabel, candidate.label].filter(Boolean).map(norm);
  const exactTargets = [];
  const containsTargets = [];

  if (typeof targetText === "string") {
    exactTargets.push(targetText);
  } else {
    if (targetText.exact) exactTargets.push(targetText.exact);
    if (Array.isArray(targetText.contains)) containsTargets.push(...targetText.contains);
  }

  for (const exact of exactTargets) {
    const wanted = norm(exact);
    if (pool.some(t => t === wanted)) return { score: 1, reason: "text:exact" };
  }
  for (const part of containsTargets) {
    const wanted = norm(part);
    if (pool.some(t => t.includes(wanted))) return { score: 0.7, reason: "text:contains" };
  }

  return { score: 0, reason: null };
}

function computeLabelMatchScore(targetLabel, candidate) {
  if (!targetLabel || !candidate.label) return { score: 0, reason: null };
  const wanted = norm(targetLabel);
  const label = norm(candidate.label);
  if (label === wanted) return { score: 1, reason: "label:exact" };
  if (label.includes(wanted) || wanted.includes(label)) return { score: 0.7, reason: "label:contains" };
  return { score: 0, reason: null };
}

function computeRoleMatchScore(targetRole, candidate) {
  if (!targetRole) return { score: 0, reason: null };
  if (norm(targetRole) === norm(candidate.role)) return { score: 1, reason: "role" };
  return { score: 0, reason: null };
}

function computeAttributeMatchScore(targetAttributes, candidate) {
  if (!targetAttributes) return { score: 0, reason: null };
  let score = 0;
  let reason = null;
  if (targetAttributes.id && candidate.attributes.id === targetAttributes.id) {
    score = 1;
    reason = "attr:id";
  }
  if (targetAttributes.dataTestId && candidate.attributes.dataTestId === targetAttributes.dataTestId) {
    score = Math.max(score, 1);
    reason = "attr:data-testid";
  }
  if (targetAttributes.name && candidate.attributes.name === targetAttributes.name) {
    score = Math.max(score, 0.7);
    reason = reason || "attr:name";
  }
  return { score, reason };
}

function computeContextMatchScore(targetContext, candidate) {
  if (!targetContext) return { score: 0, reason: null };
  let score = 0;
  let reason = null;

  if (targetContext.form && candidate.formId) {
    const wanted = norm(targetContext.form);
    const formId = norm(candidate.formId);
    if (formId && (formId === wanted || formId.includes(wanted))) {
      score = 1;
      reason = "context:form";
    }
  }

  if (targetContext.section && candidate.sectionHeading) {
    const wanted = norm(targetContext.section);
    const section = norm(candidate.sectionHeading);
    if (section && (section === wanted || section.includes(wanted))) {
      score = Math.max(score, 0.7);
      reason = reason || "context:section";
    }
  }

  if (targetContext.modalTitle && candidate.context === "MODAL") {
    score = Math.max(score, 0.6);
    reason = reason || "context:modal";
  }

  return { score, reason };
}

function computeCandidateScore(target, candidate) {
  const reasons = [];
  const textScore = computeTextMatchScore(target.text, candidate);
  const roleScore = computeRoleMatchScore(target.role, candidate);
  const labelScore = computeLabelMatchScore(target.label, candidate);
  const attrScore = computeAttributeMatchScore(target.attributes, candidate);
  const ctxScore = computeContextMatchScore(target.context, candidate);
  const visibilityScore = candidate.visibility.isVisible && candidate.visibility.isEnabled ? 1 : 0;

  if (textScore.score) reasons.push(textScore.reason);
  if (roleScore.score) reasons.push(roleScore.reason);
  if (labelScore.score) reasons.push(labelScore.reason);
  if (attrScore.score) reasons.push(attrScore.reason);
  if (ctxScore.score) reasons.push(ctxScore.reason);
  if (visibilityScore) reasons.push("visible");

  const score =
    0.40 * textScore.score +
    0.20 * roleScore.score +
    0.15 * labelScore.score +
    0.10 * attrScore.score +
    0.10 * ctxScore.score +
    0.05 * visibilityScore;

  return { score, reasons };
}

function resolveByVaultyId(vaultyId, registry) {
  if (!vaultyId) return null;
  if (vaultyId.startsWith("id:")) {
    const id = vaultyId.slice(3);
    const el = document.getElementById(id);
    if (el) return el;
  }
  if (registry?.elementMap?.has(vaultyId)) {
    const el = registry.elementMap.get(vaultyId);
    if (el && el.isConnected) return el;
  }
  const selector = `[${VAULTY_ID_ATTR}="${cssEscapeSafe(vaultyId)}"]`;
  return document.querySelector(selector);
}

function resolveTargetV2(target, registry) {
  const trace = {
    method: target?.by || "unknown",
    candidatesTotal: registry?.candidates?.length || 0
  };
  if (!target) {
    trace.failureReason = "no_target";
    return { element: null, trace };
  }

  if (target.by === "vaultyId") {
    trace.vaultyId = target.id;
    const el = resolveByVaultyId(target.id, registry);
    if (!el) {
      trace.failureReason = "vaultyId_not_found";
      return { element: null, trace };
    }
    return { element: el, trace, candidate: registry?.candidateById?.get(target.id) || null };
  }

  if (target.by === "intent") {
    if (!registry || !registry.candidates) {
      trace.failureReason = "no_registry";
      return { element: null, trace };
    }
    const constraints = target.constraints || {};
    const scored = [];

    for (const candidate of registry.candidates) {
      if (constraints.mustBeVisible && !candidate.visibility.isVisible) continue;
      if (constraints.mustBeEnabled && !candidate.visibility.isEnabled) continue;
      if (constraints.mustBeTopmost) {
        const el = registry.elementMap.get(candidate.vaultyId);
        if (!el || !isTopmost(el)) continue;
      }

      const result = computeCandidateScore(target, candidate);
      scored.push({ candidate, score: result.score, reasons: result.reasons });
    }

    trace.candidatesAfterFilter = scored.length;
    scored.sort((a, b) => b.score - a.score);
    trace.topMatches = scored.slice(0, 3).map(s => ({
      vaultyId: s.candidate.vaultyId,
      score: Number(s.score.toFixed(2)),
      reasons: s.reasons
    }));

    const best = scored[0];
    if (!best || best.score < 0.45) {
      trace.failureReason = "score_below_threshold";
      return { element: null, trace };
    }

    if (scored[1] && Math.abs(best.score - scored[1].score) <= 0.05) {
      trace.note = "close_scores";
    }

    const el = registry.elementMap.get(best.candidate.vaultyId);
    if (!el) {
      trace.failureReason = "element_missing";
      return { element: null, trace };
    }

    trace.chosen = best.candidate.vaultyId;
    return { element: el, trace, candidate: best.candidate };
  }

  const el = resolveTarget(target);
  if (!el) trace.failureReason = "legacy_not_found";
  return { element: el, trace };
}

function resolveTarget(target) {
  if (!target) return null;
  switch (target.by) {
    case "label": return findByLabel(target.text);
    case "text": return findByText(target.text, target.exact);
    case "role": return findByRole(target.role, target.name);
    case "css": return document.querySelector(target.selector);
    case "id": return findById(target.selector || target.id);
    case "index": return findByIndex(target.index, target.elementType);
    case "xpath": {
      const res = document.evaluate(target.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return res.singleNodeValue;
    }
    default: return null;
  }
}

function highlight(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.style.outline = "3px solid #4F46E5";
  setTimeout(() => (el.style.outline = ""), 700);
}

// Highlight multiple elements (for "Show what I see" feature)
function highlightAllElements(show) {
  // Clear existing highlights
  highlightedElements.forEach(el => {
    if (el && el.style) {
      el.style.outline = "";
      el.style.boxShadow = "";
    }
  });
  highlightedElements = [];

  if (!show) return;

  // Highlight all form fields
  const fields = document.querySelectorAll("input, textarea, select");
  fields.forEach((el, idx) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    
    el.style.outline = "2px solid #22c55e";
    el.style.boxShadow = "0 0 0 4px rgba(34, 197, 94, 0.2)";
    highlightedElements.push(el);
  });

  // Highlight all buttons
  const buttons = document.querySelectorAll("button, input[type='submit'], input[type='button'], a[role='button'], [role='button']");
  buttons.forEach((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return;
    
    el.style.outline = "2px solid #6366f1";
    el.style.boxShadow = "0 0 0 4px rgba(99, 102, 241, 0.2)";
    highlightedElements.push(el);
  });
}

// Detect active modal/dialog on the page
function detectActiveModal() {
  // Common modal selectors in order of specificity
  const modalSelectors = [
    '[role="dialog"][aria-modal="true"]',
    '[role="dialog"]',
    '[aria-modal="true"]',
    '.modal.show',
    '.modal.open',
    '.modal.active',
    '.modal.in',
    '.modal[style*="display: block"]',
    '.modal[style*="display:block"]',
    '.dialog.open',
    '.dialog.show',
    '.overlay.active',
    '.ReactModal__Content',
    '.MuiDialog-root',
    '.MuiModal-root',
    '[data-modal="true"]',
    '[data-dialog="true"]',
    '.ant-modal-wrap:not([style*="display: none"])',
    '.el-dialog__wrapper:not([style*="display: none"])',
  ];
  
  for (const selector of modalSelectors) {
    try {
      const modals = document.querySelectorAll(selector);
      for (const modal of modals) {
        // Check if modal is visible
        const style = window.getComputedStyle(modal);
        if (style.display !== 'none' && style.visibility !== 'hidden' && modal.offsetParent !== null) {
          // Get modal title if available
          const titleEl = modal.querySelector('h1, h2, h3, h4, [class*="title"], [class*="header"] h1, [class*="header"] h2');
          const modalTitle = titleEl?.textContent?.trim()?.slice(0, 100) || null;
          
          return {
            element: modal,
            title: modalTitle,
            selector: selector
          };
        }
      }
    } catch (e) {
      // Skip invalid selectors
    }
  }
  
  return null;
}

// Get the context/region of an element
function getElementContext(el) {
  // Check if in modal (highest priority)
  if (el.closest('[role="dialog"], [aria-modal="true"], .modal, .dialog, .ReactModal__Content, .MuiDialog-root')) {
    return "MODAL";
  }
  
  // Check if in navigation
  if (el.closest('nav, header, [role="navigation"], [role="banner"], .navbar, .nav-bar, .navigation, .header')) {
    return "NAV";
  }
  
  // Check if in sidebar
  if (el.closest('aside, [role="complementary"], .sidebar, .side-bar, .side-panel')) {
    return "SIDEBAR";
  }
  
  // Check if in footer
  if (el.closest('footer, [role="contentinfo"], .footer')) {
    return "FOOTER";
  }
  
  // Check if in main content
  if (el.closest('main, [role="main"], .main, .content, .main-content, article, .article')) {
    return "MAIN";
  }
  
  // Check if in a form (generic form context)
  if (el.closest('form')) {
    return "FORM";
  }
  
  return "PAGE";
}

// Enhanced observe function with structured data
function observe() {
  const url = location.href;
  const title = document.title;
  
  // Detect if there's an active modal
  const activeModal = detectActiveModal();
  const scope = activeModal?.element || document;
  const scopeKey = activeModal ? `MODAL:${activeModal.title || "unknown"}` : "PAGE";
  const registry = getCandidateRegistry({ scope, scopeKey, force: true });
  
  // Extract elements - scoped to modal if one is active
  const fields = extractFormFields(scope);
  const customDropdowns = extractCustomDropdowns(scope);
  const buttons = extractButtons(scope);
  const specialElements = detectSpecialElements();
  
  // Merge custom dropdowns into fields array for unified handling
  const allFields = [...fields, ...customDropdowns];
  
  // Get page context - from modal if active, otherwise full page
  let pageContext;
  if (activeModal) {
    pageContext = (activeModal.element.innerText || "").slice(0, 4000);
  } else {
    pageContext = (document.body?.innerText || "").slice(0, 4000);
  }
  
  return { 
    url, 
    title, 
    fields: allFields,
    buttons,
    specialElements,
    pageContext,
    // Modal awareness
    hasActiveModal: !!activeModal,
    modalTitle: activeModal?.title || null,
    candidates: registry.publicCandidates,
    registryVersion: registry.version,
    // Legacy field for backward compatibility
    text: pageContext,
    // Route tracking info
    routeVersion,
    lastNavAt
  };
}

function needsRegistryForTarget(target) {
  return !!target && (target.by === "vaultyId" || target.by === "intent");
}

function resolveTargetForAction(action, options = {}) {
  const target = action?.target;
  const activeModal = detectActiveModal();
  const scope = activeModal?.element || document;
  const scopeKey = activeModal ? `MODAL:${activeModal.title || "unknown"}` : "PAGE";
  let registry = null;

  if (options.forceRegistry || needsRegistryForTarget(target)) {
    registry = getCandidateRegistry({ scope, scopeKey, force: options.forceRegistry === true });
  }

  let resolved = resolveTargetV2(target, registry);
  if (!resolved.element && registry && resolved.trace?.failureReason === "vaultyId_not_found" && !options.forceRegistry) {
    registry = getCandidateRegistry({ scope, scopeKey, force: true });
    resolved = resolveTargetV2(target, registry);
    if (resolved.trace) resolved.trace.refreshed = true;
  }

  return { ...resolved, registry };
}

function computeDomFingerprint() {
  const elements = document.querySelectorAll("*");
  let hash = elements.length;
  hash += (document.body?.innerText?.length || 0) % 1000;
  return hash;
}

function normalizeValue(value) {
  return String(value ?? "").trim();
}

function getElementValue(el) {
  if (!el) return "";
  if (el.isContentEditable) {
    return el.innerText || "";
  }
  if ("value" in el) {
    return el.value ?? "";
  }
  return el.textContent || "";
}

async function verifyFillResult(el, expectedValue) {
  const expected = normalizeValue(expectedValue);
  let actual = normalizeValue(getElementValue(el));
  if (actual === expected) return { ok: true, expected, actual };
  if (actual && expected && (actual.includes(expected) || expected.includes(actual))) {
    return { ok: true, expected, actual, note: "soft_match" };
  }
  for (let i = 0; i < 2; i++) {
    await new Promise(r => setTimeout(r, 50));
    actual = normalizeValue(getElementValue(el));
    if (actual === expected) return { ok: true, expected, actual };
  }
  return { ok: false, expected, actual };
}

async function verifySelectResult(el, expectedValue) {
  const expected = normalizeValue(expectedValue);
  if (!el) return { ok: false, expected, actual: "" };
  const actual = normalizeValue(el.value);
  if (actual === expected) return { ok: true, expected, actual };
  const selectedText = el.options && el.selectedIndex >= 0 ? normalizeValue(el.options[el.selectedIndex]?.text || "") : "";
  if (selectedText === expected) return { ok: true, expected, actual: actual || selectedText };
  if (selectedText && expected && (selectedText.includes(expected) || expected.includes(selectedText))) {
    return { ok: true, expected, actual: selectedText, note: "soft_match" };
  }
  return { ok: false, expected, actual: actual || selectedText };
}

async function verifyCustomSelectResult(el, expectedValue) {
  const expected = normalizeValue(expectedValue);
  const display = normalizeValue(getElementValue(el)) || normalizeValue(el.getAttribute("aria-label") || "");
  if (!display) return { ok: false, expected, actual: display };
  if (display === expected) return { ok: true, expected, actual: display };
  if (display.includes(expected) || expected.includes(display)) {
    return { ok: true, expected, actual: display, note: "soft_match" };
  }
  return { ok: false, expected, actual: display };
}

async function verifyCheckResult(el, expectedChecked) {
  const expected = expectedChecked !== false;
  const actual = !!el.checked;
  return { ok: actual === expected, expected, actual };
}

async function verifyClickOutcome(beforeState, timeoutMs = 800) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 120));
    const currentUrl = location.href;
    const currentRouteVersion = routeVersion;
    const currentHash = computeDomFingerprint();
    const currentModal = detectActiveModal();
    const modalTitle = currentModal?.title || null;
    if (currentUrl !== beforeState.url) {
      return { ok: true, reason: "url_changed", from: beforeState.url, to: currentUrl };
    }
    if (currentRouteVersion !== beforeState.routeVersion) {
      return { ok: true, reason: "route_changed" };
    }
    if (currentHash !== beforeState.domHash) {
      return { ok: true, reason: "dom_changed" };
    }
    if (modalTitle !== beforeState.modalTitle) {
      return { ok: true, reason: "modal_changed" };
    }
  }
  return { ok: false, reason: "no_observable_change" };
}

async function execute(action) {
  try {
    // Tell overlay what we're doing (with enhanced data)
    window.postMessage({ 
      source: "agent", 
      type: "ACTION", 
      action,
      thinking: action._thinking,
      confidence: action._confidence,
      fieldName: action._fieldName,
      planProgress: action._planProgress
    }, "*");

    // These are control actions; no DOM interaction needed.
    if (action.type === "DONE") {
      return { ok: true, note: action.summary || "done" };
    }

    if (action.type === "REQUEST_VERIFICATION") {
      return { ok: true, note: "verification requested" };
    }

    if (action.type === "ASK_USER") {
      // Generate unique action ID for tracking the response
      const actionId = `ask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      
      // Show modal via overlay
      window.postMessage({
        source: "agent",
        type: "ASK_USER",
        question: action.question,
        options: action.options || [],
        allowCustom: action.allowCustom !== false,
        actionId
      }, "*");

      // Wait for user response (handled by background script via message)
      return { ok: true, note: "waiting for user response", actionId };
    }

    if (action.type === "NAVIGATE") {
      location.href = action.url;
      return { ok: true, note: "navigating" };
    }

    if (action.type === "WAIT_FOR") {
      const timeout = action.timeoutMs ?? 15000;
      const start = Date.now();
      let lastRefresh = 0;
      while (Date.now() - start < timeout) {
        const forceRegistry = Date.now() - lastRefresh > 1000;
        const resolved = resolveTargetForAction(action, { forceRegistry });
        if (forceRegistry) lastRefresh = Date.now();
        if (resolved.element) return { ok: true };
        await new Promise(r => setTimeout(r, 250));
      }
      return { ok: false, fatal: false, error: "WAIT_FOR timeout" };
    }

    if (action.type === "REFRESH_REGISTRY") {
      const activeModal = detectActiveModal();
      const scope = activeModal?.element || document;
      const scopeKey = activeModal ? `MODAL:${activeModal.title || "unknown"}` : "PAGE";
      const registry = getCandidateRegistry({ scope, scopeKey, force: true });
      return { ok: true, note: "registry refreshed", registryVersion: registry.version };
    }

    if (action.type === "CLICK") {
      const resolved = resolveTargetForAction(action);
      const el = resolved.element;
      if (!el) return { ok: false, fatal: false, error: "CLICK target not found", resolutionTrace: resolved.trace };
      highlight(el);

      const beforeState = {
        url: location.href,
        routeVersion,
        domHash: computeDomFingerprint(),
        modalTitle: detectActiveModal()?.title || null
      };

      // Use efficient click method
      await clickEfficient(el);
      const verification = await verifyClickOutcome(beforeState);
      if (!verification.ok) {
        return { ok: false, fatal: false, error: "CLICK no observable change", resolutionTrace: resolved.trace, verification };
      }
      return { ok: true, verification };
    }

    if (action.type === "FILL") {
      const resolved = resolveTargetForAction(action);
      const el = resolved.element;
      if (!el) return { ok: false, fatal: false, error: "FILL target not found", resolutionTrace: resolved.trace };
      
      // Prevent filling file inputs - they can only be set via UPLOAD_FILE action
      if (el.type === "file") {
        return { 
          ok: false, 
          fatal: false, 
          error: "Cannot FILL a file input - use UPLOAD_FILE action instead" 
        };
      }
      
      highlight(el);
      
      // Use native-ish typing path as default
      try {
        await typeValue(el, action.value, action.clear !== false);
      } catch (e) {
        console.info("[agent] falling back to DOM fill", { reason: e.message });
        // Fallback to old path
        el.focus();
        if (action.clear !== false) el.value = "";
        el.value = action.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const verification = await verifyFillResult(el, action.value);
      if (!verification.ok) {
        return { ok: false, fatal: false, error: "FILL value mismatch", resolutionTrace: resolved.trace, verification };
      }
      return { ok: true, verification };
    }

    if (action.type === "SELECT") {
      const resolved = resolveTargetForAction(action);
      const el = resolved.element;
      if (!el) return { ok: false, fatal: false, error: "SELECT target not found", resolutionTrace: resolved.trace };
      highlight(el);
      el.value = action.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      const verification = await verifySelectResult(el, action.value);
      if (!verification.ok) {
        return { ok: false, fatal: false, error: "SELECT value mismatch", resolutionTrace: resolved.trace, verification };
      }
      return { ok: true, verification };
    }

    if (action.type === "SELECT_CUSTOM") {
      // Handle custom dropdown/combobox selection (div-based, not native <select>)
      const resolved = resolveTargetForAction(action);
      const el = resolved.element;
      if (!el) return { ok: false, fatal: false, error: "SELECT_CUSTOM target not found", resolutionTrace: resolved.trace };
      
      highlight(el);
      const targetValue = action.value;
      
      // Check if dropdown is already expanded
      let isExpanded = el.getAttribute("aria-expanded") === "true";
      
      // Step 1: Click to open if not expanded (use efficient dropdown click)
      if (!isExpanded) {
        const expanded = await clickDropdownTrigger(el);
        isExpanded = expanded || el.getAttribute("aria-expanded") === "true";
      }
      
      // Step 2: Find the listbox/options container
      const ariaControls = el.getAttribute("aria-controls");
      let listbox = null;
      
      if (ariaControls) {
        listbox = document.getElementById(ariaControls);
      }
      
      if (!listbox) {
        // Look for nearby listbox
        listbox = el.parentElement?.querySelector('[role="listbox"]') ||
                  el.closest('[role="combobox"]')?.parentElement?.querySelector('[role="listbox"]') ||
                  document.querySelector('[role="listbox"]:not([hidden])');
      }
      
      if (!listbox) {
        // Fallback: look for dropdown menu
        listbox = el.parentElement?.querySelector('.dropdown-menu:not([hidden]), .select-options, .choices__list--dropdown, .autocomplete-results, [class*="listbox"], [class*="options"]');
      }
      
      if (!listbox) {
        // Last resort: any visible listbox on page
        const allListboxes = document.querySelectorAll('[role="listbox"], .dropdown-menu, .select-options');
        for (const lb of allListboxes) {
          const style = window.getComputedStyle(lb);
          if (style.display !== "none" && style.visibility !== "hidden" && lb.offsetParent !== null) {
            listbox = lb;
            break;
          }
        }
      }
      
      if (!listbox) {
        return { ok: false, fatal: false, error: "SELECT_CUSTOM: Could not find options listbox. Try clicking the dropdown first, then click the option." };
      }
      
      // Step 3: Find and click the matching option
      const optionElements = listbox.querySelectorAll('[role="option"], li, .dropdown-item, .select-option, [class*="option"]');
      let matchedOption = null;
      const targetLower = targetValue.toLowerCase().trim();
      
      for (const opt of optionElements) {
        const optText = opt.textContent.trim().toLowerCase();
        const optValue = (opt.getAttribute("data-value") || opt.getAttribute("value") || "").toLowerCase();
        
        // Exact match preferred
        if (optText === targetLower || optValue === targetLower) {
          matchedOption = opt;
          break;
        }
        // Partial match as fallback
        if (!matchedOption && (optText.includes(targetLower) || targetLower.includes(optText))) {
          matchedOption = opt;
        }
      }
      
      if (!matchedOption) {
        // List available options for debugging
        const availableOptions = Array.from(optionElements).slice(0, 10).map(o => o.textContent.trim()).join(", ");
        return { ok: false, fatal: false, error: `SELECT_CUSTOM: Option "${targetValue}" not found. Available: ${availableOptions}` };
      }
      
      // Click the option (use efficient click)
      highlight(matchedOption);
      await clickEfficient(matchedOption);

      // Minimal wait for selection to register
      await new Promise(r => setTimeout(r, 50));
      const verification = await verifyCustomSelectResult(el, action.value);
      if (!verification.ok) {
        return { ok: false, fatal: false, error: "SELECT_CUSTOM value mismatch", resolutionTrace: resolved.trace, verification };
      }
      return { ok: true, note: `Selected "${matchedOption.textContent.trim()}"`, verification };
    }

    if (action.type === "CHECK") {
      const resolved = resolveTargetForAction(action);
      const el = resolved.element;
      if (!el) return { ok: false, fatal: false, error: "CHECK target not found", resolutionTrace: resolved.trace };
      highlight(el);
      
      // Efficient checkbox/radio handling
      if (el.type === "checkbox" || el.type === "radio") {
        // Only click if state needs to change
        if (el.checked !== (action.checked !== false)) {
          await clickEfficient(el);
        }
      } else {
        // Fallback to direct state mutation
        el.checked = action.checked !== false;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const verification = await verifyCheckResult(el, action.checked);
      if (!verification.ok) {
        return { ok: false, fatal: false, error: "CHECK value mismatch", resolutionTrace: resolved.trace, verification };
      }
      return { ok: true, verification };
    }

    if (action.type === "UPLOAD_FILE") {
      // Find the file input element
      const resolved = resolveTargetForAction(action);
      const el = resolved.element;
      if (!el) return { ok: false, fatal: false, error: "UPLOAD_FILE target not found", resolutionTrace: resolved.trace };
      if (el.tagName !== "INPUT" || el.type !== "file") {
        return { ok: false, fatal: false, error: "Target is not a file input" };
      }
      
      // Get resume file from storage (passed via action.fileData or fetch from storage)
      let fileData = action.fileData;
      if (!fileData) {
        // Try to get from storage via background script
        try {
          const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: "GET_RESUME_FILE" }, resolve);
          });
          fileData = response?.resumeFile;
        } catch (e) {
          console.error("[content] Failed to get resume file:", e);
        }
      }
      
      if (!fileData || !fileData.base64) {
        return { ok: false, fatal: false, error: "No resume file available. Please upload one in the extension settings." };
      }
      
      try {
        // Convert base64 to binary
        const binaryString = atob(fileData.base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        
        // Create File object
        const file = new File([bytes], fileData.name, { type: fileData.type });
        
        // Use DataTransfer to set the file on the input
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        el.files = dataTransfer.files;
        
        // Trigger change event
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        
        highlight(el);
        return { ok: true, note: `Uploaded ${fileData.name}` };
      } catch (e) {
        console.error("[content] File upload failed:", e);
        return { ok: false, fatal: false, error: `File upload failed: ${e.message}` };
      }
    }

    if (action.type === "EXTRACT") {
      if (action.mode === "visibleText") return { ok: true, data: observe().pageContext };
      if (action.mode === "html") return { ok: true, data: document.documentElement.outerHTML.slice(0, 40000) };
      if (action.mode === "fields") {
        return { ok: true, data: extractFormFields() };
      }
      return { ok: true, data: observe().pageContext };
    }

    return { ok: false, fatal: true, error: `Unknown action type: ${action.type}` };
  } catch (e) {
    return { ok: false, fatal: true, error: String(e) };
  }
}

// Listen for HUD messages
window.addEventListener("message", (ev) => {
  if (!ev.data) return;

  // TOGGLE_SIDE_PANEL from mini-overlay
  if (ev.data.source === "agent-mini-overlay" && ev.data.type === "TOGGLE_SIDE_PANEL") {
    chrome.runtime.sendMessage({ type: "TOGGLE_SIDE_PANEL" });
    return;
  }

  if (ev.data.source !== "agent-hud") return;

  if (ev.data.type === "TOGGLE_HIGHLIGHTS") {
    highlightAllElements(ev.data.show);
  }

  if (ev.data.type === "USER_RESPONSE") {
    // Forward user response to background script
    chrome.runtime.sendMessage({
      type: "USER_RESPONSE",
      actionId: ev.data.actionId,
      selectedOptionId: ev.data.selectedOptionId,
      customResponse: ev.data.customResponse,
      skipped: ev.data.skipped
    });
  }

  if (ev.data.type === "PAUSE_TOGGLE") {
    chrome.runtime.sendMessage({
      type: "PAUSE_TOGGLE",
      paused: ev.data.paused
    });
  }

  if (ev.data.type === "REQUEST_HELP") {
    // User clicked "Need help?" - notify background
    chrome.runtime.sendMessage({
      type: "REQUEST_HELP"
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // Defense-in-depth - only respond to OBSERVE/EXECUTE if in the top frame
    // This prevents iframes from accidentally responding even if frameId targeting fails
    if ((msg.type === "OBSERVE" || msg.type === "EXECUTE") && window.top !== window.self) {
      return; // Ignore - we're in an iframe
    }
    
    if (msg.type === "OBSERVE_LIGHT") {
      sendResponse({
        url: location.href,
        title: document.title,
        selectedText: window.getSelection()?.toString() || "",
        pageText: document.body?.innerText?.slice(0, 6000) || "",
      });
      return;
    }
    if (msg.type === "OBSERVE") {
      // Reason can be "initial", "spa-route-change", or "manual"
      // Note: After SPA route changes (detected via history.pushState/replaceState/popstate),
      // the next OBSERVE will await page readiness (network idle + DOM stability) but won't
      // automatically re-trigger unless the caller explicitly requests it. The caller can
      // pass reason: "spa-route-change" to indicate this is a route-change-triggered observation.
      const reason = msg.reason || "initial";
      
      // Wait for page readiness (network idle + DOM stability)
      // This ensures we observe the page when it's stable, not mid-transition
      try {
        await waitForPageReady(reason);
      } catch (e) {
        console.warn("[agent] waitForPageReady error:", e);
        // Continue anyway - don't block observation
      }
      
      sendResponse(observe());
      return;
    }
    if (msg.type === "EXECUTE") {
      // Attach thinking/confidence/fieldName/planProgress to action for overlay display
      if (msg.thinking || msg.confidence) {
        msg.action._thinking = msg.thinking;
        msg.action._confidence = msg.confidence;
      }
      if (msg.fieldName) {
        msg.action._fieldName = msg.fieldName;
      }
      if (msg.planProgress) {
        msg.action._planProgress = msg.planProgress;
      }
      const result = await execute(msg.action);
      return sendResponse({ result, observation: observe() });
    }
    if (msg.type === "CLOSE_ASK_USER_MODAL") {
      window.postMessage({ source: "agent", type: "CLOSE_MODAL" }, "*");
      return sendResponse({ ok: true });
    }
    if (msg.type === "STATE_UPDATE") {
      // Relay state update to overlay for progress display
      window.postMessage({ 
        source: "agent", 
        type: "STATE_UPDATE", 
        state: msg.state 
      }, "*");
      return sendResponse({ ok: true });
    }
    sendResponse({ ok: false, error: "Unknown message" });
  })();
  return true;
});
