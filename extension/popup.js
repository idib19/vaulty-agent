const API_BASE_DEFAULT = "http://localhost:3000";
const PROFILE_KEY = "userProfile";
const SETTINGS_KEY = "agentSettings";
const LOGS_KEY = "agentLogs";
const DEFAULT_MAX_STEPS = 40;

// ===== Utility Functions =====

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function getActiveJob() {
  const { activeJobId } = await chrome.storage.local.get(["activeJobId"]);
  return activeJobId || null;
}

async function setActiveJob(jobId) {
  await chrome.storage.local.set({ activeJobId: jobId });
}

async function setStatus(jobId, patch) {
  await chrome.storage.local.set({ [`job:${jobId}`]: patch });
}

async function getJob(jobId) {
  const key = `job:${jobId}`;
  const data = await chrome.storage.local.get([key]);
  return data[key] || null;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get(["apiBase"]);
  return apiBase || API_BASE_DEFAULT;
}

function showStatusMsg(elementId, message, isSuccess = true) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = `status-msg ${isSuccess ? 'success' : 'error'}`;
  setTimeout(() => { el.textContent = ""; }, 3000);
}

// ===== Tab Navigation =====

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    
    // Auto-refresh logs when switching to logs tab
    if (tab.dataset.tab === "logs") {
      loadLogs();
    }
  });
});

// ===== Agent Tab =====

async function refreshUI() {
  const jobId = await getActiveJob();
  document.getElementById("jobId").textContent = jobId ? jobId.slice(0, 8) + "..." : "—";

  if (!jobId) {
    document.getElementById("status").textContent = "idle";
    document.getElementById("step").textContent = "0";
    document.getElementById("approval").classList.add("hidden");
    document.getElementById("passwordRequest").classList.add("hidden");
    document.getElementById("otpRequest").classList.add("hidden");
    return;
  }

  const job = await getJob(jobId);
  document.getElementById("status").textContent = job?.status || "unknown";
  document.getElementById("step").textContent = String(job?.step || 0);

  // Show/hide approval
  if (job?.needsApproval) {
    document.getElementById("approval").classList.remove("hidden");
  } else {
    document.getElementById("approval").classList.add("hidden");
  }

  // Show/hide password request
  if (job?.status === "needs_verification" && job?.pending?.kind === "PASSWORD") {
    document.getElementById("passwordRequest").classList.remove("hidden");
    document.getElementById("otpRequest").classList.add("hidden");
  } 
  // Show/hide OTP request
  else if (job?.status === "needs_verification") {
    document.getElementById("otpRequest").classList.remove("hidden");
    document.getElementById("passwordRequest").classList.add("hidden");
  } else {
    document.getElementById("passwordRequest").classList.add("hidden");
    document.getElementById("otpRequest").classList.add("hidden");
  }
}

document.getElementById("start").addEventListener("click", async () => {
  const url = document.getElementById("url").value.trim();
  if (!url) {
    alert("Please enter a URL");
    return;
  }

  const mode = [...document.querySelectorAll("input[name='mode']")].find(r => r.checked)?.value || "live";
  const jobId = uid();

  await setActiveJob(jobId);
  
  const apiBase = await getApiBase();
  await chrome.storage.local.set({ apiBase });

  await setStatus(jobId, { status: "starting", step: 0, needsApproval: false });
  chrome.runtime.sendMessage({ type: "START_JOB", jobId, startUrl: url, mode });

  refreshUI();
});

document.getElementById("stop").addEventListener("click", async () => {
  const jobId = await getActiveJob();
  if (!jobId) return;
  chrome.runtime.sendMessage({ type: "STOP_JOB", jobId });
  await setStatus(jobId, { status: "stopping" });
  refreshUI();
});

document.getElementById("approve").addEventListener("click", async () => {
  const jobId = await getActiveJob();
  if (!jobId) return;
  chrome.runtime.sendMessage({ type: "APPROVE", jobId });
  await setStatus(jobId, { ...(await getJob(jobId)), needsApproval: false });
  refreshUI();
});

document.getElementById("sendOtp").addEventListener("click", async () => {
  const jobId = await getActiveJob();
  if (!jobId) return;

  const otp = document.getElementById("otp").value.trim();
  if (!otp) return;

  const apiBase = await getApiBase();
  await postJSON(`${apiBase}/api/agent/verify`, { jobId, code: otp });
  chrome.runtime.sendMessage({ type: "RESUME_AFTER_VERIFICATION", jobId, code: otp });
  document.getElementById("otp").value = "";
  refreshUI();
});

document.getElementById("sendPassword").addEventListener("click", async () => {
  const jobId = await getActiveJob();
  if (!jobId) return;

  const password = document.getElementById("passwordInput").value;
  if (!password) return;

  // Send password as verification code
  const apiBase = await getApiBase();
  await postJSON(`${apiBase}/api/agent/verify`, { jobId, code: password, kind: "PASSWORD" });
  chrome.runtime.sendMessage({ type: "RESUME_AFTER_VERIFICATION", jobId, code: password, kind: "PASSWORD" });
  document.getElementById("passwordInput").value = "";
  refreshUI();
});

// ===== Profile Tab =====

async function loadProfile() {
  const data = await chrome.storage.local.get([PROFILE_KEY]);
  const profile = data[PROFILE_KEY] || {};
  
  // Credentials
  document.getElementById("profile-email").value = profile.email || "";
  document.getElementById("profile-password").value = profile.password || "";
  document.getElementById("profile-preferOAuth").checked = profile.preferOAuth || false;
  
  // Personal
  document.getElementById("profile-firstName").value = profile.firstName || "";
  document.getElementById("profile-lastName").value = profile.lastName || "";
  document.getElementById("profile-phone").value = profile.phone || "";
  
  // Address
  const addr = profile.address || {};
  document.getElementById("profile-street").value = addr.street || "";
  document.getElementById("profile-street2").value = addr.street2 || "";
  document.getElementById("profile-city").value = addr.city || "";
  document.getElementById("profile-state").value = addr.state || "";
  document.getElementById("profile-zipCode").value = addr.zipCode || "";
  document.getElementById("profile-country").value = addr.country || "";
  
  // Professional
  document.getElementById("profile-company").value = profile.company || "";
  document.getElementById("profile-jobTitle").value = profile.jobTitle || "";
  document.getElementById("profile-linkedIn").value = profile.linkedIn || "";
  document.getElementById("profile-github").value = profile.github || "";
  document.getElementById("profile-website").value = profile.website || "";
  
  // Resume
  if (profile.resume) {
    // If we have structured resume data, convert to JSON for display
    if (profile.resume.rawText) {
      document.getElementById("profile-resume").value = profile.resume.rawText;
    } else {
      document.getElementById("profile-resume").value = JSON.stringify(profile.resume, null, 2);
    }
  } else {
    document.getElementById("profile-resume").value = "";
  }
}

function parseResumeInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  
  // Try to parse as JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object') {
        return {
          bio: parsed.bio || parsed.summary || parsed.objective,
          summary: parsed.summary || parsed.bio,
          experiences: parsed.experiences || parsed.experience || parsed.work,
          education: parsed.education,
          skills: Array.isArray(parsed.skills) ? parsed.skills : 
                  typeof parsed.skills === 'string' ? parsed.skills.split(',').map(s => s.trim()) : undefined,
          certifications: parsed.certifications,
          languages: parsed.languages,
          rawText: trimmed,
        };
      }
    } catch {
      // Not valid JSON
    }
  }
  
  // Return as raw text
  return { rawText: trimmed };
}

document.getElementById("saveProfile").addEventListener("click", async () => {
  const resumeInput = document.getElementById("profile-resume").value;
  const resume = parseResumeInput(resumeInput);
  
  const profile = {
    // Credentials
    email: document.getElementById("profile-email").value.trim(),
    password: document.getElementById("profile-password").value, // Don't trim passwords
    preferOAuth: document.getElementById("profile-preferOAuth").checked,
    
    // Personal
    firstName: document.getElementById("profile-firstName").value.trim(),
    lastName: document.getElementById("profile-lastName").value.trim(),
    phone: document.getElementById("profile-phone").value.trim(),
    
    // Address
    address: {
      street: document.getElementById("profile-street").value.trim(),
      street2: document.getElementById("profile-street2").value.trim(),
      city: document.getElementById("profile-city").value.trim(),
      state: document.getElementById("profile-state").value.trim(),
      zipCode: document.getElementById("profile-zipCode").value.trim(),
      country: document.getElementById("profile-country").value.trim(),
    },
    
    // Professional
    company: document.getElementById("profile-company").value.trim(),
    jobTitle: document.getElementById("profile-jobTitle").value.trim(),
    linkedIn: document.getElementById("profile-linkedIn").value.trim(),
    github: document.getElementById("profile-github").value.trim(),
    website: document.getElementById("profile-website").value.trim(),
    
    // Resume
    resume: resume,
    
    // Metadata
    updatedAt: new Date().toISOString(),
  };
  
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
  showStatusMsg("profileStatus", "✓ Profile saved!", true);
});

document.getElementById("clearProfile").addEventListener("click", async () => {
  if (!confirm("Are you sure you want to clear all profile data?")) return;
  
  await chrome.storage.local.remove([PROFILE_KEY]);
  await loadProfile();
  showStatusMsg("profileStatus", "Profile cleared", true);
});

// ===== Settings Tab =====

async function loadSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY, "apiBase"]);
  const settings = data[SETTINGS_KEY] || {};
  
  document.getElementById("settings-apiBase").value = data.apiBase || API_BASE_DEFAULT;
  document.getElementById("settings-llmProvider").value = settings.llmProvider || "";
  document.getElementById("settings-llmApiKey").value = settings.llmApiKey || "";
  document.getElementById("settings-llmModel").value = settings.llmModel || "";
  document.getElementById("settings-ollamaUrl").value = settings.ollamaUrl || "http://localhost:11434";
  
  toggleOllamaSettings();
}

// ===== Behavior Tab =====

async function loadBehavior() {
  const data = await chrome.storage.local.get([SETTINGS_KEY]);
  const settings = data[SETTINGS_KEY] || {};

  const autopilotEnabled = settings.autopilotEnabled !== false; // default true
  const capEnabled = settings.capEnabled !== false; // default true
  const maxSteps = Number.isFinite(settings.maxSteps) ? settings.maxSteps : DEFAULT_MAX_STEPS;

  const autopilotEl = document.getElementById("behavior-autopilotEnabled");
  const capEl = document.getElementById("behavior-capEnabled");
  const maxEl = document.getElementById("behavior-maxSteps");
  if (autopilotEl) autopilotEl.checked = !!autopilotEnabled;
  if (capEl) capEl.checked = !!capEnabled;
  if (maxEl) maxEl.value = String(maxSteps);

  // Disable input if cap disabled
  if (maxEl) maxEl.disabled = !capEnabled;
}

function wireBehaviorUI() {
  const autopilotEl = document.getElementById("behavior-autopilotEnabled");
  const capEl = document.getElementById("behavior-capEnabled");
  const maxEl = document.getElementById("behavior-maxSteps");
  const saveEl = document.getElementById("saveBehavior");

  if (capEl && maxEl) {
    capEl.addEventListener("change", () => {
      maxEl.disabled = !capEl.checked;
    });
  }

  if (saveEl) {
    saveEl.addEventListener("click", async () => {
      const data = await chrome.storage.local.get([SETTINGS_KEY]);
      const cur = data[SETTINGS_KEY] || {};

      const autopilotEnabled = !!document.getElementById("behavior-autopilotEnabled")?.checked;
      const capEnabled = !!document.getElementById("behavior-capEnabled")?.checked;
      const raw = document.getElementById("behavior-maxSteps")?.value;
      let maxSteps = parseInt(String(raw || DEFAULT_MAX_STEPS), 10);
      if (!Number.isFinite(maxSteps) || maxSteps < 1) maxSteps = DEFAULT_MAX_STEPS;

      await chrome.storage.local.set({
        [SETTINGS_KEY]: {
          ...cur,
          autopilotEnabled,
          capEnabled,
          maxSteps,
        },
      });

      showStatusMsg("behaviorStatus", "✓ Behavior saved!", true);
    });
  }
}

function toggleOllamaSettings() {
  const provider = document.getElementById("settings-llmProvider").value;
  const ollamaSettings = document.getElementById("ollamaSettings");
  if (provider === "ollama") {
    ollamaSettings.classList.remove("hidden");
  } else {
    ollamaSettings.classList.add("hidden");
  }
}

document.getElementById("settings-llmProvider").addEventListener("change", toggleOllamaSettings);

document.getElementById("saveSettings").addEventListener("click", async () => {
  const apiBase = document.getElementById("settings-apiBase").value.trim() || API_BASE_DEFAULT;
  const settings = {
    llmProvider: document.getElementById("settings-llmProvider").value,
    llmApiKey: document.getElementById("settings-llmApiKey").value.trim(),
    llmModel: document.getElementById("settings-llmModel").value.trim(),
    ollamaUrl: document.getElementById("settings-ollamaUrl").value.trim(),
  };
  
  await chrome.storage.local.set({ 
    apiBase,
    [SETTINGS_KEY]: settings 
  });
  
  showStatusMsg("settingsStatus", "✓ Settings saved!", true);
});

// Debug functions
document.getElementById("exportProfile").addEventListener("click", async () => {
  const data = await chrome.storage.local.get([PROFILE_KEY]);
  const profile = data[PROFILE_KEY] || {};
  
  // Create download
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vaulty-profile.json";
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("viewStorage").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(null);
  console.log("Chrome Storage:", data);
  alert("Storage data logged to console (F12 → Console)");
});

// ===== Logs Tab =====

function getActionTypeClass(action) {
  if (!action) return "error";
  const type = action.type?.toLowerCase() || "";
  if (type === "fill") return "fill";
  if (type === "click") return "click";
  if (type === "done") return "done";
  if (type === "extract") return "extract";
  if (type === "request_verification") return "verify";
  return "extract";
}

function getActionIcon(action) {
  if (!action) return "❌";
  switch (action.type) {
    case "FILL": return "✏️";
    case "CLICK": return "👆";
    case "DONE": return "✅";
    case "EXTRACT": return "🔍";
    case "SELECT": return "📋";
    case "CHECK": return "☑️";
    case "NAVIGATE": return "🔗";
    case "WAIT_FOR": return "⏳";
    case "REQUEST_VERIFICATION": return "🔐";
    default: return "▶️";
  }
}

function formatActionSummary(action) {
  if (!action) return "Unknown action";
  switch (action.type) {
    case "FILL":
      const target = action.target?.selector || action.target?.text || action.target?.index || "?";
      const valuePreview = action.value ? (action.value.length > 30 ? action.value.slice(0, 30) + "..." : action.value) : "";
      return `Fill "${target}" → "${valuePreview}"`;
    case "CLICK":
      const clickTarget = action.target?.text || action.target?.selector || action.target?.index || "?";
      return `Click "${clickTarget}"`;
    case "DONE":
      return action.summary || "Completed";
    case "EXTRACT":
      return `Extract ${action.mode || "data"}`;
    case "SELECT":
      return `Select "${action.value}" in ${action.target?.selector || "?"}`;
    case "CHECK":
      return `${action.checked ? "Check" : "Uncheck"} ${action.target?.selector || "?"}`;
    case "REQUEST_VERIFICATION":
      return `Verification: ${action.kind || "?"}`;
    case "WAIT_FOR":
      return `Wait for "${action.target?.text || "?"}"`;
    case "NAVIGATE":
      return `Navigate to ${action.url || "?"}`;
    default:
      return action.type || "Unknown";
  }
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderLogEntry(log) {
  const typeClass = log.type === "error" || log.type === "fatal_error" || log.type === "exec_error" 
    ? "error" 
    : getActionTypeClass(log.action);
  
  const icon = log.type === "error" || log.type === "fatal_error" ? "❌" : getActionIcon(log.action);
  const summary = log.message || formatActionSummary(log.action);
  
  // Build details sections
  let detailsHtml = "";
  
  // Action JSON
  if (log.action) {
    detailsHtml += `
      <div class="log-section">
        <div class="log-section-title">Action (LLM Output)</div>
        <div class="log-section-content json">${escapeHtml(JSON.stringify(log.action, null, 2))}</div>
      </div>
    `;
  }
  
  // Observation summary
  if (log.observation) {
    const obs = log.observation;
    let obsText = `URL: ${obs.url || "?"}\nTitle: ${obs.title || "?"}\n`;
    obsText += `Fields: ${obs.fields?.length || obs.fieldsCount || 0}\n`;
    obsText += `Buttons: ${obs.buttons?.length || obs.buttonsCount || 0}`;
    
    if (obs.fields && obs.fields.length > 0) {
      obsText += `\n\nFields found:\n`;
      obs.fields.slice(0, 10).forEach((f, i) => {
        obsText += `  [${f.index}] ${f.type || f.tag} "${f.label || f.placeholder || f.name || f.id || "?"}"`;
        if (f.value) obsText += ` = "${f.value.slice(0, 20)}${f.value.length > 20 ? "..." : ""}"`;
        obsText += "\n";
      });
      if (obs.fields.length > 10) obsText += `  ... and ${obs.fields.length - 10} more\n`;
    }
    
    if (obs.buttons && obs.buttons.length > 0) {
      obsText += `\nButtons found:\n`;
      obs.buttons.slice(0, 8).forEach((b, i) => {
        obsText += `  [${b.index}] "${b.text}"\n`;
      });
      if (obs.buttons.length > 8) obsText += `  ... and ${obs.buttons.length - 8} more\n`;
    }
    
    detailsHtml += `
      <div class="log-section">
        <div class="log-section-title">Page Observation (LLM Input)</div>
        <div class="log-section-content">${escapeHtml(obsText)}</div>
      </div>
    `;
  }
  
  // Error info
  if (log.error) {
    detailsHtml += `
      <div class="log-section">
        <div class="log-section-title">Error</div>
        <div class="log-section-content" style="color: #991B1B;">${escapeHtml(log.error)}</div>
      </div>
    `;
  }
  
  // Page context preview
  if (log.observation?.pageContextPreview) {
    detailsHtml += `
      <div class="log-section">
        <div class="log-section-title">Page Text (Preview)</div>
        <div class="log-section-content">${escapeHtml(log.observation.pageContextPreview.slice(0, 300))}...</div>
      </div>
    `;
  }
  
  return `
    <div class="log-entry" data-id="${log.id}">
      <div class="log-header">
        <span class="log-step">#${log.step}</span>
        <span class="log-action">
          <span class="log-action-type ${typeClass}">${icon} ${log.action?.type || log.type?.toUpperCase() || "?"}</span>
          ${escapeHtml(summary)}
        </span>
        <span class="log-time">${formatTime(log.timestamp)}</span>
        <span class="log-expand">▼</span>
      </div>
      ${log.url ? `<div class="log-url">${escapeHtml(log.url)}</div>` : ""}
      <div class="log-details">
        ${detailsHtml || '<div class="log-section"><div class="log-section-content">No additional details</div></div>'}
      </div>
    </div>
  `;
}

async function loadLogs() {
  const container = document.getElementById("logsContainer");
  if (!container) return;
  
  try {
    const data = await chrome.storage.local.get([LOGS_KEY]);
    const logs = data[LOGS_KEY] || [];
    
    if (logs.length === 0) {
      container.innerHTML = '<div class="logs-empty">No logs yet. Start the agent to see thinking.</div>';
      return;
    }
    
    // Reverse to show newest first
    const reversedLogs = [...logs].reverse();
    container.innerHTML = reversedLogs.map(renderLogEntry).join("");
    
    // Add click handlers for expand/collapse
    container.querySelectorAll(".log-header").forEach(header => {
      header.addEventListener("click", () => {
        header.closest(".log-entry").classList.toggle("expanded");
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="logs-empty">Error loading logs: ${e.message}</div>`;
  }
}

function wireLogsUI() {
  const refreshBtn = document.getElementById("refreshLogs");
  const clearBtn = document.getElementById("clearLogs");
  const exportBtn = document.getElementById("exportLogs");
  
  if (refreshBtn) {
    refreshBtn.addEventListener("click", loadLogs);
  }
  
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      if (!confirm("Clear all agent logs?")) return;
      await chrome.storage.local.set({ [LOGS_KEY]: [] });
      loadLogs();
    });
  }
  
  if (exportBtn) {
    exportBtn.addEventListener("click", async () => {
      const data = await chrome.storage.local.get([LOGS_KEY]);
      const logs = data[LOGS_KEY] || [];
      
      const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vaulty-logs-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }
}

// ===== Initialize =====

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  refreshUI();
  // Auto-refresh logs if on logs tab
  if (changes[LOGS_KEY]) {
    const logsTab = document.querySelector('.tab[data-tab="logs"]');
    if (logsTab?.classList.contains("active")) {
      loadLogs();
    }
  }
});

// Load all data on popup open
(async () => {
  await refreshUI();
  await loadProfile();
  await loadSettings();
  await loadBehavior();
  await loadLogs();
  wireBehaviorUI();
  wireLogsUI();
})();
