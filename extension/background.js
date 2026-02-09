const DEFAULT_API_BASE = "http://localhost:3000";
const PROFILE_KEY = "userProfile";
const SETTINGS_KEY = "agentSettings";
const LOGS_KEY = "agentLogs";
const DEFAULT_MAX_STEPS = 40;
const MAX_LOGS = 200; // Keep last 200 log entries

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Track pending user responses and paused state
const pendingUserResponses = new Map(); // actionId -> { resolve, reject }
let globalPaused = false;

// Track tabs opened by clicks (for following Apply buttons that open new tabs)
// Map of originalTabId -> { newTabId, timestamp }
const pendingTabSwitches = new Map();

// Track which tabs are being monitored by the agent
const activeAgentTabs = new Set();

// Track side panel open state for mini-overlay toggle
let sidePanelOpen = false;

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

// Listen for new tabs created by clicks (e.g., Apply buttons with target="_blank")
chrome.tabs.onCreated.addListener((tab) => {
  // Only care about tabs opened by one of our monitored tabs
  if (tab.openerTabId && activeAgentTabs.has(tab.openerTabId)) {
    console.log(`[agent] New tab detected: ${tab.id} opened by tab ${tab.openerTabId}`);
    pendingTabSwitches.set(tab.openerTabId, {
      newTabId: tab.id,
      timestamp: Date.now()
    });
  }
});

// Clean up old pending switches (older than 10 seconds)
function cleanupOldPendingTabSwitches() {
  const now = Date.now();
  for (const [originalTabId, info] of pendingTabSwitches.entries()) {
    if (now - info.timestamp > 10000) {
      pendingTabSwitches.delete(originalTabId);
    }
  }
}

// Logging helper
async function addLog(jobId, step, entry) {
  const data = await chrome.storage.local.get([LOGS_KEY]);
  const logs = data[LOGS_KEY] || [];
  
  logs.push({
    id: `${jobId}-${step}-${Date.now()}`,
    jobId,
    step,
    timestamp: new Date().toISOString(),
    ...entry
  });
  
  // Keep only last MAX_LOGS entries
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS);
  }
  
  await chrome.storage.local.set({ [LOGS_KEY]: logs });
}

async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get(["apiBase"]);
  return apiBase || DEFAULT_API_BASE;
}

async function getProfile() {
  const data = await chrome.storage.local.get([PROFILE_KEY]);
  return data[PROFILE_KEY] || null;
}

let behavior = { autopilotEnabled: true, capEnabled: true, maxSteps: DEFAULT_MAX_STEPS };

async function loadBehaviorSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY]);
  const settings = data[SETTINGS_KEY] || {};
  const autopilotEnabled = settings.autopilotEnabled !== false; // default true
  const capEnabled = settings.capEnabled !== false; // default true
  let maxSteps = parseInt(String(settings.maxSteps ?? DEFAULT_MAX_STEPS), 10);
  if (!Number.isFinite(maxSteps) || maxSteps < 1) maxSteps = DEFAULT_MAX_STEPS;
  behavior = { autopilotEnabled, capEnabled, maxSteps };
}

// Live-update behavior while agent is running
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes[SETTINGS_KEY]) return;
  const next = changes[SETTINGS_KEY].newValue || {};
  const autopilotEnabled = next.autopilotEnabled !== false;
  const capEnabled = next.capEnabled !== false;
  let maxSteps = parseInt(String(next.maxSteps ?? DEFAULT_MAX_STEPS), 10);
  if (!Number.isFinite(maxSteps) || maxSteps < 1) maxSteps = DEFAULT_MAX_STEPS;
  behavior = { autopilotEnabled, capEnabled, maxSteps };
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

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function sendToTab(tabId, msg) {
  // Target only the main frame (frameId: 0) to avoid iframes responding
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
}

async function createTab(url, mode) {
  const tab = await chrome.tabs.create({ url, active: mode === "live" });
  return tab.id;
}

async function bringToFront(tabId) {
  await chrome.tabs.update(tabId, { active: true });
}

function isSubmitLike(action) {
  if (!action || action.type !== "CLICK") return false;
  const t = action.target;
  if (t?.by === "text" && t.text) {
    const s = (t.text || "").toLowerCase();
    return ["submit", "apply", "confirm", "pay", "finish", "send", "complete", "place order"].some(k => s.includes(k));
  }
  if (t?.by === "intent" && t.intent) {
    const s = String(t.intent).toLowerCase();
    return ["submit", "apply", "confirm", "pay", "finish", "send", "complete", "place order"].some(k => s.includes(k));
  }
  return false;
}

function describeTarget(target) {
  if (!target) return "";
  return target.text ||
    target.selector ||
    target.label ||
    target.id ||
    target.intent ||
    (target.index !== undefined ? `index ${target.index}` : "") ||
    "";
}

function getTargetText(target, observation) {
  if (!target) return "";
  if (target.text) return target.text;
  if (target.by === "vaultyId" && observation?.candidates?.length) {
    const candidate = observation.candidates.find(c => c.vaultyId === target.id);
    return candidate?.text || candidate?.label || candidate?.ariaLabel || "";
  }
  if (target.intent) return target.intent;
  return "";
}

function looksSubmitted(observation) {
  const url = String(observation?.url || "").toLowerCase();
  const text = String(observation?.pageContext || observation?.text || "").toLowerCase();
  const hay = `${url}\n${text}`;
  return [
    // Original patterns
    "application submitted",
    "thanks for applying",
    "thank you for applying",
    "we received your application",
    "we have received your application",
    "application received",
    "submission confirmed",
    "confirmation number",
    "your application has been submitted",
    "applied successfully",
    // NEW: Additional patterns to catch more success messages
    "successfully applied",
    "you've successfully applied",
    "you have successfully applied",
    "congrats",
    "congratulations",
    "you've applied",
    "you have applied",
    "profile created",
    "application complete",
    "application is complete",
    "successfully submitted",
    "application was submitted",
    "your application is submitted",
    "application has been received",
    "we got your application",
    "application sent",
  ].some(k => hay.includes(k));
}

// ============================================================
// APPLICATION STATE MANAGEMENT
// ============================================================

// Extract job title and company from page
async function extractJobInfo(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Common selectors for job titles
        const titleSelectors = [
          'h1',
          '[class*="job-title"]',
          '[class*="jobTitle"]',
          '[class*="job_title"]',
          '[data-testid*="title"]',
          '[data-testid*="job-title"]',
          '.job-title',
          '.posting-headline h2',
          '.jobs-unified-top-card__job-title',
          '.job-details-jobs-unified-top-card__job-title',
        ];
        
        // Common selectors for company names
        const companySelectors = [
          '[class*="company-name"]',
          '[class*="companyName"]',
          '[class*="company_name"]',
          '[data-testid*="company"]',
          '.company-name',
          '.employer-name',
          '.jobs-unified-top-card__company-name',
          '.job-details-jobs-unified-top-card__company-name',
          'a[data-tracking-control-name*="company"]',
        ];
        
        let jobTitle = null;
        let company = null;
        
        // Try to find job title
        for (const sel of titleSelectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent?.trim()) {
            const text = el.textContent.trim();
            // Filter out generic text
            if (text.length > 3 && text.length < 150 && 
                !text.toLowerCase().includes('apply') &&
                !text.toLowerCase().includes('sign in')) {
              jobTitle = text.slice(0, 100);
              break;
            }
          }
        }
        
        // Try to find company name
        for (const sel of companySelectors) {
          const el = document.querySelector(sel);
          if (el && el.textContent?.trim()) {
            const text = el.textContent.trim();
            if (text.length > 1 && text.length < 100) {
              company = text.slice(0, 80);
              break;
            }
          }
        }
        
        // Fallback: extract from page title
        if (!jobTitle || !company) {
          const pageTitle = document.title;
          // Common patterns: "Job Title - Company | Site" or "Job Title at Company"
          const atMatch = pageTitle.match(/^(.+?)\s+at\s+(.+?)(?:\s*[|·-]|$)/i);
          const dashMatch = pageTitle.match(/^(.+?)\s*[-–|]\s*(.+?)(?:\s*[|·-]|$)/);
          
          if (atMatch) {
            if (!jobTitle) jobTitle = atMatch[1].trim().slice(0, 100);
            if (!company) company = atMatch[2].trim().slice(0, 80);
          } else if (dashMatch) {
            if (!jobTitle) jobTitle = dashMatch[1].trim().slice(0, 100);
            // Second part might be company or site name
            const secondPart = dashMatch[2].trim();
            if (!company && !secondPart.toLowerCase().includes('indeed') && 
                !secondPart.toLowerCase().includes('linkedin') &&
                !secondPart.toLowerCase().includes('glassdoor')) {
              company = secondPart.slice(0, 80);
            }
          }
        }
        
        return { jobTitle, company };
      }
    });
    
    return result[0]?.result || { jobTitle: null, company: null };
  } catch (e) {
    console.log("[agent] Failed to extract job info:", e);
    return { jobTitle: null, company: null };
  }
}

// Create initial application state
function createInitialApplicationState(startUrl, jobTitle, company) {
  return {
    goal: {
      jobUrl: startUrl,
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
    blockers: {
      type: null,
      description: null,
      attemptsMade: 0,
    },
    memory: {
      successfulPatterns: [],
      failedPatterns: [],
      pagesVisited: [],
    },
  };
}

// Update application state based on observation and last action
function updateApplicationState(state, observation, lastAction, lastResult) {
  if (!state) return state;
  
  const newState = JSON.parse(JSON.stringify(state)); // Deep clone
  const url = (observation?.url || "").toLowerCase();
  
  // Track page visits
  if (observation?.url && !newState.memory.pagesVisited.includes(observation.url)) {
    newState.memory.pagesVisited.push(observation.url);
  }
  
  // Reset fields filled when we navigate to a new page
  const currentUrlBase = observation?.url?.split('?')[0];
  const lastUrlBase = newState.memory.pagesVisited.length > 1 
    ? newState.memory.pagesVisited[newState.memory.pagesVisited.length - 2]?.split('?')[0]
    : null;
  
  if (currentUrlBase && lastUrlBase && currentUrlBase !== lastUrlBase) {
    newState.progress.fieldsFilledThisPage = [];
  }
  
  // Detect phase from URL and page content
  if (url.includes('login') || url.includes('signin') || url.includes('sign-in') || url.includes('authenticate')) {
    newState.progress.phase = 'logging_in';
  } else if (url.includes('apply') || url.includes('application') || url.includes('career') || url.includes('jobs')) {
    newState.progress.phase = 'filling_form';
  } else if (url.includes('review') || url.includes('confirm') || url.includes('preview')) {
    newState.progress.phase = 'reviewing';
  } else if (url.includes('thank') || url.includes('success') || url.includes('submitted') || url.includes('complete')) {
    newState.progress.phase = 'completed';
  }
  
  // Track filled fields
  if (lastAction?.type === 'FILL' && lastResult?.ok) {
    const fieldId = describeTarget(lastAction.target) || null;
    if (fieldId && !newState.progress.fieldsFilledThisPage.includes(fieldId)) {
      newState.progress.fieldsFilledThisPage.push(fieldId);
    }
  }
  
  // Track success/failure patterns
  if (lastAction && lastResult) {
    const targetDesc = describeTarget(lastAction.target);
    const pattern = `${lastAction.type} on "${targetDesc}"`;
    
    if (lastResult.ok) {
      if (!newState.memory.successfulPatterns.includes(pattern)) {
        newState.memory.successfulPatterns.push(pattern);
        // Keep only last 20 successful patterns
        if (newState.memory.successfulPatterns.length > 20) {
          newState.memory.successfulPatterns.shift();
        }
      }
      // Remove from failed patterns if it succeeded now
      const failIndex = newState.memory.failedPatterns.indexOf(pattern);
      if (failIndex > -1) {
        newState.memory.failedPatterns.splice(failIndex, 1);
      }
    } else {
      if (!newState.memory.failedPatterns.includes(pattern)) {
        newState.memory.failedPatterns.push(pattern);
        // Keep only last 10 failed patterns
        if (newState.memory.failedPatterns.length > 10) {
          newState.memory.failedPatterns.shift();
        }
      }
    }
  }
  
  // Detect blockers from observation
  if (observation?.specialElements?.hasCaptcha) {
    newState.blockers.type = 'captcha';
    newState.blockers.description = 'CAPTCHA detected on page';
    newState.blockers.attemptsMade = (state.blockers?.type === 'captcha' ? state.blockers.attemptsMade : 0) + 1;
  } else if (observation?.specialElements?.hasFileUpload) {
    newState.blockers.type = 'file_upload';
    newState.blockers.description = 'File upload required';
  } else {
    // Clear blocker if resolved
    newState.blockers.type = null;
    newState.blockers.description = null;
    newState.blockers.attemptsMade = 0;
  }
  
  // Estimate progress (rough heuristic)
  const phasesOrder = ['navigating', 'logging_in', 'filling_form', 'reviewing', 'submitting', 'completed'];
  const phaseIndex = phasesOrder.indexOf(newState.progress.phase);
  const phaseProgress = Math.round((phaseIndex / (phasesOrder.length - 1)) * 60); // Phases = 0-60%
  const fieldsProgress = Math.min(40, newState.progress.fieldsFilledThisPage.length * 5); // Fields = 0-40%
  newState.progress.estimatedProgress = Math.min(100, phaseProgress + fieldsProgress);
  
  return newState;
}

// Wait for user response to ASK_USER action
function waitForUserResponse(actionId, timeoutMs = 300000) { // 5 minute timeout
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingUserResponses.delete(actionId);
      resolve({ skipped: true, reason: "timeout" });
    }, timeoutMs);

    pendingUserResponses.set(actionId, {
      resolve: (response) => {
        clearTimeout(timeoutId);
        pendingUserResponses.delete(actionId);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        pendingUserResponses.delete(actionId);
        reject(error);
      }
    });
  });
}

// Find alternative elements that might be better targets (e.g., modal buttons vs nav buttons)
function findAlternativeElements(observation, clickedText, clickedIndex) {
  if (!observation?.buttons) return [];
  
  const alternatives = [];
  const searchText = (clickedText || "").toLowerCase();
  
  for (const button of observation.buttons) {
    const buttonText = (button.text || "").toLowerCase();
    
    // Skip the exact same button we already clicked
    if (button.index === clickedIndex) continue;
    
    // Look for buttons with similar text
    const isSimilarText = searchText && (
      buttonText.includes(searchText) || 
      searchText.includes(buttonText) ||
      // Common variations
      (searchText.includes("sign") && buttonText.includes("sign")) ||
      (searchText.includes("login") && buttonText.includes("login")) ||
      (searchText.includes("log in") && buttonText.includes("log in")) ||
      (searchText.includes("apply") && buttonText.includes("apply")) ||
      (searchText.includes("submit") && buttonText.includes("submit"))
    );
    
    if (isSimilarText) {
      alternatives.push({
        index: button.index,
        text: button.text,
        context: button.context || "PAGE",
        // Prioritize MODAL context over NAV
        priority: button.context === "MODAL" ? 1 : (button.context === "MAIN" ? 2 : (button.context === "NAV" ? 4 : 3))
      });
    }
  }
  
  // Sort by priority (MODAL first, then MAIN, then others, NAV last)
  alternatives.sort((a, b) => a.priority - b.priority);
  
  // Return top 3 alternatives
  return alternatives.slice(0, 3);
}

// Detect if the agent is stuck in a loop (semantic or technical)
function detectLoop(actionHistory, currentObservation) {
  console.log(`[loop-detection] Checking action history (${actionHistory.length} entries)`);
  
  if (actionHistory.length < 3) {
    console.log(`[loop-detection] Not enough history (need at least 3 actions)`);
    return null;
  }
  
  const recent = actionHistory.slice(-5); // Last 5 actions for better detection
  
  // === CHECK 1: Traditional failed actions ===
  const failed = recent.filter(h => h.result?.ok === false);
  
  console.log(`[loop-detection] Recent actions: ${recent.length}, Failed: ${failed.length}`);
  
  // If 2+ of the last 5 actions failed technically
  if (failed.length >= 2) {
    // Check if they're all the same type of action
    const types = failed.map(f => f.action.type);
    const allSameType = types.every(t => t === types[0]);
    
    console.log(`[loop-detection] All same type? ${allSameType} (types: ${types.join(", ")})`);
    
    // Also check if the target is similar (for CLICK/FILL actions)
    let targetsSimilar = true;
    if (failed[0].action.target) {
      const targets = failed.map(f => describeTarget(f.action.target));
      targetsSimilar = targets.every(t => t === targets[0]);
      console.log(`[loop-detection] Targets similar? ${targetsSimilar} (targets: ${targets.join(", ")})`);
    }
    
    if (allSameType && targetsSimilar) {
      const failedAction = failed[0].action;
      const targetDesc = describeTarget(failedAction.target) || "unknown";
      
      console.log(`[loop-detection] ✅ LOOP DETECTED: ${failedAction.type} "${targetDesc}" failed ${failed.length} times`);
      
      return {
        isLoop: true,
        failedAction: failedAction,
        failCount: failed.length,
        error: failed[0].result?.error,
        targetDescription: targetDesc
      };
    } else {
      console.log(`[loop-detection] ❌ Not a technical loop (different types or targets)`);
    }
  }
  
  // === CHECK 2: SEMANTIC LOOP - actions succeed but no progress ===
  // Detect when we're clicking the same things over and over on the same page
  const recentForSemantic = actionHistory.slice(-4); // Last 4 actions
  if (recentForSemantic.length >= 4 && currentObservation) {
    // Check if all recent actions are on the same URL (no navigation happening)
    const urls = recentForSemantic.map(h => h.url).filter(Boolean);
    const currentUrl = currentObservation.url;
    
    // Normalize URLs for comparison (remove query params that change)
    const normalizeUrl = (url) => {
      try {
        const u = new URL(url);
        // Keep path, remove some dynamic query params
        return u.origin + u.pathname;
      } catch {
        return url;
      }
    };
    
    const normalizedCurrent = normalizeUrl(currentUrl);
    const allOnSamePage = urls.length >= 3 && urls.every(u => normalizeUrl(u) === normalizedCurrent);
    
    // Check if we're repeating similar action types
    const actionTypes = recentForSemantic.map(h => h.action?.type);
    const allClicks = actionTypes.every(t => t === 'CLICK');
    
    // Check if we're clicking similar targets
    const targets = recentForSemantic.map(h => {
      const t = h.action?.target;
      return t?.text || t?.index?.toString() || '';
    });
    const uniqueTargets = [...new Set(targets)];
    const limitedTargetVariety = uniqueTargets.length <= 2; // Only 1-2 different targets
    
    console.log(`[loop-detection] Semantic check: samePage=${allOnSamePage}, allClicks=${allClicks}, limitedTargets=${limitedTargetVariety}`);
    
    if (allOnSamePage && allClicks && limitedTargetVariety) {
      const lastAction = recentForSemantic[recentForSemantic.length - 1].action;
      const targetDesc = describeTarget(lastAction?.target) || "unknown";
      const clickedIndex = lastAction?.target?.index;
      const clickedText = getTargetText(lastAction?.target, currentObservation).toLowerCase();
      
      console.log(`[loop-detection] ✅ SEMANTIC LOOP DETECTED: Stuck clicking on same page without progress`);
      
      // Find alternative elements with similar text but different index/context
      const alternatives = findAlternativeElements(currentObservation, clickedText, clickedIndex);
      
      return {
        isLoop: true,
        loopType: 'semantic',
        failedAction: lastAction,
        failCount: recentForSemantic.length,
        error: 'Agent stuck - clicking repeatedly without making progress',
        targetDescription: `repeated clicks on: ${uniqueTargets.join(', ')}`,
        suggestedAlternatives: alternatives
      };
    }
  }
  
  // === CHECK 3: FILL LOOP - repeatedly filling the same field ===
  // Detect when we're filling the same field over and over (e.g., password field with validation errors)
  const recentForFill = actionHistory.slice(-5); // Last 5 actions
  if (recentForFill.length >= 3) {
    const fillActions = recentForFill.filter(h => h.action?.type === 'FILL');
    
    if (fillActions.length >= 3) {
      // Check if all FILL actions target the same field
      const fillTargets = fillActions.map(h => describeTarget(h.action?.target));
      const uniqueFillTargets = [...new Set(fillTargets)];
      
      console.log(`[loop-detection] Fill check: ${fillActions.length} FILL actions, targets: ${uniqueFillTargets.join(', ')}`);
      
      // If 3+ FILLs on the same target
      if (uniqueFillTargets.length === 1 && uniqueFillTargets[0] !== '') {
        const lastFill = fillActions[fillActions.length - 1].action;
        const targetDesc = describeTarget(lastFill?.target) || "unknown";
        
        console.log(`[loop-detection] ✅ FILL LOOP DETECTED: Repeatedly filling "${targetDesc}" (${fillActions.length} times)`);
        
        return {
          isLoop: true,
          loopType: 'fill',
          failedAction: lastFill,
          failCount: fillActions.length,
          error: 'Agent stuck - repeatedly filling the same field without progress (possible validation error)',
          targetDescription: `repeated fills on: ${targetDesc}`
        };
      }
    }
  }
  
  console.log(`[loop-detection] ❌ No loop detected`);
  return null;
}

// Capture screenshot of the visible tab
async function captureScreenshot(tabId) {
  console.log(`[screenshot] Starting screenshot capture for tab ${tabId}`);
  try {
    // First, make sure the tab is active
    const tab = await chrome.tabs.get(tabId);
    console.log(`[screenshot] Tab status: active=${tab.active}, url=${tab.url}`);
    
    if (!tab.active) {
      console.log(`[screenshot] Tab not active, bringing to front...`);
      await chrome.tabs.update(tabId, { active: true });
      await sleep(200); // Wait for tab to become active
      console.log(`[screenshot] Tab should now be active`);
    }
    
    // Capture as base64 PNG
    console.log(`[screenshot] Capturing visible tab (windowId: ${tab.windowId})...`);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
      quality: 85
    });
    
    if (!dataUrl) {
      console.error(`[screenshot] ❌ captureVisibleTab returned null/undefined`);
      return null;
    }
    
    // Return base64 without the data:image/png;base64, prefix
    const base64 = dataUrl.split(',')[1];
    const sizeKB = Math.round((base64.length * 3) / 4 / 1024);
    console.log(`[screenshot] ✅ Screenshot captured successfully (${sizeKB} KB)`);
    
    return base64;
  } catch (e) {
    console.error(`[screenshot] ❌ Screenshot capture failed:`, e);
    console.error(`[screenshot] Error details:`, {
      message: e.message,
      stack: e.stack,
      tabId
    });
    return null;
  }
}

async function copilotSummarize(tabId) {
  const apiBase = await getApiBase();
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
  const response = await fetch(`${apiBase}/api/copilot/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    const err = await response.text();
    throw new Error(`Copilot API error: ${response.status} ${err}`);
  }
  return response.json();
}

// Create ASK_USER action for loop situation
function createLoopAskUserAction(loopInfo) {
  const actionType = loopInfo.failedAction.type;
  const target = loopInfo.targetDescription;
  const error = loopInfo.error || "target not found";
  
  return {
    type: "ASK_USER",
    question: `I've tried to ${actionType.toLowerCase()} "${target}" ${loopInfo.failCount} times but keep failing (${error}). The element might not exist, have a different name, or be inside a popup/iframe.`,
    options: [
      { id: "screenshot", label: "Take a screenshot and analyze visually" },
      { id: "skip", label: "Skip this action and try something else" },
      { id: "manual", label: "Let me handle this manually" }
    ],
    allowCustom: true,
    context: {
      isLoopRecovery: true,
      originalAction: loopInfo.failedAction,
      failCount: loopInfo.failCount
    }
  };
}

async function agentLoop({ jobId, startUrl, mode }) {
  let tabId;
  
  // Check if we're resuming an existing job
  const existingJob = await getJob(jobId);
  if (existingJob.tabId && (startUrl === "about:blank" || !startUrl)) {
    tabId = existingJob.tabId;
    // Restore startUrl from existing job if not provided
    startUrl = existingJob.startUrl || startUrl;
  } else {
    tabId = await createTab(startUrl, mode);
  }
  
  let step = existingJob.step || 0;
  let consecutiveExtracts = 0;

  // Track action history for context
  let actionHistory = existingJob.actionHistory || [];

  // Store startUrl in job state so it persists across restarts
  await setJob(jobId, { 
    status: "running", 
    step, 
    tabId, 
    mode, 
    approved: false, 
    stop: false, 
    actionHistory,
    startUrl,  // Persist the URL for continue/resume
    currentPlan: existingJob.currentPlan || null // Multi-step plan for form filling
  });

  // Register this tab for new tab detection (Apply buttons opening new tabs)
  activeAgentTabs.add(tabId);
  console.log(`[agent] Registered tab ${tabId} for new tab detection`);

  // Load behavior settings (cap / maxSteps)
  await loadBehaviorSettings();

  // Get user profile for the LLM
  const profile = await getProfile();
  if (profile) {
    console.log("[agent] Using profile:", profile.firstName, profile.lastName);
  } else {
    console.log("[agent] No profile configured - LLM will use stub rules");
  }

  // ============================================================
  // GOAL STATE INITIALIZATION
  // ============================================================
  let applicationState = existingJob.applicationState;
  
  if (!applicationState) {
    // Wait for initial page to load before extracting job info
    await sleep(1500);
    
    console.log("[agent] Extracting job information from page...");
    const jobInfo = await extractJobInfo(tabId);
    
    applicationState = createInitialApplicationState(
      startUrl,
      jobInfo.jobTitle,
      jobInfo.company
    );
    
    console.log(`[agent] 🎯 GOAL: Apply to "${applicationState.goal.jobTitle}" at "${applicationState.goal.company}"`);
    
    // Persist initial state
    await setJob(jobId, { applicationState });
  } else {
    console.log(`[agent] 🎯 Resuming: "${applicationState.goal.jobTitle}" at "${applicationState.goal.company}"`);
    console.log(`[agent] Progress: ${applicationState.progress.estimatedProgress}% (phase: ${applicationState.progress.phase})`);
  }
  
  // Track last action/result for state updates
  let lastAction = null;
  let lastResult = null;
  
  // Track previous URL for detecting page changes (redirects)
  let previousUrl = null;

  try {
  while (true) {
    // Check for global pause
    while (globalPaused) {
      await sleep(500);
      const job = await getJob(jobId);
      if (job.stop) break;
    }

    const job = await getJob(jobId);
    if (job.stop) {
      await setJob(jobId, { status: "stopped" });
      return;
    }

    step += 1;
    await setJob(jobId, { step });
    
    console.log(`[agent] ═══════════════ STEP ${step} START ═══════════════`);

    // Hard safety cap (independent of planner/LLM)
    if (behavior.capEnabled && step >= behavior.maxSteps) {
      const doneAction = { type: "DONE", summary: `Stopped after ${behavior.maxSteps} steps (safety cap).` };
      await addLog(jobId, step, {
        type: "cap_reached",
        action: doneAction,
        message: `Safety cap reached at ${behavior.maxSteps} steps`
      });
      try {
        await sendToTab(tabId, { type: "EXECUTE", action: doneAction });
      } catch {}
      await setJob(jobId, { status: "done", result: { action: doneAction } });
      return;
    }

    // Observe
    let observation;
    try {
      observation = await sendToTab(tabId, { type: "OBSERVE" });
    } catch (e) {
      // content script not ready yet, or tab closed
      console.log("[agent] Observe failed, waiting...", e);
      await sleep(500);
      
      // Check if tab still exists
      try {
        await chrome.tabs.get(tabId);
      } catch {
        console.log("[agent] Tab closed, stopping");
        await addLog(jobId, step, {
          type: "error",
          message: "Tab was closed"
        });
        await setJob(jobId, { status: "error", error: "Tab was closed" });
        return;
      }
      continue;
    }

    // ============================================================
    // UPDATE APPLICATION STATE
    // ============================================================
    applicationState = updateApplicationState(applicationState, observation, lastAction, lastResult);
    await setJob(jobId, { applicationState });
    
    // ============================================================
    // DETECT URL CHANGES AND PREPARE FOR INITIAL VISION CHECK
    // ============================================================
    // Normalize URLs for comparison (remove query params and fragments to avoid false positives)
    // We want to detect actual page changes, not SPA route changes
    function normalizeUrl(url) {
      if (!url) return null;
      try {
        const urlObj = new URL(url);
        // Compare origin + pathname (ignore query params, hash, etc.)
        return `${urlObj.origin}${urlObj.pathname}`;
      } catch {
        // If URL parsing fails, use as-is
        return url.split('?')[0].split('#')[0];
      }
    }
    
    const currentUrl = observation?.url || null;
    const normalizedCurrentUrl = normalizeUrl(currentUrl);
    const normalizedPreviousUrl = normalizeUrl(previousUrl);
    
    // URL changed if normalized URLs differ (actual page change/redirect)
    const urlChanged = previousUrl !== null && 
                       currentUrl !== null && 
                       normalizedCurrentUrl !== normalizedPreviousUrl;
    
    if (urlChanged) {
      console.log(`[agent] 🔄 URL changed (redirect detected): ${previousUrl} → ${currentUrl}`);
    }
    
    // Update previous URL for next iteration
    previousUrl = currentUrl;
    
    // Send state update to HUD for progress display
    try {
      await sendToTab(tabId, { 
        type: "STATE_UPDATE", 
        state: applicationState 
      });
    } catch (e) {
      // Ignore errors - HUD might not be ready
    }
    
    // Log progress periodically
    if (step % 5 === 0) {
      console.log(`[agent] 📊 Progress: ${applicationState.progress.estimatedProgress}% | Phase: ${applicationState.progress.phase} | Fields filled: ${applicationState.progress.fieldsFilledThisPage.length}`);
    }
    
    // ============================================================
    // PROACTIVE SUCCESS CHECK - Stop immediately if submission detected
    // ============================================================
    if (looksSubmitted(observation)) {
      console.log("[agent] ✅ SUCCESS DETECTED - Application submitted! Stopping agent.");
      
      // Update state to completed
      applicationState.progress.phase = "completed";
      applicationState.progress.estimatedProgress = 100;
      await setJob(jobId, { applicationState });
      
      const doneAction = { 
        type: "DONE", 
        summary: `Successfully applied to ${applicationState.goal.jobTitle} at ${applicationState.goal.company}!` 
      };
      
      await addLog(jobId, step, { 
        type: "done", 
        action: doneAction, 
        url: observation?.url, 
        message: "Application submitted successfully (auto-detected)" 
      });
      
      try {
        await sendToTab(tabId, { 
          type: "EXECUTE", 
          action: doneAction, 
          thinking: `🎉 Success! Your application to ${applicationState.goal.jobTitle} at ${applicationState.goal.company} has been submitted!`, 
          confidence: 1.0 
        });
      } catch {}
      
      await setJob(jobId, { status: "done", result: { action: doneAction } });
      return;
    }

    // ============================================================
    // OTP DETECTION - Auto-fetch OTP code from Vaulty API
    // ============================================================
    if (observation?.specialElements?.hasOtpField) {
      console.log(`[agent] 🔐 OTP fields detected (${observation.specialElements.otpFieldCount} fields)`);
      
      // Get user's proxy email from profile (format: user@mailbox.vaulty.ca)
      // The profile.email IS the Vaulty proxy email
      const proxyEmail = profile?.email;
      
      // Validate email format
      if (proxyEmail && proxyEmail.endsWith("@mailbox.vaulty.ca")) {
        console.log(`[agent] 📧 Fetching OTP for proxy email: ${proxyEmail}`);
        
        try {
          const apiBase = await getApiBase();
          const otpResponse = await postJSON(`${apiBase}/api/agent/otp`, {
            email: proxyEmail,  // This should be the Vaulty proxy email
            jobId: jobId,
            kind: "otp",        // Fetch OTP artifact
            consume: true,      // Mark as consumed after fetching
            waitMs: 10000       // Wait up to 10 seconds for OTP to arrive
          });
          
          if (otpResponse.ok && otpResponse.code) {
            console.log(`[agent] ✅ OTP received (${otpResponse.code.length} digits)`);
            
            // Find OTP input fields from observation
            const otpFields = observation.fields.filter(f => {
              const maxLen = f.maxlength;
              const inputMode = f.inputmode;
              // OTP fields are typically single-digit inputs
              return maxLen === 1 || maxLen === "1" || 
                     (inputMode === "numeric" && (f.type === "text" || f.type === "tel"));
            });
            
            if (otpFields.length > 0) {
              // Fill OTP fields one digit at a time
              const digits = otpResponse.code.split("");
              
              for (let i = 0; i < Math.min(digits.length, otpFields.length); i++) {
                const fillAction = {
                  type: "FILL",
                  target: { by: "index", index: otpFields[i].index, elementType: "field" },
                  value: digits[i]
                };
                
                console.log(`[agent] 📝 Filling OTP digit ${i + 1}: field index ${otpFields[i].index}`);
                
                try {
                  await sendToTab(tabId, { 
                    type: "EXECUTE", 
                    action: fillAction,
                    thinking: `Entering OTP digit ${i + 1} of ${digits.length}`,
                    confidence: 0.95
                  });
                  await sleep(100); // Small delay between digits
                } catch (fillError) {
                  console.error(`[agent] Failed to fill OTP digit ${i + 1}:`, fillError);
                }
              }
              
              // Log OTP fill success
              await addLog(jobId, step, {
                type: "otp_filled",
                message: `Auto-filled ${Math.min(digits.length, otpFields.length)} OTP digits`,
                url: observation.url
              });
              
              // Update action history
              actionHistory.push({
                step,
                action: { type: "FILL", target: { text: "OTP fields" }, value: "***" },
                result: { ok: true },
                url: observation.url
              });
              
              // Continue to next iteration to verify OTP
              step++;
              continue;
            }
          } else {
            console.log(`[agent] ⚠️ OTP API failed:`, otpResponse.error || "No code returned");
            // Fall through to ASK_USER below
          }
        } catch (otpError) {
          console.error(`[agent] ❌ OTP fetch error:`, otpError);
          // Fall through to ASK_USER below
        }
        
        // If OTP API failed, ask user for the code
        console.log(`[agent] 🙋 Falling back to ASK_USER for OTP`);
        const askUserAction = {
          type: "ASK_USER",
          question: "I need the verification code (OTP) sent to your email/phone. Please enter the code:",
          options: [
            { id: "stop", label: "Stop and let me handle it" }
          ],
          allowCustom: true
        };
        
        await sendToTab(tabId, {
          type: "EXECUTE",
          action: askUserAction,
          thinking: "OTP verification required - I couldn't automatically retrieve the code.",
          confidence: 0.8
        });
        
        // Wait for user response
        const actionId = `otp_${Date.now()}`;
        const userResponse = await waitForUserResponse(actionId);
        
        if (userResponse && userResponse.customResponse) {
          // User provided the OTP code manually
          const manualCode = userResponse.customResponse.replace(/\D/g, ""); // Extract digits only
          
          // Find and fill OTP fields with manual code
          const otpFields = observation.fields.filter(f => {
            const maxLen = f.maxlength;
            return maxLen === 1 || maxLen === "1";
          });
          
          for (let i = 0; i < Math.min(manualCode.length, otpFields.length); i++) {
            const fillAction = {
              type: "FILL",
              target: { by: "index", index: otpFields[i].index, elementType: "field" },
              value: manualCode[i]
            };
            
            try {
              await sendToTab(tabId, { type: "EXECUTE", action: fillAction });
              await sleep(100);
            } catch {}
          }
          
          step++;
          continue;
        } else if (userResponse?.selectedOptionId === "stop") {
          // User wants to stop
          await setJob(jobId, { status: "paused", pending: "user_requested_stop" });
          return;
        }
      } else {
        // Email is not in Vaulty proxy format - can't auto-fetch OTP
        console.log(`[agent] ⚠️ Email ${proxyEmail || "(not set)"} is not a Vaulty proxy email - cannot auto-fetch OTP`);
        
        // Ask user for the OTP code directly
        const askUserAction = {
          type: "ASK_USER",
          question: "I need the verification code (OTP) sent to your email/phone. Please enter the code:",
          options: [
            { id: "stop", label: "Stop and let me handle it" }
          ],
          allowCustom: true
        };
        
        await sendToTab(tabId, {
          type: "EXECUTE",
          action: askUserAction,
          thinking: "OTP verification required. Please check your email/phone for the code.",
          confidence: 0.8
        });
        
        // Wait for user response
        const actionId = `otp_manual_${Date.now()}`;
        const userResponse = await waitForUserResponse(actionId);
        
        if (userResponse && userResponse.customResponse) {
          const manualCode = userResponse.customResponse.replace(/\D/g, "");
          
          const otpFields = observation.fields.filter(f => {
            const maxLen = f.maxlength;
            return maxLen === 1 || maxLen === "1";
          });
          
          for (let i = 0; i < Math.min(manualCode.length, otpFields.length); i++) {
            const fillAction = {
              type: "FILL",
              target: { by: "index", index: otpFields[i].index, elementType: "field" },
              value: manualCode[i]
            };
            try {
              await sendToTab(tabId, { type: "EXECUTE", action: fillAction });
              await sleep(100);
            } catch {}
          }
          
          step++;
          continue;
        } else if (userResponse?.selectedOptionId === "stop") {
          await setJob(jobId, { status: "paused", pending: "user_requested_stop" });
          return;
        }
      }
    }

    // ============================================================
    // MULTI-STEP PLAN EXECUTION (Phase 2)
    // Check if we have an existing plan with remaining steps
    // ============================================================
    const apiBase = await getApiBase();
    let currentPlan = job.currentPlan;
    let plannerResponse;
    let usingExistingPlan = false;
    
    // Check if we should use existing plan or request a new one
    // Guard: Only check plan if it exists AND has a valid startUrl
    if (currentPlan && currentPlan.plan && currentPlan.plan.length > 0 && currentPlan.startUrl && observation.url) {
      try {
        const planStepIndex = currentPlan.currentStepIndex || 0;
        const remainingSteps = currentPlan.plan.length - planStepIndex;
        
        // Validate plan is still applicable (same base URL)
        const planUrl = new URL(currentPlan.startUrl);
        const currentUrl = new URL(observation.url);
        const sameBasePage = planUrl.origin === currentUrl.origin && planUrl.pathname === currentUrl.pathname;
        
        // Check if any form errors appeared (need to re-plan)
        const hasErrors = observation.fields?.some(f => f.hasError);
        
        if (sameBasePage && remainingSteps > 0 && !hasErrors) {
          // Use existing plan - execute next step WITHOUT LLM call
          const nextStep = currentPlan.plan[planStepIndex];
          console.log(`[agent] 📋 Using existing plan: Step ${planStepIndex + 1}/${currentPlan.plan.length} → ${nextStep.action.type} "${nextStep.fieldName}"`);
          
          plannerResponse = {
            action: nextStep.action,
            thinking: `Plan step ${planStepIndex + 1}/${currentPlan.plan.length}: ${nextStep.expectedResult}`,
            confidence: currentPlan.confidence,
            fieldName: nextStep.fieldName // For HUD display
          };
          usingExistingPlan = true;
          
          // Don't increment plan index here - we'll do it after successful execution
        } else {
          // Invalidate plan - URL changed or errors appeared
          if (!sameBasePage) {
            console.log(`[agent] 📋 Plan invalidated: URL changed from ${currentPlan.startUrl} to ${observation.url}`);
          } else if (hasErrors) {
            console.log(`[agent] 📋 Plan invalidated: Form validation errors detected`);
          } else {
            console.log(`[agent] 📋 Plan completed: No remaining steps`);
          }
          currentPlan = null;
          await setJob(jobId, { currentPlan: null });
        }
      } catch (urlError) {
        // URL parsing failed - invalidate plan and continue
        console.log(`[agent] ⚠️ Plan URL parsing failed: ${urlError.message}. Invalidating plan.`);
        currentPlan = null;
        await setJob(jobId, { currentPlan: null });
      }
    }
    
    // If not using existing plan, check if we should request a new plan
    // Request plan when: form has 3+ empty fields AND we're past initial vision steps
    const emptyRequiredFields = observation.fields?.filter(f => 
      !f.disabled && 
      !f.readonly && 
      f.type !== "hidden" && 
      f.type !== "file" &&
      (!f.value || f.value.trim() === "") &&
      f.required
    ) || [];
    
    const shouldRequestPlan = !usingExistingPlan && 
                              !currentPlan && 
                              emptyRequiredFields.length >= 3 &&
                              step > 2; // After initial vision steps
    
    if (shouldRequestPlan) {
      console.log(`[agent] 📋 Requesting multi-step plan (${emptyRequiredFields.length} empty required fields)`);
    }
    
    // ============================================================
    // INITIAL VISION BOOTSTRAP
    // Purpose: 
    //   - First 2 steps: Lock onto target job on the job board (e.g., ZipRecruiter, Indeed)
    //   - Every URL change: Handle redirects to new pages (e.g., company ATS, login pages)
    // ============================================================
    
    // Only call planner if not using existing plan
    if (!usingExistingPlan) {
      try {
        const INITIAL_VISION_STEPS = 2; // Do vision for first 2 steps
        const initialVisionStep = job.initialVisionStep || 0;
        const initialVisionUrls = job.initialVisionUrls || []; // Track URLs that have had initial vision
        
        // Unified check: trigger initial vision if we haven't done it for this context yet
        // Context is either: (1) step number (for first 2 steps) or (2) normalized URL (for redirects)
        const isFirstTwoSteps = step <= INITIAL_VISION_STEPS;
        const needsVisionForStep = isFirstTwoSteps && initialVisionStep < step;
        const needsVisionForUrl = urlChanged && normalizedCurrentUrl && !initialVisionUrls.includes(normalizedCurrentUrl);
        
        const shouldInitialVision = needsVisionForStep || needsVisionForUrl;

        if (shouldInitialVision) {
          // Determine reason for logging
          let reason;
          if (needsVisionForStep && needsVisionForUrl) {
            reason = `step ${step}/${INITIAL_VISION_STEPS} + URL change`;
          } else if (needsVisionForStep) {
            reason = `step ${step}/${INITIAL_VISION_STEPS}`;
          } else {
            reason = `URL change (redirect to ${normalizedCurrentUrl})`;
          }
          
          console.log(`[agent] 👁️ Initial vision bootstrap (${reason}) to ensure we're on the right path...`);
          const screenshot = await captureScreenshot(tabId);

          if (screenshot) {
            plannerResponse = await postJSON(`${apiBase}/api/agent/next`, {
              jobId,
              step,
              mode,
              observation,
              profile,
            actionHistory: actionHistory.slice(-10), // Rich conversation history
            applicationState,
            screenshot: screenshot,
            initialVision: true
          });
          } else {
            console.log(`[agent] ⚠️ Initial vision screenshot failed; falling back to text planner`);
            plannerResponse = await postJSON(`${apiBase}/api/agent/next`, {
              jobId,
              step,
              mode,
              observation,
              profile,
              actionHistory: actionHistory.slice(-10), // Rich conversation history
              applicationState
            });
          }

          // Update tracking: mark this step/URL as having had initial vision
          const updates = {};
          if (needsVisionForStep) {
            updates.initialVisionStep = step;
          }
          if (needsVisionForUrl && normalizedCurrentUrl) {
            updates.initialVisionUrls = [...initialVisionUrls, normalizedCurrentUrl];
          }
          if (Object.keys(updates).length > 0) {
            await setJob(jobId, updates);
          }
        } else {
          // Normal planner call with goal context (or planning request)
          
          // For planning requests, capture a screenshot for vision-enhanced analysis
          let planScreenshot = null;
          if (shouldRequestPlan) {
            console.log(`[agent] 📋 Requesting vision-enhanced plan (${emptyRequiredFields.length} fields)...`);
            planScreenshot = await captureScreenshot(tabId);
            if (planScreenshot) {
              const screenshotSizeKB = Math.round((planScreenshot.length * 3) / 4 / 1024);
              console.log(`[agent] 📸 Plan screenshot captured (${screenshotSizeKB} KB)`);
            } else {
              console.log(`[agent] ⚠️ Plan screenshot failed, using text-only planning`);
            }
          }
          
          plannerResponse = await postJSON(`${apiBase}/api/agent/next`, {
            jobId,
            step,
            mode,
            observation,
            profile,
            actionHistory: actionHistory.slice(-10), // Rich conversation history
            applicationState,
            requestPlan: shouldRequestPlan, // Request multi-step plan when appropriate
            screenshot: planScreenshot // Include screenshot for vision-enhanced planning
          });
          
          // If we got a plan back, store it for future steps
          if (plannerResponse.plan && plannerResponse.plan.plan && plannerResponse.plan.plan.length > 0) {
            console.log(`[agent] 📋 Received new plan with ${plannerResponse.plan.plan.length} steps`);
            currentPlan = plannerResponse.plan;
            await setJob(jobId, { currentPlan });
          }
        }
      } catch (e) {
        console.error("[agent] Planner call failed:", e);
        await addLog(jobId, step, {
          type: "error",
          url: observation?.url,
          observation: {
            url: observation?.url,
            title: observation?.title,
            fieldsCount: observation?.fields?.length || 0,
            buttonsCount: observation?.buttons?.length || 0,
          },
          error: String(e),
          message: "Planner API call failed"
        });
        await setJob(jobId, { status: "error", error: String(e) });
        return;
      }
    }

    let action = plannerResponse.action;
    let thinking = plannerResponse.thinking || "";
    let confidence = plannerResponse.confidence ?? 0.7;
    let fieldName = plannerResponse.fieldName || null; // For HUD display
    let screenshot = null;
    let loopDetected = false;
    
    // Check for loop BEFORE executing the action (pass observation for semantic detection)
    const loopInfo = detectLoop(actionHistory, observation);
    if (loopInfo) {
      console.log(`[vision-flow] 🚨 LOOP DETECTED: ${loopInfo.failedAction.type} "${loopInfo.targetDescription}" failed ${loopInfo.failCount} times`);
      console.log(`[vision-flow] Error: ${loopInfo.error}`);
      loopDetected = true;
      
      await addLog(jobId, step, {
        type: "loop_detected",
        loopInfo: loopInfo,
        message: `Loop detected: ${loopInfo.failedAction.type} "${loopInfo.targetDescription}" failed ${loopInfo.failCount} times`
      });
      
      // Capture screenshot for vision analysis
      console.log(`[vision-flow] 📸 Step 1: Capturing screenshot for vision analysis...`);
      screenshot = await captureScreenshot(tabId);
      
      if (screenshot) {
        const screenshotSizeKB = Math.round((screenshot.length * 3) / 4 / 1024);
        console.log(`[vision-flow] ✅ Screenshot captured (${screenshotSizeKB} KB)`);
        console.log(`[vision-flow] 📤 Step 2: Sending screenshot to vision-enabled LLM...`);
        console.log(`[vision-flow] Request details:`, {
          jobId,
          step,
          mode,
          observationUrl: observation?.url,
          screenshotSize: `${screenshotSizeKB} KB`,
          loopContext: {
            failedActionType: loopInfo.failedAction.type,
            targetDescription: loopInfo.targetDescription,
            failCount: loopInfo.failCount
          }
        });
        
        // Re-call the planner with the screenshot for vision mode
        try {
          const visionStartTime = Date.now();
          const visionPlan = await postJSON(`${apiBase}/api/agent/next`, {
            jobId,
            step,
            mode,
            observation,
            profile,
            actionHistory: actionHistory.slice(-10), // Rich conversation history
            applicationState, // IMPORTANT: keep goal context in vision mode too
            screenshot: screenshot,
            loopContext: {
              isLoop: true,
              failedAction: loopInfo.failedAction,
              failCount: loopInfo.failCount,
              error: loopInfo.error,
              suggestedAlternatives: loopInfo.suggestedAlternatives
            }
          });
          const visionDuration = Date.now() - visionStartTime;
          
          console.log(`[vision-flow] ✅ Vision analysis completed in ${visionDuration}ms`);
          console.log(`[vision-flow] 📊 Vision result:`, {
            actionType: visionPlan.action?.type,
            thinking: visionPlan.thinking?.slice(0, 100) + "...",
            confidence: visionPlan.confidence
          });
          
          // Use the vision-based plan instead
          action = visionPlan.action;
          thinking = visionPlan.thinking || thinking;
          confidence = visionPlan.confidence ?? confidence;
          
          console.log(`[vision-flow] 🎯 Using vision-suggested action: ${action.type}`);
          if (action.target) {
            console.log(`[vision-flow] Target:`, action.target.text || action.target.selector || action.target.index);
          }
          
          // FAILSAFE: If vision returns an index-based CLICK (like "CLICK 0") while in a loop,
          // it means vision couldn't figure out what to click - escalate to ASK_USER
          if (action.type === "CLICK" && action.target?.by === "index" && typeof action.target?.index === "number") {
            console.log(`[vision-flow] ⚠️ Vision returned index-based CLICK - this won't help break the loop`);
            action = createLoopAskUserAction(loopInfo);
            thinking = "I'm having trouble identifying the right button to click. Can you help?";
            confidence = 0.4;
          }
        } catch (e) {
          console.error(`[vision-flow] ❌ Vision analysis API call failed:`, e);
          console.error(`[vision-flow] Error details:`, {
            message: e.message,
            stack: e.stack,
            apiBase,
            endpoint: `${apiBase}/api/agent/next`
          });
          // Fall back to asking the user
          action = createLoopAskUserAction(loopInfo);
          thinking = "Vision analysis failed. Asking user for help.";
          confidence = 0.3;
          console.log(`[vision-flow] ⚠️ Falling back to ASK_USER action`);
        }
      } else {
        // No screenshot available, ask the user directly
        console.log(`[vision-flow] ❌ Screenshot capture failed, cannot use vision analysis`);
        console.log(`[vision-flow] ⚠️ Falling back to ASK_USER action`);
        action = createLoopAskUserAction(loopInfo);
        thinking = "Could not capture screenshot. Asking user for help.";
        confidence = 0.3;
      }
    } else {
      console.log(`[vision-flow] ✓ No loop detected, proceeding with normal action`);
    }
    
    console.log(`[agent] Step ${step}: ${action.type}`, action);
    console.log(`[agent] Thinking: ${(thinking || "").slice(0, 100)}...`);
    console.log(`[agent] Confidence: ${confidence}`);
    if (loopDetected) console.log(`[agent] Loop recovery mode active`);

    // Log the thinking (observation → action)
    await addLog(jobId, step, {
      type: "thinking",
      url: observation?.url,
      observation: {
        url: observation?.url,
        title: observation?.title,
        fields: observation?.fields?.slice(0, 20), // Limit for storage
        buttons: observation?.buttons?.slice(0, 15),
        pageContextPreview: (observation?.pageContext || "").slice(0, 500),
        specialElements: observation?.specialElements,
      },
      action: action,
      thinking: thinking,
      confidence: confidence,
      forceLive: plannerResponse?.forceLive || false,
    });

    if (plannerResponse?.forceLive && mode !== "live") {
      mode = "live";
      await setJob(jobId, { mode });
      await bringToFront(tabId);
    }

    // Handle DONE action
    if (action.type === "DONE") {
      await addLog(jobId, step, {
        type: "done",
        action: action,
        message: action.summary || "Agent completed"
      });
      // Push to HUD (content script posts ACTION to overlay)
      try {
        await sendToTab(tabId, { type: "EXECUTE", action, thinking, confidence });
      } catch {}
      await setJob(jobId, { status: "done", result: plannerResponse });
      return;
    }

    // Handle REQUEST_VERIFICATION action
    if (action.type === "REQUEST_VERIFICATION") {
      await addLog(jobId, step, {
        type: "verification",
        action: action,
        kind: action.kind,
        message: `Verification required: ${action.kind}`
      });
      // Push to HUD
      try {
        await sendToTab(tabId, { type: "EXECUTE", action, thinking, confidence });
      } catch {}
      await setJob(jobId, { status: "needs_verification", pending: action });
      await bringToFront(tabId);
      // wait until popup sends RESUME_AFTER_VERIFICATION
      return;
    }

    // Handle ASK_USER action - new interactive flow
    if (action.type === "ASK_USER") {
      await addLog(jobId, step, {
        type: "ask_user",
        action: action,
        question: action.question,
        message: `Agent asking: ${action.question}`
      });
      
      // Bring tab to front for user interaction
      await bringToFront(tabId);
      
      // Execute action (shows modal in overlay)
      let execResult;
      try {
        execResult = await sendToTab(tabId, { type: "EXECUTE", action, thinking, confidence });
      } catch (e) {
        console.error("[agent] ASK_USER execute failed:", e);
        await sleep(500);
        continue;
      }

      const actionId = execResult?.result?.actionId;
      if (!actionId) {
        console.error("[agent] ASK_USER missing actionId");
        await sleep(500);
        continue;
      }

      // Update job status
      await setJob(jobId, { 
        status: "waiting_for_user", 
        pending: action,
        pendingActionId: actionId 
      });

      // Wait for user response
      console.log(`[agent] Waiting for user response to: ${action.question}`);
      const userResponse = await waitForUserResponse(actionId);
      
      console.log(`[agent] User response:`, userResponse);
      
      // Log user response
      await addLog(jobId, step, {
        type: "user_response",
        actionId,
        response: userResponse,
        message: userResponse.skipped 
          ? "User skipped the question" 
          : `User selected: ${userResponse.selectedOptionId || userResponse.customResponse}`
      });

      // Close the modal
      try {
        await sendToTab(tabId, { type: "CLOSE_ASK_USER_MODAL" });
      } catch {}

      // Update job status back to running
      await setJob(jobId, { 
        status: "running", 
        pending: null,
        pendingActionId: null,
        lastUserResponse: userResponse
      });

      // Add to action history with user response
      actionHistory.push({
        step,
        action: { ...action, userResponse },
        result: { ok: true }
      });
      await setJob(jobId, { actionHistory });

      // Continue to next iteration - the LLM will see the user response in context
      await sleep(500);
      continue;
    }

    // Track consecutive EXTRACT actions to prevent infinite loops
    if (action.type === "EXTRACT") {
      consecutiveExtracts++;
      if (consecutiveExtracts >= 5) {
        console.log("[agent] Too many consecutive EXTRACT actions, stopping");
        const doneAction = { type: "DONE", summary: "No actionable elements found on page after multiple attempts." };
        try {
          await sendToTab(tabId, { type: "EXECUTE", action: doneAction, thinking, confidence });
        } catch {}
        await setJob(jobId, { 
          status: "done", 
          result: { 
            action: doneAction
          } 
        });
        return;
      }
    } else {
      consecutiveExtracts = 0;
    }

    // Approval gate
    const needsApproval = !behavior.autopilotEnabled && (action.requiresApproval || isSubmitLike(action));
    if (needsApproval) {
      const j = await getJob(jobId);
      if (!j.approved) {
        await setJob(jobId, { status: "paused_for_approval", needsApproval: true });
        await bringToFront(tabId);
        // wait for APPROVE message
        return;
      } else {
        // consume approval once
        await setJob(jobId, { approved: false, needsApproval: false });
      }
    }

    // Execute
    let exec;
    // Build plan progress info for HUD
    const planProgress = currentPlan ? {
      currentStep: (currentPlan.currentStepIndex || 0) + 1,
      totalSteps: currentPlan.plan?.length || 0,
      fieldName: fieldName || (currentPlan.plan?.[currentPlan.currentStepIndex]?.fieldName)
    } : null;
    
    try {
      exec = await sendToTab(tabId, { type: "EXECUTE", action, thinking, confidence, fieldName, planProgress });
    } catch (e) {
      console.error("[agent] Execute failed:", e);
      
      // Add to action history with error (rich format for conversation history)
      actionHistory.push({
        step,
        timestamp: new Date().toISOString(),
        thinking: thinking?.slice(0, 200) || "",
        action: {
          type: action.type,
          target: describeTarget(action.target),
          value: action.value?.slice(0, 50)
        },
        result: { ok: false, error: String(e).slice(0, 100) },
        context: {
          url: observation?.url || "",
          pageTitle: observation?.title || "",
          fieldsCount: observation?.fields?.length || 0,
          buttonsCount: observation?.buttons?.length || 0
        }
      });
      await setJob(jobId, { actionHistory });
      
      await addLog(jobId, step, {
        type: "exec_error",
        action: action,
        error: String(e),
        message: "Execute failed, retrying..."
      });
      await sleep(500);
      continue;
    }

    // Add to action history with rich context for conversation history
    // This enables the LLM to "remember" what it tried and learn from outcomes
    const historyEntry = {
      step,
      timestamp: new Date().toISOString(),
      thinking: thinking?.slice(0, 200) || "", // What the agent was thinking
      action: {
        type: action.type,
        // Human-readable target description
        target: describeTarget(action.target),
        value: action.value?.slice(0, 50) // For FILL actions
      },
      result: exec?.result || { ok: true },
      // Page context at this step
      context: {
        url: observation?.url || "",
        pageTitle: observation?.title || "",
        fieldsCount: observation?.fields?.length || 0,
        buttonsCount: observation?.buttons?.length || 0
      }
    };
    actionHistory.push(historyEntry);
    // Keep last 20 actions for richer conversation history
    if (actionHistory.length > 20) {
      actionHistory = actionHistory.slice(-20);
    }
    await setJob(jobId, { actionHistory });

    // Update session storage for side panel real-time display
    await chrome.storage.session.set({
      agentLiveStep: {
        step,
        action: { type: action.type, target: describeTarget(action.target), value: action.value },
        thinking,
        confidence,
        fieldName,
        planProgress,
        timestamp: Date.now(),
      },
    });
    
    // Track for application state updates
    lastAction = action;
    lastResult = exec?.result || { ok: true };
    
    // ============================================================
    // MULTI-STEP PLAN: Advance to next step after successful execution
    // ============================================================
    if (usingExistingPlan && currentPlan && lastResult.ok !== false) {
      const completedStepIndex = currentPlan.currentStepIndex;
      currentPlan.currentStepIndex = completedStepIndex + 1;
      
      // Mark step as completed
      if (currentPlan.plan[completedStepIndex]) {
        currentPlan.plan[completedStepIndex].completed = true;
        currentPlan.plan[completedStepIndex].result = lastResult;
      }
      
      const remaining = currentPlan.plan.length - currentPlan.currentStepIndex;
      console.log(`[agent] 📋 Plan step ${completedStepIndex + 1} completed. ${remaining} steps remaining.`);
      
      // Persist updated plan
      await setJob(jobId, { currentPlan });
    } else if (usingExistingPlan && currentPlan && lastResult.ok === false) {
      // Action failed - invalidate plan to force re-planning
      console.log(`[agent] 📋 Plan step failed. Invalidating plan for re-planning.`);
      currentPlan = null;
      await setJob(jobId, { currentPlan: null });
    }

    // Check if a CLICK action opened a new tab (e.g., Apply button with target="_blank")
    if (action.type === "CLICK") {
      // Wait briefly for any new tab to be created
      await sleep(500);
      cleanupOldPendingTabSwitches();
      
      const pendingSwitch = pendingTabSwitches.get(tabId);
      if (pendingSwitch && (Date.now() - pendingSwitch.timestamp < 5000)) {
        const newTabId = pendingSwitch.newTabId;
        const oldTabId = tabId; // Save before reassigning
        
        // Verify the new tab exists and is valid
        try {
          const newTab = await chrome.tabs.get(newTabId);
          if (newTab) {
            console.log(`[agent] Switching from tab ${oldTabId} to new tab ${newTabId} (${newTab.url || 'loading...'})`);
            
            // Update tracking
            activeAgentTabs.delete(oldTabId);
            activeAgentTabs.add(newTabId);
            pendingTabSwitches.delete(oldTabId);
            
            // Update tabId for this loop
            tabId = newTabId;
            
            // Update job state with new tabId
            await setJob(jobId, { tabId: newTabId });
            
            // Bring new tab to front if in live mode
            if (mode === "live") {
              await bringToFront(newTabId);
            }
            
            // Log the tab switch
            await addLog(jobId, step, {
              type: "tab_switch",
              message: `Followed click to new tab: ${newTab.url || 'loading...'}`,
              oldTabId: oldTabId,
              newTabId: newTabId
            });
            
            // Wait for the new tab to load
            await sleep(1000);
          }
        } catch (e) {
          console.log(`[agent] New tab ${newTabId} no longer exists, continuing on original tab`);
          pendingTabSwitches.delete(tabId);
        }
      }
    }

    // Log to backend (optional)
    try {
      await postJSON(`${apiBase}/api/agent/log`, { 
        jobId, 
        step, 
        action, 
        result: exec?.result,
        thinking,
        confidence
      });
    } catch {
      // Ignore logging errors
    }

    if (exec?.result?.fatal) {
      await addLog(jobId, step, {
        type: "fatal_error",
        action: action,
        result: exec.result,
        message: `Fatal error: ${exec.result.error}`
      });
      await setJob(jobId, { status: "error", error: exec.result.error });
      return;
    }

    // If we clicked a submit-like button, try to confirm success quickly and stop.
    if (isSubmitLike(action)) {
      for (let i = 0; i < 3; i++) {
        await sleep(800);
        let obs;
        try {
          obs = await sendToTab(tabId, { type: "OBSERVE" });
        } catch {
          continue;
        }

        if (looksSubmitted(obs)) {
          const doneAction = { type: "DONE", summary: "Application submitted (confirmation detected on page)." };
          await addLog(jobId, step, { type: "done", action: doneAction, url: obs?.url, message: doneAction.summary });
          try {
            await sendToTab(tabId, { type: "EXECUTE", action: doneAction, thinking: "Submission confirmed!", confidence: 0.95 });
          } catch {}
          await setJob(jobId, { status: "done", result: { action: doneAction } });
          return;
        }
      }
    }

    // Optimized delays between actions for efficiency
    let delayMs;
    switch (action.type) {
      case "EXTRACT":
        delayMs = 1500; // Reduced from 2000ms - content script handles waiting
        break;
      case "CLICK":
        delayMs = 200; // Reduced from 800ms - efficient click method
        break;
      case "SELECT_CUSTOM":
        delayMs = 300; // Moderate delay for dropdown operations
        break;
      case "FILL":
        delayMs = 150; // Quick delay for form filling
        break;
      case "SELECT":
      case "CHECK":
        delayMs = 100; // Very quick for simple interactions
        break;
      case "NAVIGATE":
        delayMs = 500; // Allow navigation to start
        break;
      case "WAIT_FOR":
        delayMs = 50; // Minimal delay when action itself waits
        break;
      default:
        delayMs = 250; // Default reduced delay
    }
    await sleep(delayMs);
  }
  } finally {
    // Cleanup: remove tab from active tracking
    activeAgentTabs.delete(tabId);
    pendingTabSwitches.delete(tabId);
    console.log(`[agent] Cleaned up tab tracking for tab ${tabId}`);
  }
}

async function resumeLoop(jobId) {
  const job = await getJob(jobId);
  if (!job?.tabId) return;
  agentLoop({ jobId, startUrl: "about:blank", mode: job.mode || "live" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "START_JOB") {
        agentLoop({ jobId: msg.jobId, startUrl: msg.startUrl, mode: msg.mode });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "STOP_JOB") {
        await setJob(msg.jobId, { stop: true, status: "stopping" });
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "APPROVE") {
        await setJob(msg.jobId, { approved: true, needsApproval: false, status: "running" });
        resumeLoop(msg.jobId);
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "RESUME_AFTER_VERIFICATION") {
        await setJob(msg.jobId, { status: "running", pending: null });
        resumeLoop(msg.jobId);
        sendResponse({ ok: true });
        return;
      }

      // Handle resume/continue job from popup
      if (msg.type === "RESUME_JOB") {
        const job = await getJob(msg.jobId);
        if (job?.tabId) {
          // Reset stop flag and status
          await setJob(msg.jobId, { status: "running", stop: false });
          // Resume with stored URL
          agentLoop({ jobId: msg.jobId, startUrl: job.startUrl || "about:blank", mode: job.mode || "live" });
        }
        sendResponse({ ok: true });
        return;
      }

      // Handle user response from ASK_USER modal
      if (msg.type === "USER_RESPONSE") {
        const { actionId, selectedOptionId, customResponse, skipped } = msg;
        const pending = pendingUserResponses.get(actionId);
        if (pending) {
          pending.resolve({ selectedOptionId, customResponse, skipped });
        }
        sendResponse({ ok: true });
        return;
      }

      // Handle pause toggle from HUD
      if (msg.type === "PAUSE_TOGGLE") {
        globalPaused = msg.paused;
        console.log(`[agent] Global pause: ${globalPaused}`);
        sendResponse({ ok: true });
        return;
      }

      // Handle help request from HUD
      if (msg.type === "REQUEST_HELP") {
        // Could open popup or trigger notification
        console.log("[agent] User requested help");
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "SIDE_PANEL_OPENED") {
        sidePanelOpen = true;
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "SIDE_PANEL_CLOSED") {
        sidePanelOpen = false;
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "TOGGLE_SIDE_PANEL") {
        if (sidePanelOpen) {
          chrome.runtime.sendMessage({ type: "CLOSE_SIDE_PANEL" });
          sidePanelOpen = false;
        } else {
          const tabId = sender.tab?.id;
          if (tabId) {
            try {
              await chrome.sidePanel.open({ tabId });
            } catch (e) {
              console.error("[agent] Failed to open side panel:", e);
            }
          }
        }
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === "COPILOT_SUMMARIZE") {
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
            chrome.storage.session.set({
              copilotResult: { error: err.message, type: "error" },
            });
            sendResponse({ ok: false, error: err.message });
          });
        return true;
      }

      // Handle request for resume file from content script
      if (msg.type === "GET_RESUME_FILE") {
        const data = await chrome.storage.local.get([PROFILE_KEY]);
        const profile = data[PROFILE_KEY] || {};
        sendResponse({ ok: true, resumeFile: profile.resumeFile || null });
        return;
      }

      if (msg.type === "GET_LOGS") {
        const data = await chrome.storage.local.get([LOGS_KEY]);
        const logs = data[LOGS_KEY] || [];
        // Filter by jobId if provided
        const filtered = msg.jobId ? logs.filter(l => l.jobId === msg.jobId) : logs;
        sendResponse({ ok: true, logs: filtered });
        return;
      }

      if (msg.type === "CLEAR_LOGS") {
        await chrome.storage.local.set({ [LOGS_KEY]: [] });
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});

// ============================================================
// EXTERNAL MESSAGING - Allow external web apps to trigger agent
// ============================================================

// Allowed origins for external messaging
const ALLOWED_EXTERNAL_ORIGINS = [
  "https://vaulty.ca",
  "https://vaulty.ia",
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173"
];

// Handle messages from external web apps (e.g., Vaulty dashboard)
chrome.runtime.onMessageExternal.addListener(
  (request, sender, sendResponse) => {
    (async () => {
      try {
        // Security: Verify sender origin
        const senderOrigin = sender.url ? new URL(sender.url).origin : null;
        const isAllowed = senderOrigin && ALLOWED_EXTERNAL_ORIGINS.some(
          allowed => senderOrigin === allowed || senderOrigin.startsWith(allowed.replace("/*", ""))
        );

        if (!isAllowed) {
          console.log("[external] Rejected message from unauthorized origin:", senderOrigin);
          sendResponse({ ok: false, error: "Unauthorized origin" });
          return;
        }

        console.log("[external] Received message:", request.type, "from:", senderOrigin);

        // Handle: Check if extension is installed
        if (request.type === "GET_EXTENSION_STATUS") {
          sendResponse({
            ok: true,
            installed: true,
            version: chrome.runtime.getManifest().version
          });
          return;
        }

        // Handle: Get status of a specific job
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

        // Handle: Start a new job from external app
        if (request.type === "START_JOB_FROM_EXTERNAL") {
          const result = await handleExternalJobStart(request.payload, senderOrigin);
          sendResponse(result);
          return;
        }

        // Handle: Cancel a running job
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
    return true; // Keep channel open for async response
  }
);

// Handle external job start request
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

  // Validate required fields
  if (!jobUrl) {
    return { ok: false, error: "jobUrl is required" };
  }

  // Validate URL format
  try {
    new URL(jobUrl);
  } catch {
    return { ok: false, error: "Invalid jobUrl format" };
  }

  const jobId = crypto.randomUUID().slice(0, 24);
  console.log(`[external] Starting job ${jobId} for ${jobUrl}`);

  // Create pre-filled application state
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
    blockers: {
      type: null,
      description: null,
      attemptsMade: 0,
    },
    memory: {
      successfulPatterns: [],
      failedPatterns: [],
      pagesVisited: [],
    },
    // External data from the web app
    external: {
      coverLetter: coverLetter || null,
      resumeId: resumeId || null,
      customFields: customFields || {},
      source: source,
    },
  };

  // Store initial job state
  await setJob(jobId, {
    status: "starting",
    applicationState: prefilledState,
    startUrl: jobUrl,
    externalSource: source,
    mode: mode,
  });

  // Start the agent loop
  agentLoop({ jobId, startUrl: jobUrl, mode });

  return {
    ok: true,
    jobId,
    message: `Started application for ${jobTitle || "job"} at ${company || "company"}`
  };
}
