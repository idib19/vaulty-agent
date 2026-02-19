let mutationObserver = null;
let waitingForNextStep = false;

// ── Message router ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {

    case "OBSERVE_LIGHT": {
      sendResponse({
        url: location.href,
        title: document.title,
        selectedText: window.getSelection()?.toString() || "",
        pageText: document.body?.innerText?.slice(0, 6000) || "",
      });
      return false;
    }

    case "get_snapshot": {
      sendResponse({ html: document.documentElement.outerHTML });
      return false;
    }

    case "fill_fields": {
      (async () => {
        await fillAllFields(msg.mapping);
        const advanced = await advanceStep();
        if (!advanced) {
          chrome.runtime.sendMessage({ type: "fill_complete" });
        }
        sendResponse({ ok: true });
      })();
      return true; // async
    }

    default:
      return false;
  }
});

// ── Field filling ──────────────────────────────────────────────────────────────

async function fillAllFields(mapping) {
  for (const field of mapping) {
    await fillField(field);
    await delay(80);
  }
}

async function fillField({ selector, value, type }) {
  const el = document.querySelector(selector);
  if (!el) {
    console.warn("[apply-agent] Field not found:", selector);
    return;
  }
  el.scrollIntoView({ behavior: "instant", block: "center" });

  switch (type) {
    case "input":
    case "textarea":
      setNativeValue(el, value);
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur",   { bubbles: true }));
      break;

    case "select":
      setSelectValue(el, value);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur",   { bubbles: true }));
      break;

    case "checkbox":
    case "radio": {
      const shouldCheck = value === "true";
      if (el.checked !== shouldCheck) el.click();
      break;
    }
  }
}

// React/Vue/Angular-compatible value setter
function setNativeValue(el, value) {
  const proto = el.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (nativeSetter) nativeSetter.call(el, value);
  else el.value = value;
}

function setSelectValue(el, targetValue) {
  const lower = targetValue.toLowerCase().trim();
  for (const opt of el.options) {
    if (opt.value.toLowerCase() === lower) { el.value = opt.value; return; }
  }
  for (const opt of el.options) {
    if (opt.text.toLowerCase().includes(lower) || lower.includes(opt.text.toLowerCase())) {
      el.value = opt.value; return;
    }
  }
  console.warn("[apply-agent] No matching option for:", targetValue, el);
}

// ── Step advancement ───────────────────────────────────────────────────────────

async function advanceStep() {
  const nextBtn = findNextButton();
  if (!nextBtn) return false;
  watchForNextStep();
  await delay(200);
  nextBtn.click();
  return true;
}

function findNextButton() {
  const candidates = [...document.querySelectorAll("button, input[type=submit], input[type=button], a[role=button]")];
  const nextKw   = ["next", "continue", "suivant", "weiter", "siguiente", "proceed", "forward"];
  const submitKw = ["submit", "send", "envoyer", "senden", "enviar", "finish", "done"];

  for (const el of candidates) {
    const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").toLowerCase();
    if (nextKw.some(k => text.includes(k))) return el;
  }
  for (const el of candidates) {
    const text = (el.textContent || el.value || el.getAttribute("aria-label") || "").toLowerCase();
    if (submitKw.some(k => text.includes(k))) return el;
  }
  return document.querySelector("input[type=submit]") || null;
}

function watchForNextStep() {
  if (mutationObserver) mutationObserver.disconnect();
  waitingForNextStep = true;
  let debounceTimer = null;

  mutationObserver = new MutationObserver((mutations) => {
    if (!waitingForNextStep) return;
    const hasNewFields = mutations.some(m =>
      [...m.addedNodes].some(node =>
        node.nodeType === 1 && (
          node.matches?.("input, select, textarea, form") ||
          node.querySelector?.("input, select, textarea")
        )
      )
    );
    if (!hasNewFields) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      waitingForNextStep = false;
      mutationObserver.disconnect();
      chrome.runtime.sendMessage({ type: "step_ready", html: document.documentElement.outerHTML });
    }, 400);
  });

  mutationObserver.observe(document.body, { childList: true, subtree: true });

  // Safety timeout: if no new fields in 5 s, assume done
  setTimeout(() => {
    if (!waitingForNextStep) return;
    waitingForNextStep = false;
    mutationObserver.disconnect();
    chrome.runtime.sendMessage({ type: "fill_complete" });
  }, 5000);
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
