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
  
  if (window.__agentOverlayInjected) return;
  window.__agentOverlayInjected = true;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("overlay.js");
  script.type = "text/javascript";
  document.documentElement.appendChild(script);
})();

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

// Extract all form fields with structured data
function extractFormFields() {
  const fields = [];
  const elements = document.querySelectorAll("input, textarea, select");
  
  elements.forEach((el, index) => {
    // Skip hidden and submit/button inputs
    const type = el.getAttribute("type") || (el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : "text");
    if (type === "hidden" || type === "submit" || type === "button" || type === "image") return;
    
    // Skip invisible elements
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || el.offsetParent === null) return;
    
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
    };
    
    fields.push(field);
  });
  
  return fields.slice(0, 100); // Limit to 100 fields
}

// Extract clickable buttons
function extractButtons() {
  const buttons = [];
  const elements = document.querySelectorAll("button, input[type='submit'], input[type='button'], a[role='button'], [role='button']");
  
  elements.forEach((el, index) => {
    // Skip invisible elements
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || el.offsetParent === null) return;
    
    const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
    if (!text) return;
    
    buttons.push({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || (el.tagName === "BUTTON" ? "button" : "link"),
      text,
      id: el.id || null,
      disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
    });
  });
  
  return buttons.slice(0, 30); // Limit to 30 buttons
}

function findByLabel(text) {
  const labels = Array.from(document.querySelectorAll("label"));
  const wanted = norm(text);
  const label = labels.find(l => norm(l.innerText) === wanted);
  if (!label) return null;
  const forId = label.getAttribute("for");
  if (forId) return document.getElementById(forId);
  return label.querySelector("input, textarea, select");
}

function findByText(text, exact = false) {
  const wanted = norm(text);
  const candidates = Array.from(
    document.querySelectorAll("button, a, [role='button'], input[type='submit'], input[type='button']")
  );
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
    const elements = document.querySelectorAll("button, input[type='submit'], input[type='button'], a[role='button'], [role='button']");
    return elements[index] || null;
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

// Enhanced observe function with structured data
function observe() {
  const url = location.href;
  const title = document.title;
  const fields = extractFormFields();
  const buttons = extractButtons();
  const pageContext = (document.body?.innerText || "").slice(0, 4000); // Reduced context since we have structured fields
  
  return { 
    url, 
    title, 
    fields,
    buttons,
    pageContext,
    // Legacy field for backward compatibility
    text: pageContext
  };
}

async function execute(action) {
  try {
    // Tell overlay what we're doing
    window.postMessage({ source: "agent", type: "ACTION", action }, "*");

    // These are control actions; no DOM interaction needed.
    if (action.type === "DONE") {
      return { ok: true, note: action.summary || "done" };
    }

    if (action.type === "REQUEST_VERIFICATION") {
      return { ok: true, note: "verification requested" };
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

    if (action.type === "CHECK") {
      const el = resolveTarget(action.target);
      if (!el) return { ok: false, fatal: false, error: "CHECK target not found" };
      highlight(el);
      el.checked = action.checked !== false;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "OBSERVE") return sendResponse(observe());
    if (msg.type === "EXECUTE") {
      const result = await execute(msg.action);
      return sendResponse({ result, observation: observe() });
    }
    sendResponse({ ok: false, error: "Unknown message" });
  })();
  return true;
});
