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
  script.src = chrome.runtime.getURL("overlay.js");
  script.type = "text/javascript";
  document.documentElement.appendChild(script);
})();

// Track highlighted elements for cleanup
let highlightedElements = [];
let pendingAskUserResponse = null;

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
    // Legacy field for backward compatibility
    text: pageContext
  };
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
      while (Date.now() - start < timeout) {
        const el = resolveTarget(action.target);
        if (el) return { ok: true };
        await new Promise(r => setTimeout(r, 250));
      }
      return { ok: false, fatal: false, error: "WAIT_FOR timeout" };
    }

    if (action.type === "CLICK") {
      const el = resolveTarget(action.target);
      if (!el) return { ok: false, fatal: false, error: "CLICK target not found" };
      highlight(el);
      el.click();
      return { ok: true };
    }

    if (action.type === "FILL") {
      const el = resolveTarget(action.target);
      if (!el) return { ok: false, fatal: false, error: "FILL target not found" };
      
      // Prevent filling file inputs - they can only be set via UPLOAD_FILE action
      if (el.type === "file") {
        return { 
          ok: false, 
          fatal: false, 
          error: "Cannot FILL a file input - use UPLOAD_FILE action instead" 
        };
      }
      
      highlight(el);
      el.focus();
      if (action.clear !== false) el.value = "";
      el.value = action.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    if (action.type === "SELECT") {
      const el = resolveTarget(action.target);
      if (!el) return { ok: false, fatal: false, error: "SELECT target not found" };
      highlight(el);
      el.value = action.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    if (action.type === "SELECT_CUSTOM") {
      // Handle custom dropdown/combobox selection (div-based, not native <select>)
      const el = resolveTarget(action.target);
      if (!el) return { ok: false, fatal: false, error: "SELECT_CUSTOM target not found" };
      
      highlight(el);
      const targetValue = action.value;
      
      // Check if dropdown is already expanded
      let isExpanded = el.getAttribute("aria-expanded") === "true";
      
      // Step 1: Click to open if not expanded
      if (!isExpanded) {
        el.click();
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        
        // Wait for dropdown to open
        await new Promise(r => setTimeout(r, 300));
        
        // Check again
        isExpanded = el.getAttribute("aria-expanded") === "true";
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
      
      // Click the option
      highlight(matchedOption);
      matchedOption.click();
      matchedOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      matchedOption.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      
      // Wait for selection to register
      await new Promise(r => setTimeout(r, 150));
      
      return { ok: true, note: `Selected "${matchedOption.textContent.trim()}"` };
    }

    if (action.type === "CHECK") {
      const el = resolveTarget(action.target);
      if (!el) return { ok: false, fatal: false, error: "CHECK target not found" };
      highlight(el);
      el.checked = action.checked !== false;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    if (action.type === "UPLOAD_FILE") {
      // Find the file input element
      const el = resolveTarget(action.target);
      if (!el) return { ok: false, fatal: false, error: "UPLOAD_FILE target not found" };
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
  if (!ev.data || ev.data.source !== "agent-hud") return;

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
    
    if (msg.type === "OBSERVE") {
      return sendResponse(observe());
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
