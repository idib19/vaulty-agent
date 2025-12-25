const DEFAULT_API_BASE = "http://localhost:3000";
const PROFILE_KEY = "userProfile";
const SETTINGS_KEY = "agentSettings";
const LOGS_KEY = "agentLogs";
const DEFAULT_MAX_STEPS = 40;
const MAX_LOGS = 200; // Keep last 200 log entries

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  return chrome.tabs.sendMessage(tabId, msg);
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
  if (t?.by === "text") {
    const s = (t.text || "").toLowerCase();
    return ["submit", "apply", "confirm", "pay", "finish", "send", "complete", "place order"].some(k => s.includes(k));
  }
  return false;
}

function looksSubmitted(observation) {
  const url = String(observation?.url || "").toLowerCase();
  const text = String(observation?.pageContext || observation?.text || "").toLowerCase();
  const hay = `${url}\n${text}`;
  return [
    "application submitted",
    "thanks for applying",
    "thank you for applying",
    "we received your application",
    "we have received your application",
    "application received",
    "submission confirmed",
    "confirmation number",
    "your application has been submitted",
    "applied successfully"
  ].some(k => hay.includes(k));
}

async function agentLoop({ jobId, startUrl, mode }) {
  let tabId;
  
  // Check if we're resuming an existing job
  const existingJob = await getJob(jobId);
  if (existingJob.tabId && startUrl === "about:blank") {
    tabId = existingJob.tabId;
  } else {
    tabId = await createTab(startUrl, mode);
  }
  
  let step = existingJob.step || 0;
  let consecutiveExtracts = 0;

  await setJob(jobId, { status: "running", step, tabId, mode, approved: false, stop: false });

  // Load behavior settings (cap / maxSteps)
  await loadBehaviorSettings();

  // Get user profile for the LLM
  const profile = await getProfile();
  if (profile) {
    console.log("[agent] Using profile:", profile.firstName, profile.lastName);
  } else {
    console.log("[agent] No profile configured - LLM will use stub rules");
  }

  while (true) {
    const job = await getJob(jobId);
    if (job.stop) {
      await setJob(jobId, { status: "stopped" });
      return;
    }

    step += 1;
    await setJob(jobId, { step });

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

    // Planner call with profile
    const apiBase = await getApiBase();
    let plan;
    try {
      plan = await postJSON(`${apiBase}/api/agent/next`, {
        jobId,
        step,
        mode,
        observation,
        profile, // Include user profile for LLM
      });
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

    const action = plan.action;
    console.log(`[agent] Step ${step}: ${action.type}`, action);

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
      },
      action: action,
      forceLive: plan.forceLive || false,
    });

    if (plan.forceLive && mode !== "live") {
      mode = "live";
      await setJob(jobId, { mode });
      await bringToFront(tabId);
    }

    if (action.type === "DONE") {
      await addLog(jobId, step, {
        type: "done",
        action: action,
        message: action.summary || "Agent completed"
      });
      // Push to HUD (content script posts ACTION to overlay)
      try {
        await sendToTab(tabId, { type: "EXECUTE", action });
      } catch {}
      await setJob(jobId, { status: "done", result: plan });
      return;
    }

    if (action.type === "REQUEST_VERIFICATION") {
      await addLog(jobId, step, {
        type: "verification",
        action: action,
        kind: action.kind,
        message: `Verification required: ${action.kind}`
      });
      // Push to HUD
      try {
        await sendToTab(tabId, { type: "EXECUTE", action });
      } catch {}
      await setJob(jobId, { status: "needs_verification", pending: action });
      await bringToFront(tabId);
      // wait until popup sends RESUME_AFTER_VERIFICATION
      return;
    }

    // Track consecutive EXTRACT actions to prevent infinite loops
    if (action.type === "EXTRACT") {
      consecutiveExtracts++;
      if (consecutiveExtracts >= 5) {
        console.log("[agent] Too many consecutive EXTRACT actions, stopping");
        const doneAction = { type: "DONE", summary: "No actionable elements found on page after multiple attempts." };
        try {
          await sendToTab(tabId, { type: "EXECUTE", action: doneAction });
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
    try {
      exec = await sendToTab(tabId, { type: "EXECUTE", action });
    } catch (e) {
      console.error("[agent] Execute failed:", e);
      await addLog(jobId, step, {
        type: "exec_error",
        action: action,
        error: String(e),
        message: "Execute failed, retrying..."
      });
      await sleep(500);
      continue;
    }

    // Log to backend (optional)
    try {
      await postJSON(`${apiBase}/api/agent/log`, { 
        jobId, 
        step, 
        action, 
        result: exec?.result 
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
            await sendToTab(tabId, { type: "EXECUTE", action: doneAction });
          } catch {}
          await setJob(jobId, { status: "done", result: { action: doneAction } });
          return;
        }
      }
    }

    // Add delay between actions
    const delayMs = action.type === "EXTRACT" ? 2000 : 800;
    await sleep(delayMs);
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
