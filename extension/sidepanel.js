const API_BASE_DEFAULT = "http://localhost:3000";
const PROFILE_KEY = "userProfile";
const SETTINGS_KEY = "agentSettings";
const LOGS_KEY = "agentLogs";
const DEFAULT_MAX_STEPS = 40;

chrome.runtime.sendMessage({ type: "SIDE_PANEL_OPENED" });
window.addEventListener("beforeunload", () => {
  chrome.runtime.sendMessage({ type: "SIDE_PANEL_CLOSED" });
});
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "CLOSE_SIDE_PANEL") window.close();
});

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function getActiveJob() {
  const { activeJobId } = await chrome.storage.local.get(["activeJobId"]);
  return activeJobId || null;
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
    body: JSON.stringify(body),
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
  if (!el) return;
  el.textContent = message;
  el.className = `status-msg ${isSuccess ? "success" : "error"}`;
  setTimeout(() => {
    el.textContent = "";
  }, 3000);
}

async function prefillCurrentTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (
      tab?.url &&
      !tab.url.startsWith("chrome://") &&
      !tab.url.startsWith("chrome-extension://") &&
      !tab.url.startsWith("about:")
    ) {
      document.getElementById("url").value = tab.url;
      return tab.url;
    }
  } catch (e) {
    console.log("Could not get current tab URL:", e);
  }
  return null;
}

// Tab navigation
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    const content = document.getElementById(`tab-${tab.dataset.tab}`);
    if (content) content.classList.add("active");
    if (tab.dataset.tab === "apply") loadLogs();
  });
});

// Apply tab UI
async function refreshUI() {
  const jobId = await getActiveJob();
  const jobIdEl = document.getElementById("jobId");
  if (jobIdEl) jobIdEl.textContent = jobId ? jobId.slice(0, 8) + "..." : "—";

  if (!jobId) {
    const statusEl = document.getElementById("status");
    const stepEl = document.getElementById("step");
    if (statusEl) statusEl.textContent = "idle";
    if (stepEl) stepEl.textContent = "0";
    ["approval", "passwordRequest", "otpRequest", "continueSection", "jobUrlDisplay", "liveStep"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    });
    return;
  }

  const job = await getJob(jobId);
  let statusText = job?.status || "unknown";
  const statusMap = {
    waiting_for_user: "Waiting for input",
    running: "Running",
    done: "Done",
    error: "Error",
    paused_for_approval: "Awaiting approval",
    needs_verification: "Needs verification",
    stopped: "Stopped",
  };
  statusText = statusMap[statusText] || statusText;

  const statusEl = document.getElementById("status");
  const stepEl = document.getElementById("step");
  if (statusEl) statusEl.textContent = statusText;
  if (stepEl) stepEl.textContent = String(job?.step || 0);

  if (job?.startUrl) {
    const jobUrlDisplay = document.getElementById("jobUrlDisplay");
    const jobUrl = document.getElementById("jobUrl");
    if (jobUrlDisplay) jobUrlDisplay.classList.remove("hidden");
    if (jobUrl) {
      jobUrl.textContent = job.startUrl.length > 40 ? job.startUrl.slice(0, 40) + "..." : job.startUrl;
      jobUrl.title = job.startUrl;
    }
    const urlInput = document.getElementById("url");
    if (urlInput) urlInput.value = job.startUrl;
  } else {
    const jobUrlDisplay = document.getElementById("jobUrlDisplay");
    if (jobUrlDisplay) jobUrlDisplay.classList.add("hidden");
  }

  const canContinue =
    job?.status === "waiting_for_user" || job?.status === "stopped" || job?.status === "error";
  const continueSection = document.getElementById("continueSection");
  if (continueSection) {
    if (canContinue && job?.startUrl) continueSection.classList.remove("hidden");
    else continueSection.classList.add("hidden");
  }

  const approval = document.getElementById("approval");
  if (approval) approval.classList.toggle("hidden", !job?.needsApproval);

  const passwordRequest = document.getElementById("passwordRequest");
  const otpRequest = document.getElementById("otpRequest");
  if (job?.status === "needs_verification" && job?.pending?.kind === "PASSWORD") {
    if (passwordRequest) passwordRequest.classList.remove("hidden");
    if (otpRequest) otpRequest.classList.add("hidden");
  } else if (job?.status === "needs_verification") {
    if (otpRequest) otpRequest.classList.remove("hidden");
    if (passwordRequest) passwordRequest.classList.add("hidden");
  } else {
    if (passwordRequest) passwordRequest.classList.add("hidden");
    if (otpRequest) otpRequest.classList.add("hidden");
  }
}

function updateLiveStep(stepData) {
  const liveStep = document.getElementById("liveStep");
  const liveStepContent = document.getElementById("liveStepContent");
  if (!liveStep || !liveStepContent) return;
  if (!stepData) {
    liveStep.classList.add("hidden");
    return;
  }
  liveStep.classList.remove("hidden");
  const pp = stepData.planProgress;
  let html = "";
  if (stepData.thinking) html += `<div style="margin-bottom:6px;font-style:italic;color:#6b7280">${escapeHtml(stepData.thinking)}</div>`;
  html += `<div><b>Step ${stepData.step}</b>: ${stepData.action?.type || "—"}`;
  if (stepData.action?.target) html += ` → ${escapeHtml(String(stepData.action.target))}`;
  if (stepData.confidence != null) html += ` (${Math.round(stepData.confidence * 100)}% conf)`;
  if (pp) html += `<br/><small>Plan: ${pp.currentStep}/${pp.totalSteps} ${pp.fieldName ? "- " + pp.fieldName : ""}</small>`;
  html += "</div>";
  liveStepContent.innerHTML = html;
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.getElementById("useCurrentTab")?.addEventListener("click", prefillCurrentTabUrl);

document.getElementById("start")?.addEventListener("click", async () => {
  const url = document.getElementById("url").value.trim();
  if (!url) {
    alert("Please enter a URL");
    return;
  }
  const mode = [...document.querySelectorAll("input[name='mode']")].find((r) => r.checked)?.value || "live";
  const jobId = uid();
  await chrome.storage.local.set({ activeJobId: jobId });
  const apiBase = await getApiBase();
  await chrome.storage.local.set({ apiBase });
  await setStatus(jobId, { status: "starting", step: 0, needsApproval: false, startUrl: url });
  chrome.runtime.sendMessage({ type: "START_JOB", jobId, startUrl: url, mode });
  refreshUI();
});

document.getElementById("continueJob")?.addEventListener("click", async () => {
  const jobId = await getActiveJob();
  if (!jobId) return;
  const job = await getJob(jobId);
  if (!job || !job.startUrl) {
    alert("No job URL found. Please start a new job.");
    return;
  }
  await setStatus(jobId, { ...job, status: "running", stop: false });
  chrome.runtime.sendMessage({ type: "RESUME_JOB", jobId });
  refreshUI();
});

document.getElementById("stop")?.addEventListener("click", async () => {
  const jobId = await getActiveJob();
  if (!jobId) return;
  chrome.runtime.sendMessage({ type: "STOP_JOB", jobId });
  await setStatus(jobId, { status: "stopping" });
  refreshUI();
});

document.getElementById("approve")?.addEventListener("click", async () => {
  const jobId = await getActiveJob();
  if (!jobId) return;
  chrome.runtime.sendMessage({ type: "APPROVE", jobId });
  await setStatus(jobId, { ...(await getJob(jobId)), needsApproval: false });
  refreshUI();
});

document.getElementById("sendOtp")?.addEventListener("click", async () => {
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

document.getElementById("sendPassword")?.addEventListener("click", async () => {
  const jobId = await getActiveJob();
  if (!jobId) return;
  const password = document.getElementById("passwordInput").value;
  if (!password) return;
  const apiBase = await getApiBase();
  await postJSON(`${apiBase}/api/agent/verify`, { jobId, code: password, kind: "PASSWORD" });
  chrome.runtime.sendMessage({ type: "RESUME_AFTER_VERIFICATION", jobId, code: password, kind: "PASSWORD" });
  document.getElementById("passwordInput").value = "";
  refreshUI();
});

// Session storage listener for live step updates
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.agentLiveStep) {
    updateLiveStep(changes.agentLiveStep.newValue);
  }
});

// Copilot tab
document.getElementById("copilotSummarize")?.addEventListener("click", async () => {
  const btn = document.getElementById("copilotSummarize");
  const loading = document.getElementById("copilotLoading");
  const result = document.getElementById("copilotResult");
  const pageInfo = document.getElementById("copilotPageInfo");

  btn.disabled = true;
  if (loading) loading.classList.remove("hidden");
  if (result) {
    result.classList.add("hidden");
    result.innerHTML = "";
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
      throw new Error("Cannot summarize this page");
    }
    if (pageInfo) {
      pageInfo.classList.remove("hidden");
      pageInfo.textContent = `Summarizing: ${tab.title || tab.url}`;
    }
    chrome.runtime.sendMessage({ type: "COPILOT_SUMMARIZE", tabId: tab.id });
  } catch (e) {
    if (loading) loading.classList.add("hidden");
    btn.disabled = false;
    if (result) {
      result.classList.remove("hidden");
      result.className = "copilot-result error";
      result.textContent = e.message || "Failed to summarize";
    }
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.copilotResult) {
    const loading = document.getElementById("copilotLoading");
    const result = document.getElementById("copilotResult");
    const btn = document.getElementById("copilotSummarize");

    if (loading) loading.classList.add("hidden");
    if (btn) btn.disabled = false;

    const data = changes.copilotResult.newValue;
    if (!result) return;
    result.classList.remove("hidden");
    if (data?.error) {
      result.className = "copilot-result error";
      result.textContent = data.error;
      return;
    }
    result.className = "copilot-result";
    let html = "";
    if (data?.title) html += `<h3>${escapeHtml(data.title)}</h3>`;
    if (data?.content) html += `<p>${escapeHtml(data.content)}</p>`;
    if (data?.keyPoints?.length) {
      html += "<ul>";
      data.keyPoints.forEach((p) => {
        html += `<li>${escapeHtml(p)}</li>`;
      });
      html += "</ul>";
    }
    result.innerHTML = html || "No content returned.";
  }
});

// Profile tab (from popup.js)
async function loadProfile() {
  const data = await chrome.storage.local.get([PROFILE_KEY]);
  const profile = data[PROFILE_KEY] || {};
  const custom = profile.custom || {};

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? "";
  };
  const setCheck = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!val;
  };

  set("profile-email", profile.email);
  set("profile-password", profile.password);
  setCheck("profile-preferOAuth", profile.preferOAuth);
  set("profile-firstName", profile.firstName);
  set("profile-lastName", profile.lastName);
  set("profile-phone", profile.phone);

  const genderEl = document.getElementById("profile-eeo-gender");
  const raceEl = document.getElementById("profile-eeo-raceEthnicity");
  const vetEl = document.getElementById("profile-eeo-veteranStatus");
  if (genderEl) genderEl.value = custom.gender || "";
  if (raceEl) raceEl.value = custom["race/ethnicity"] || custom.race || "";
  if (vetEl) vetEl.value = custom["veteran status"] || custom.veteran || "";

  const addr = profile.address || {};
  set("profile-street", addr.street);
  set("profile-street2", addr.street2);
  set("profile-city", addr.city);
  set("profile-state", addr.state);
  set("profile-zipCode", addr.zipCode);
  set("profile-country", addr.country);
  set("profile-company", profile.company);
  set("profile-jobTitle", profile.jobTitle);
  set("profile-linkedIn", profile.linkedIn);
  set("profile-github", profile.github);
  set("profile-website", profile.website);

  if (profile.resume) {
    const resumeEl = document.getElementById("profile-resume");
    if (resumeEl) resumeEl.value = profile.resume.rawText || JSON.stringify(profile.resume, null, 2);
  } else {
    set("profile-resume", "");
  }
  updateResumeFileDisplay(profile.resumeFile);
}

function updateResumeFileDisplay(resumeFile) {
  const fileNameEl = document.getElementById("resumeFileName");
  const removeBtn = document.getElementById("removeResumeFile");
  if (!fileNameEl) return;
  if (resumeFile?.name) {
    const sizeKB = Math.round(resumeFile.size / 1024);
    fileNameEl.textContent = `${resumeFile.name} (${sizeKB} KB)`;
    fileNameEl.classList.add("has-file");
    if (removeBtn) removeBtn.classList.remove("hidden");
  } else {
    fileNameEl.textContent = "No file selected";
    fileNameEl.classList.remove("has-file");
    if (removeBtn) removeBtn.classList.add("hidden");
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

document.getElementById("selectResumeFile")?.addEventListener("click", () => {
  document.getElementById("profile-resumeFile")?.click();
});

document.getElementById("profile-resumeFile")?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const validTypes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ];
  if (!validTypes.includes(file.type)) {
    showStatusMsg("profileStatus", "Please select a PDF or Word document", false);
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showStatusMsg("profileStatus", "File too large (max 5MB)", false);
    return;
  }
  try {
    const base64 = await readFileAsBase64(file);
    const data = await chrome.storage.local.get([PROFILE_KEY]);
    const profile = data[PROFILE_KEY] || {};
    profile.resumeFile = {
      name: file.name,
      type: file.type,
      size: file.size,
      base64,
      uploadedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    updateResumeFileDisplay(profile.resumeFile);
    showStatusMsg("profileStatus", "Resume file uploaded!", true);
  } catch (err) {
    showStatusMsg("profileStatus", "Failed to read file", false);
  }
});

document.getElementById("removeResumeFile")?.addEventListener("click", async () => {
  const data = await chrome.storage.local.get([PROFILE_KEY]);
  const profile = data[PROFILE_KEY] || {};
  delete profile.resumeFile;
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
  document.getElementById("profile-resumeFile").value = "";
  updateResumeFileDisplay(null);
  showStatusMsg("profileStatus", "Resume file removed", true);
});

function parseResumeInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object") {
        return {
          bio: parsed.bio || parsed.summary || parsed.objective,
          summary: parsed.summary || parsed.bio,
          experiences: parsed.experiences || parsed.experience || parsed.work,
          education: parsed.education,
          skills: Array.isArray(parsed.skills)
            ? parsed.skills
            : typeof parsed.skills === "string"
              ? parsed.skills.split(",").map((s) => s.trim())
              : undefined,
          certifications: parsed.certifications,
          languages: parsed.languages,
          rawText: trimmed,
        };
      }
    } catch {}
  }
  return { rawText: trimmed };
}

document.getElementById("saveProfile")?.addEventListener("click", async () => {
  const resumeInput = document.getElementById("profile-resume").value;
  const resume = parseResumeInput(resumeInput);
  const existingData = await chrome.storage.local.get([PROFILE_KEY]);
  const existingProfile = existingData[PROFILE_KEY] || {};
  const existingCustom = existingProfile.custom || {};
  const nextCustom = { ...existingCustom };
  const gender = document.getElementById("profile-eeo-gender")?.value || "";
  const raceEthnicity = document.getElementById("profile-eeo-raceEthnicity")?.value || "";
  const veteranStatus = document.getElementById("profile-eeo-veteranStatus")?.value || "";
  if (gender) nextCustom.gender = gender;
  else delete nextCustom.gender;
  if (raceEthnicity) nextCustom["race/ethnicity"] = raceEthnicity;
  else delete nextCustom["race/ethnicity"];
  if (veteranStatus) nextCustom["veteran status"] = veteranStatus;
  else delete nextCustom["veteran status"];

  const profile = {
    email: document.getElementById("profile-email").value.trim(),
    password: document.getElementById("profile-password").value,
    preferOAuth: document.getElementById("profile-preferOAuth").checked,
    firstName: document.getElementById("profile-firstName").value.trim(),
    lastName: document.getElementById("profile-lastName").value.trim(),
    phone: document.getElementById("profile-phone").value.trim(),
    address: {
      street: document.getElementById("profile-street").value.trim(),
      street2: document.getElementById("profile-street2").value.trim(),
      city: document.getElementById("profile-city").value.trim(),
      state: document.getElementById("profile-state").value.trim(),
      zipCode: document.getElementById("profile-zipCode").value.trim(),
      country: document.getElementById("profile-country").value.trim(),
    },
    company: document.getElementById("profile-company").value.trim(),
    jobTitle: document.getElementById("profile-jobTitle").value.trim(),
    linkedIn: document.getElementById("profile-linkedIn").value.trim(),
    github: document.getElementById("profile-github").value.trim(),
    website: document.getElementById("profile-website").value.trim(),
    resume,
    resumeFile: existingProfile.resumeFile,
    custom: nextCustom,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
  showStatusMsg("profileStatus", "Profile saved!", true);
});

document.getElementById("clearProfile")?.addEventListener("click", async () => {
  if (!confirm("Clear all profile data?")) return;
  await chrome.storage.local.remove([PROFILE_KEY]);
  await loadProfile();
  showStatusMsg("profileStatus", "Profile cleared", true);
});

// Settings tab
async function loadSettings() {
  const data = await chrome.storage.local.get([SETTINGS_KEY, "apiBase"]);
  const settings = data[SETTINGS_KEY] || {};
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? "";
  };
  set("settings-apiBase", data.apiBase || API_BASE_DEFAULT);
  set("settings-llmProvider", settings.llmProvider);
  set("settings-llmApiKey", settings.llmApiKey);
  set("settings-llmModel", settings.llmModel);
  set("settings-ollamaUrl", settings.ollamaUrl || "http://localhost:11434");

  const autopilotEl = document.getElementById("behavior-autopilotEnabled");
  const capEl = document.getElementById("behavior-capEnabled");
  const maxEl = document.getElementById("behavior-maxSteps");
  if (autopilotEl) autopilotEl.checked = settings.autopilotEnabled !== false;
  if (capEl) capEl.checked = settings.capEnabled !== false;
  if (maxEl) {
    maxEl.value = String(Number.isFinite(settings.maxSteps) ? settings.maxSteps : DEFAULT_MAX_STEPS);
    maxEl.disabled = !(settings.capEnabled !== false);
  }
  toggleOllamaSettings();
}

function toggleOllamaSettings() {
  const provider = document.getElementById("settings-llmProvider")?.value;
  const ollamaSettings = document.getElementById("ollamaSettings");
  if (ollamaSettings) ollamaSettings.classList.toggle("hidden", provider !== "ollama");
}

document.getElementById("settings-llmProvider")?.addEventListener("change", toggleOllamaSettings);

document.getElementById("saveSettings")?.addEventListener("click", async () => {
  const apiBase = document.getElementById("settings-apiBase").value.trim() || API_BASE_DEFAULT;
  const settings = {
    llmProvider: document.getElementById("settings-llmProvider").value,
    llmApiKey: document.getElementById("settings-llmApiKey").value.trim(),
    llmModel: document.getElementById("settings-llmModel").value.trim(),
    ollamaUrl: document.getElementById("settings-ollamaUrl").value.trim(),
    autopilotEnabled: document.getElementById("behavior-autopilotEnabled").checked,
    capEnabled: document.getElementById("behavior-capEnabled").checked,
    maxSteps: Math.max(
      1,
      parseInt(document.getElementById("behavior-maxSteps").value, 10) || DEFAULT_MAX_STEPS
    ),
  };
  await chrome.storage.local.set({ apiBase, [SETTINGS_KEY]: settings });
  const maxEl = document.getElementById("behavior-maxSteps");
  if (maxEl) maxEl.disabled = !settings.capEnabled;
  showStatusMsg("settingsStatus", "Settings saved!", true);
});

document.getElementById("behavior-capEnabled")?.addEventListener("change", () => {
  const cap = document.getElementById("behavior-capEnabled");
  const max = document.getElementById("behavior-maxSteps");
  if (max) max.disabled = !cap?.checked;
});

document.getElementById("exportProfile")?.addEventListener("click", async () => {
  const data = await chrome.storage.local.get([PROFILE_KEY]);
  const blob = new Blob([JSON.stringify(data[PROFILE_KEY] || {}, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vaulty-profile.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("viewStorage")?.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(null);
  console.log("Chrome Storage:", data);
  alert("Storage logged to console (F12)");
});

// Logs
function getActionTypeClass(action) {
  if (!action) return "error";
  const t = (action.type || "").toLowerCase();
  if (["fill", "click", "done", "extract", "request_verification"].includes(t)) return t;
  return "extract";
}

function getActionIcon(action) {
  const icons = {
    FILL: "✏️",
    CLICK: "👆",
    DONE: "✅",
    EXTRACT: "🔍",
    SELECT: "📋",
    CHECK: "☑️",
    NAVIGATE: "🔗",
    WAIT_FOR: "⏳",
    REQUEST_VERIFICATION: "🔐",
    ASK_USER: "🤔",
  };
  return icons[action?.type] || "▶️";
}

function formatActionSummary(action) {
  if (!action) return "Unknown";
  const t = action.target?.text || action.target?.selector || action.target?.index || "?";
  const v = action.value ? (action.value.length > 30 ? action.value.slice(0, 30) + "..." : action.value) : "";
  switch (action.type) {
    case "FILL":
      return `Fill "${t}" → "${v}"`;
    case "CLICK":
      return `Click "${t}"`;
    case "DONE":
      return action.summary || "Completed";
    case "EXTRACT":
      return `Extract ${action.mode || "data"}`;
    case "SELECT":
      return `Select "${action.value}" in ${t}`;
    case "CHECK":
      return `${action.checked ? "Check" : "Uncheck"} ${t}`;
    case "REQUEST_VERIFICATION":
      return `Verification: ${action.kind || "?"}`;
    case "WAIT_FOR":
      return `Wait for "${t}"`;
    case "NAVIGATE":
      return `Navigate to ${action.url || "?"}`;
    case "ASK_USER":
      return `Ask: ${(action.question || "").slice(0, 50)}...`;
    default:
      return action.type || "Unknown";
  }
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderLogEntry(log) {
  const typeClass =
    log.type === "error" || log.type === "fatal_error" || log.type === "exec_error"
      ? "error"
      : log.type === "ask_user" || log.type === "user_response"
        ? "verify"
        : getActionTypeClass(log.action);
  const icon =
    log.type === "error" || log.type === "fatal_error"
      ? "❌"
      : log.type === "ask_user"
        ? "🤔"
        : log.type === "user_response"
          ? "💬"
          : getActionIcon(log.action);
  const summary = log.message || formatActionSummary(log.action);
  let details = "";
  if (log.thinking)
    details += `<div class="log-section"><div class="log-section-title">Thinking</div><div class="log-section-content">${escapeHtml(log.thinking)}</div></div>`;
  if (typeof log.confidence === "number")
    details += `<div class="log-section"><div class="log-section-title">Confidence</div><div class="log-section-content">${Math.round(log.confidence * 100)}%</div></div>`;
  if (log.action)
    details += `<div class="log-section"><div class="log-section-title">Action</div><div class="log-section-content json">${escapeHtml(JSON.stringify(log.action, null, 2))}</div></div>`;
  if (log.error)
    details += `<div class="log-section"><div class="log-section-title">Error</div><div class="log-section-content" style="color:#991b1b">${escapeHtml(log.error)}</div></div>`;

  return `
    <div class="log-entry">
      <div class="log-header">
        <span class="log-step">#${log.step}</span>
        <span class="log-action"><span class="log-action-type ${typeClass}">${icon} ${log.action?.type || log.type || "?"}</span> ${escapeHtml(summary)}</span>
        <span class="log-time">${formatTime(log.timestamp)}</span>
        <span class="log-expand">▼</span>
      </div>
      <div class="log-details">${details || '<div class="log-section-content">No details</div>'}</div>
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
      container.innerHTML = '<div class="logs-empty">No logs yet. Start the agent.</div>';
      return;
    }
    const reversed = [...logs].reverse();
    container.innerHTML = reversed.map(renderLogEntry).join("");
    container.querySelectorAll(".log-header").forEach((h) => {
      h.addEventListener("click", () => h.closest(".log-entry")?.classList.toggle("expanded"));
    });
  } catch (e) {
    container.innerHTML = `<div class="logs-empty">Error: ${e.message}</div>`;
  }
}

document.getElementById("refreshLogs")?.addEventListener("click", loadLogs);
document.getElementById("clearLogs")?.addEventListener("click", async () => {
  if (!confirm("Clear all logs?")) return;
  await chrome.storage.local.set({ [LOGS_KEY]: [] });
  loadLogs();
});
document.getElementById("exportLogs")?.addEventListener("click", async () => {
  const data = await chrome.storage.local.get([LOGS_KEY]);
  const blob = new Blob([JSON.stringify(data[LOGS_KEY] || [], null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `vaulty-logs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// Init
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  refreshUI();
  if (changes[LOGS_KEY]) {
    const applyTab = document.querySelector('.tab[data-tab="apply"]');
    if (applyTab?.classList.contains("active")) loadLogs();
  }
});

(async () => {
  await refreshUI();
  await loadProfile();
  await loadSettings();
  await loadLogs();
  const urlInput = document.getElementById("url");
  if (urlInput && !urlInput.value) await prefillCurrentTabUrl();
})();
