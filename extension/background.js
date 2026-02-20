const DEFAULT_API_BASE = "https://agent.vaulty.ca";
const PROFILE_KEY = "userProfile";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Open side panel on extension icon click (no popup)
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.error("[agent] Failed to open side panel:", e);
  }
});

// Open side panel on hotkey (activate-copilot)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "activate-copilot") {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) await chrome.sidePanel.open({ tabId: tab.id });
    } catch (e) {
      console.error("[agent] Failed to open side panel:", e);
    }
  }
});

async function setJob(jobId, patch) {
  const key = `job:${jobId}`;
  const cur = (await chrome.storage.local.get([key]))[key] || {};
  await chrome.storage.local.set({ [key]: { ...cur, ...patch } });
}

async function getJob(jobId) {
  const key = `job:${jobId}`;
  const data = await chrome.storage.local.get([key]);
  return data[key] || {};
}

async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get(["apiBase"]);
  return apiBase || DEFAULT_API_BASE;
}

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
}

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" }, { frameId: 0 });
    if (res?.ok) return;
  } catch {}
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

function friendlyError(fallback, err) {
  if (err instanceof Error) {
    const msg = err.message;
    if (msg && !msg.startsWith("{") && !msg.startsWith("HTTP") && !msg.includes("<!DOCTYPE")) {
      return msg;
    }
  }
  return fallback;
}

// ============================================================
// SCREENSHOT & COPILOT
// ============================================================

async function captureScreenshot(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(200);
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
      quality: 85
    });
    if (!dataUrl) return null;
    return dataUrl.split(',')[1];
  } catch (e) {
    console.error(`[screenshot] Capture failed:`, e);
    return null;
  }
}

async function copilotSummarize(tabId) {
  const apiBase = await getApiBase();

  try {
    await ensureContentScript(tabId);
  } catch {
    throw new Error("Cannot access this page. Click the Vaulty icon or press ⌘⇧V first.");
  }

  let context = { url: "", title: "", selectedText: "", pageText: "" };
  try {
    context = await sendToTab(tabId, { type: "OBSERVE_LIGHT" });
  } catch (e) {
    console.warn("[copilot] OBSERVE_LIGHT failed, using tab info:", e);
    const tab = await chrome.tabs.get(tabId);
    context.url = tab.url || "";
    context.title = tab.title || "";
  }
  const screenshot = await captureScreenshot(tabId);
  const response = await authedFetch(`${apiBase}/api/copilot/interpret`, {
    method: "POST",
    body: JSON.stringify({
      task: "summarize",
      screenshot: screenshot || undefined,
      context: {
        url: context.url,
        title: context.title,
        selectedText: context.selectedText || undefined,
        pageText: context.pageText || undefined,
      },
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || "Could not summarize this page. Please try again.");
  }
  return response.json();
}

// ============================================================
// EXTERNAL MESSAGING - Allow external web apps to trigger agent
// ============================================================

const ALLOWED_EXTERNAL_ORIGINS = [
  "https://vaulty.ca",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173"
];

chrome.runtime.onMessageExternal.addListener(
  (request, sender, sendResponse) => {
    (async () => {
      try {
        const senderOrigin = sender.url ? new URL(sender.url).origin : null;
        const isAllowed = senderOrigin && ALLOWED_EXTERNAL_ORIGINS.some(
          allowed => senderOrigin === allowed || senderOrigin.startsWith(allowed.replace("/*", ""))
        );

        if (!isAllowed) {
          sendResponse({ ok: false, error: "Unauthorized origin" });
          return;
        }

        if (request.type === "GET_EXTENSION_STATUS") {
          sendResponse({
            ok: true,
            installed: true,
            version: chrome.runtime.getManifest().version
          });
          return;
        }

        if (request.type === "GET_JOB_STATUS") {
          const job = await getJob(request.jobId);
          sendResponse({
            ok: true,
            job: job ? {
              status: job.status,
              step: job.step,
              phase: job.applicationState?.progress?.phase,
              progress: job.applicationState?.progress?.estimatedProgress,
              error: job.error
            } : null
          });
          return;
        }

        if (request.type === "START_JOB_FROM_EXTERNAL") {
          const result = await handleExternalJobStart(request.payload, senderOrigin);
          sendResponse(result);
          return;
        }

        if (request.type === "CANCEL_JOB") {
          if (request.jobId) {
            await setJob(request.jobId, { stop: true, status: "stopping" });
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: "jobId is required" });
          }
          return;
        }

        sendResponse({ ok: false, error: "Unknown message type" });
      } catch (e) {
        console.error("[external] Error handling message:", e);
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
);

async function handleExternalJobStart(payload, source) {
  const {
    jobUrl,
    jobTitle,
    company,
    coverLetter,
    resumeId,
    customFields,
    mode = "live"
  } = payload || {};

  if (!jobUrl) {
    return { ok: false, error: "jobUrl is required" };
  }

  try {
    new URL(jobUrl);
  } catch {
    return { ok: false, error: "Invalid jobUrl format" };
  }

  const jobId = crypto.randomUUID().slice(0, 24);

  const prefilledState = {
    goal: {
      jobUrl,
      jobTitle: jobTitle || "Unknown Position",
      company: company || "Unknown Company",
      startedAt: new Date().toISOString(),
    },
    progress: {
      phase: "navigating",
      sectionsCompleted: [],
      currentSection: null,
      fieldsFilledThisPage: [],
      estimatedProgress: 0,
    },
    blockers: { type: null, description: null, attemptsMade: 0 },
    auth: {
      strategy: null,
      onAuthPage: false,
      loginAttempts: 0,
      loginErrors: [],
      signupAttempted: false,
      strategyDecidedAtStep: null,
      pivotReason: null,
    },
    memory: { successfulPatterns: [], failedPatterns: [], pagesVisited: [] },
    external: {
      coverLetter: coverLetter || null,
      resumeId: resumeId || null,
      customFields: customFields || {},
      source: source,
    },
  };

  await setJob(jobId, {
    status: "starting",
    applicationState: prefilledState,
    startUrl: jobUrl,
    externalSource: source,
    mode: mode,
  });

  return {
    ok: true,
    jobId,
    message: `Queued application for ${jobTitle || "job"} at ${company || "company"}`
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// APPLY-AGENT — Server-proxied AI form filler
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_STEPS = 20;

// Per-tab fill sessions: tabId -> { stepCount, profile }
const sessions = {};

// Cancel any in-progress fill when the tab navigates to a new page
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && sessions[tabId]) {
    delete sessions[tabId];
    notifyPanel(tabId, "idle");
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {

        case "start_fill": {
          const tabId = msg.tabId;
          const profile = await loadProfile();
          sessions[tabId] = { stepCount: 0, profile };
          sendResponse({ ok: true });
          await requestSnapshotAndFill(tabId);
          break;
        }

        case "step_ready": {
          const tabId   = sender.tab.id;
          const session = sessions[tabId];
          if (!session) return;
          session.stepCount++;
          if (session.stepCount >= MAX_STEPS) {
            notifyPanel(tabId, "done");
            delete sessions[tabId];
            return;
          }
          await processSnapshot(tabId, msg.html, session);
          break;
        }

        case "fill_complete": {
          const tabId = sender.tab.id;
          if (!sessions[tabId]) break; // stale — tab navigated away, ignore
          notifyPanel(tabId, "done");
          delete sessions[tabId];
          break;
        }

        case "COPILOT_SUMMARIZE": {
          const tabId = msg.tabId ?? sender.tab?.id;
          if (!tabId) {
            sendResponse({ ok: false, error: "No tabId" });
            return;
          }
          copilotSummarize(tabId)
            .then((result) => {
              chrome.storage.session.set({ copilotResult: result });
              sendResponse({ ok: true });
            })
            .catch((err) => {
              console.error("[copilot] Summarize failed:", err);
              const msg = friendlyError("Could not summarize this page. Please try again.", err);
              chrome.storage.session.set({
                copilotResult: { error: "copilot_failed", message: msg, type: "error" },
              });
              sendResponse({ ok: false, error: msg });
            });
          return true;
        }

        default:
          break;
      }
    } catch (err) {
      console.error("[apply-agent] Error:", err);
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;
});

// ── Core flow ─────────────────────────────────────────────────────────────────

async function requestSnapshotAndFill(tabId) {
  notifyPanel(tabId, "analyzing");

  try {
    await ensureContentScript(tabId);
  } catch (e) {
    notifyPanel(tabId, "error", "Cannot access this page. Click the Vaulty icon or press ⌘⇧V first.");
    delete sessions[tabId];
    return;
  }

  let response = null;
  for (let i = 0; i < 5; i++) {
    try {
      response = await chrome.tabs.sendMessage(tabId, { type: "get_snapshot" });
      if (response?.html) break;
    } catch (_) { /* content script not yet ready */ }
    await sleep(200);
  }

  if (!response?.html) {
    notifyPanel(tabId, "error", "Could not read page. Try refreshing.");
    delete sessions[tabId];
    return;
  }

  await processSnapshot(tabId, response.html, sessions[tabId]);
}

async function processSnapshot(tabId, html, session) {
  notifyPanel(tabId, "analyzing");

  let mapping;
  try {
    mapping = await callServer(html, session.profile);
  } catch (err) {
    notifyPanel(tabId, "error", friendlyError("Something went wrong filling this form. Please try again.", err));
    return;
  }

  if (!mapping || mapping.length === 0) {
    notifyPanel(tabId, "done");
    delete sessions[tabId];
    return;
  }

  notifyPanel(tabId, "filling");
  await chrome.tabs.sendMessage(tabId, { type: "fill_fields", mapping });
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function getAuthToken() {
  const { authToken } = await chrome.storage.local.get(["authToken"]);
  return authToken || null;
}

async function authedFetch(url, options = {}) {
  const token = await getAuthToken();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });

  if (res.status === 401) {
    const body = await res.clone().json().catch(() => ({}));
    chrome.runtime.sendMessage({ type: "AUTH_EXPIRED" }).catch(() => {});
    throw new Error(body.message || "Your session has expired. Please sign in again.");
  }

  if (res.status === 403) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.error === "subscription_required") {
      throw new Error(body.message || "A paid subscription is required. Upgrade at vaulty.ca/plans");
    }
    throw new Error(body.message || "You don't have permission to use this feature.");
  }

  if (res.status === 429) {
    const body = await res.clone().json().catch(() => ({}));
    const msg = body.message || "You've reached your daily limit. Try again tomorrow.";
    chrome.runtime.sendMessage({ type: "RATE_LIMITED", message: msg }).catch(() => {});
    throw new Error(msg);
  }

  return res;
}

// ── Server-proxied fill ──────────────────────────────────────────────────────

async function callServer(html, profile) {
  const apiBase = await getApiBase();
  const res = await authedFetch(`${apiBase}/api/agent/fill`, {
    method: "POST",
    body: JSON.stringify({ html, profile }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "Something went wrong filling this form. Please try again.");
  }
  const data = await res.json();
  return data.mapping || [];
}

// ── Profile helpers ───────────────────────────────────────────────────────────

async function loadProfile() {
  return new Promise((resolve) => {
    chrome.storage.local.get(PROFILE_KEY, (r) => resolve(r[PROFILE_KEY] || {}));
  });
}

// ── Notify sidepanel ──────────────────────────────────────────────────────────

function notifyPanel(tabId, status, message = "") {
  chrome.runtime.sendMessage({ type: "status_update", status, message, tabId })
    .catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// END APPLY-AGENT
// ═══════════════════════════════════════════════════════════════════════════════
