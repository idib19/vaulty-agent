const API_BASE_DEFAULT = "https://agent.vaulty.ca";
const PROFILE_KEY = "userProfile";

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

async function postJSON(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "Something went wrong. Please try again.");
  }
  return res.json().catch(() => ({}));
}

async function getApiBase() {
  const { apiBase } = await chrome.storage.local.get(["apiBase"]);
  return apiBase || API_BASE_DEFAULT;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function showAuthScreen() {
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("main-app").classList.add("hidden");
}

function showMainApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("main-app").classList.remove("hidden");
}

function setAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function setAuthErrorHtml(html) {
  const el = document.getElementById("auth-error");
  if (!el) return;
  el.innerHTML = html;
  el.classList.toggle("hidden", !html);
}

async function validateToken(token) {
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function tryRefresh() {
  const { refreshToken } = await chrome.storage.local.get(["refreshToken"]);
  if (!refreshToken) return false;
  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    await chrome.storage.local.set({
      authToken: data.accessToken,
      refreshToken: data.refreshToken,
      authTokenExpiry: data.expiresAt,
    });
    return true;
  } catch {
    return false;
  }
}

async function initAuth() {
  const { authToken } = await chrome.storage.local.get(["authToken"]);
  if (!authToken) {
    showAuthScreen();
    return;
  }
  const valid = await validateToken(authToken);
  if (valid) {
    showMainApp();
    return;
  }
  const refreshed = await tryRefresh();
  if (refreshed) {
    showMainApp();
  } else {
    await chrome.storage.local.remove(["authToken", "refreshToken", "authTokenExpiry", "authUser"]);
    showAuthScreen();
  }
}

document.getElementById("auth-submit")?.addEventListener("click", async () => {
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  const btn = document.getElementById("auth-submit");

  if (!email || !password) {
    setAuthError("Please enter your email and password.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Signing in…";
  setAuthError("");

  try {
    const apiBase = await getApiBase();
    const res = await fetch(`${apiBase}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (res.status === 403 && data.error === "subscription_required") {
      const url = data.upgradeUrl || "https://vaulty.ca/plans";
      setAuthErrorHtml(`Upgrade to Pro to use Vaulty. <a href="${url}" target="_blank" rel="noopener">View plans</a>`);
      return;
    }
    if (!res.ok) {
      setAuthError(data.message || "Sign in failed. Please check your credentials and try again.");
      return;
    }

    await chrome.storage.local.set({
      authToken: data.accessToken,
      refreshToken: data.refreshToken,
      authTokenExpiry: data.expiresAt,
      authUser: data.user,
    });

    showMainApp();
    await loadProfile();
    await loadSettings();
  } catch {
    setAuthError("Connection error. Check the Backend URL in Settings.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In";
  }
});

document.getElementById("auth-password")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("auth-submit")?.click();
});

document.getElementById("auth-logout")?.addEventListener("click", async () => {
  const { authToken } = await chrome.storage.local.get(["authToken"]);
  if (authToken) {
    try {
      const apiBase = await getApiBase();
      await fetch(`${apiBase}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${authToken}` },
      });
    } catch { /* best-effort */ }
  }
  await chrome.storage.local.remove(["authToken", "refreshToken", "authTokenExpiry", "authUser"]);
  showAuthScreen();
});

// Listen for background script events
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "AUTH_EXPIRED") {
    chrome.storage.local.remove(["authToken", "refreshToken", "authTokenExpiry", "authUser"]);
    showAuthScreen();
  }
  if (msg.type === "RATE_LIMITED") {
    setFillStatus("error", msg.message || "Daily limit reached. Try again tomorrow.");
  }
});

function showStatusMsg(elementId, message, isSuccess = true) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.className = `status-msg ${isSuccess ? "success" : "error"}`;
  setTimeout(() => {
    el.textContent = "";
  }, 3000);
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Tab navigation
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    const content = document.getElementById(`tab-${tab.dataset.tab}`);
    if (content) content.classList.add("active");
  });
});

// ── Copilot tab ───────────────────────────────────────────────────────────────

document.getElementById("copilotSummarize")?.addEventListener("click", async () => {
  const btn = document.getElementById("copilotSummarize");
  const loading = document.getElementById("copilotLoading");
  const result = document.getElementById("copilotResult");
  const pageInfo = document.getElementById("copilotPageInfo");

  btn.disabled = true;
  document.querySelector('.copilot-action-wrap')?.classList.add('has-content');
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
    document.querySelector('.copilot-action-wrap')?.classList.add('has-content');
    if (loading) loading.classList.add("hidden");
    btn.disabled = false;
    if (result) {
      result.classList.remove("hidden");
      result.className = "copilot-result error";
      result.textContent = e.message || "Could not summarize this page. Please try again.";
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
      result.textContent = data.message || data.error;
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

// ── Profile tab ───────────────────────────────────────────────────────────────

function populateProfileForm(profile) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? "";
  };
  set("profile-firstName", profile.firstName);
  set("profile-lastName", profile.lastName);
  set("profile-email", profile.email);
  set("profile-phone", profile.phone);

  set("profile-gender", profile.gender);
  set("profile-raceEthnicity", profile.raceEthnicity);
  set("profile-veteranStatus", profile.veteranStatus);

  const addr = profile.address || {};
  set("profile-street", addr.street);
  set("profile-street2", addr.street2);
  set("profile-city", addr.city);
  set("profile-state", addr.state);
  set("profile-zipCode", addr.zipCode);
  set("profile-country", addr.country);

  set("profile-linkedIn", profile.linkedIn);
  set("profile-website", profile.website);
}

async function loadProfile() {
  // Try fetching from server first; fall back to local cache
  try {
    const apiBase = await getApiBase();
    const { authToken } = await chrome.storage.local.get(["authToken"]);
    if (authToken) {
      const res = await fetch(`${apiBase}/api/profile`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        const profile = data.profile || {};
        await chrome.storage.local.set({ [PROFILE_KEY]: profile });
        populateProfileForm(profile);
        return;
      }
    }
  } catch { /* server unreachable, use cache */ }

  const data = await chrome.storage.local.get([PROFILE_KEY]);
  populateProfileForm(data[PROFILE_KEY] || {});
}

function buildProfileFromForm() {
  const val = (id) => document.getElementById(id)?.value?.trim() || "";
  return {
    firstName: val("profile-firstName"),
    lastName: val("profile-lastName"),
    email: val("profile-email"),
    phone: val("profile-phone"),
    gender: val("profile-gender"),
    raceEthnicity: val("profile-raceEthnicity"),
    veteranStatus: val("profile-veteranStatus"),
    address: {
      street: val("profile-street"),
      street2: val("profile-street2"),
      city: val("profile-city"),
      state: val("profile-state"),
      zipCode: val("profile-zipCode"),
      country: val("profile-country"),
    },
    linkedIn: val("profile-linkedIn"),
    website: val("profile-website"),
  };
}

document.getElementById("saveProfile")?.addEventListener("click", async () => {
  const profile = buildProfileFromForm();
  const btn = document.getElementById("saveProfile");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    const apiBase = await getApiBase();
    const { authToken } = await chrome.storage.local.get(["authToken"]);
    if (authToken) {
      const res = await fetch(`${apiBase}/api/profile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ profile }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Could not save profile.");
      }
      const data = await res.json();
      await chrome.storage.local.set({ [PROFILE_KEY]: data.profile || profile });
      showStatusMsg("profileStatus", "Profile saved!", true);
    } else {
      await chrome.storage.local.set({ [PROFILE_KEY]: profile });
      showStatusMsg("profileStatus", "Profile saved locally (not signed in).", true);
    }
  } catch (err) {
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    showStatusMsg("profileStatus", err.message || "Saved locally. Server sync failed.", false);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Profile";
  }
});

document.getElementById("clearProfile")?.addEventListener("click", async () => {
  if (!confirm("Clear all profile data?")) return;
  try {
    const apiBase = await getApiBase();
    const { authToken } = await chrome.storage.local.get(["authToken"]);
    if (authToken) {
      await fetch(`${apiBase}/api/profile`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken}` },
      });
    }
  } catch { /* best-effort */ }
  await chrome.storage.local.remove([PROFILE_KEY]);
  populateProfileForm({});
  showStatusMsg("profileStatus", "Profile cleared", true);
});

// ── Settings tab ──────────────────────────────────────────────────────────────

async function loadSettings() {
  const data = await chrome.storage.local.get(["apiBase"]);
  const apiBaseEl = document.getElementById("settings-apiBase");
  if (apiBaseEl) apiBaseEl.value = data.apiBase || API_BASE_DEFAULT;
}

document.getElementById("saveSettings")?.addEventListener("click", async () => {
  const apiBase = document.getElementById("settings-apiBase").value.trim() || API_BASE_DEFAULT;
  await chrome.storage.local.set({ apiBase });
  showStatusMsg("settingsStatus", "Settings saved!", true);
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

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  await initAuth();
  // loadProfile and loadSettings are called inside showMainApp path (initAuth / login handler)
  // but also run here as a fallback in case already authenticated on startup
  const { authToken } = await chrome.storage.local.get(["authToken"]);
  if (authToken) {
    await loadProfile();
    await loadSettings();
  }
})();

// ── Apply tab ─────────────────────────────────────────────────────────────────

const FILL_STATUS_MAP = {
  idle:      { icon: "💤", text: "Ready. Open a form page and click Fill." },
  analyzing: { icon: "🔍", text: "Analyzing form fields with AI…" },
  filling:   { icon: "✍️",  text: "Filling in your details…" },
  done:      { icon: "✅", text: "Done! Form has been filled." },
  error:     { icon: "❌", text: "Something went wrong." },
};

function setFillStatus(status, message) {
  const s = FILL_STATUS_MAP[status] || FILL_STATUS_MAP.idle;
  const iconEl = document.getElementById("status-icon");
  const textEl = document.getElementById("status-text");
  const btn    = document.getElementById("btn-fill");
  if (iconEl) iconEl.textContent = s.icon;
  if (textEl) textEl.textContent = message || s.text;
  if (btn)    btn.disabled = status === "analyzing" || status === "filling";
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status_update") {
    setFillStatus(msg.status, msg.message);
  }
});

document.getElementById("btn-fill")?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  setFillStatus("analyzing");

  chrome.runtime.sendMessage({ type: "start_fill", tabId: tab.id }, (res) => {
    if (res?.error) setFillStatus("error", res.error);
  });
});
