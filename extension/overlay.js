(function () {
  function isBlockedProtocol() {
    const p = location.protocol;
    return (
      p === "chrome:" ||
      p === "chrome-extension:" ||
      p === "chrome-search:" ||
      p === "chrome-untrusted:" ||
      p === "about:" ||
      p === "edge:" ||
      p === "brave:" ||
      p === "moz-extension:"
    );
  }

  function init() {
    // Don't inject on internal/protected pages
    if (isBlockedProtocol()) return;

    // Wait for body to exist
    if (!document.body) return;

  const id = "agent-hud";
  if (document.getElementById(id)) return;

  // Create HUD using DOM APIs (avoids TrustedTypes issues)
  const hud = document.createElement("div");
  hud.id = id;
  hud.style.cssText = `
    position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;
    width: 280px; border-radius: 12px; padding: 10px 12px;
    background: rgba(17,24,39,.95); color: white; font-family: system-ui, -apple-system, sans-serif;
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
    font-size: 12px;
    pointer-events: none;
  `;

  // Header row
  const headerRow = document.createElement("div");
  headerRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;";

  const titleEl = document.createElement("div");
  titleEl.style.cssText = "font-weight:600;display:flex;align-items:center;gap:6px;";
  titleEl.textContent = "🤖 Vaulty Agent";

  const urlEl = document.createElement("div");
  urlEl.id = "agent-url";
  urlEl.style.cssText = "opacity:.6;font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  urlEl.textContent = location.host || "…";

  headerRow.appendChild(titleEl);
  headerRow.appendChild(urlEl);

  // Action row
  const actionEl = document.createElement("div");
  actionEl.id = "agent-action";
  actionEl.style.cssText = "margin-top:8px;opacity:.85;";
  actionEl.textContent = "⏳ Waiting...";

  hud.appendChild(headerRow);
  hud.appendChild(actionEl);

  try {
    document.body.appendChild(hud);
  } catch (e) {
    console.warn("[Vaulty Agent] Could not inject HUD:", e);
    return;
  }

  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.source !== "agent") return;
    if (ev.data.type === "ACTION") {
      const a = ev.data.action;
      const urlDisplay = document.getElementById("agent-url");
      const actDisplay = document.getElementById("agent-action");
      if (urlDisplay) urlDisplay.textContent = location.host || "site";
      if (actDisplay) {
        const icons = {
          FILL: "✏️",
          CLICK: "👆",
          SELECT: "📋",
          CHECK: "☑️",
          NAVIGATE: "🔗",
          WAIT_FOR: "⏳",
          EXTRACT: "🔍",
          REQUEST_VERIFICATION: "🔐",
          DONE: "✅"
        };
        const icon = icons[a.type] || "▶️";
        if (a.type === "DONE" && a.summary) {
          actDisplay.textContent = `${icon} DONE: ${String(a.summary).slice(0, 120)}`;
        } else if (a.type === "REQUEST_VERIFICATION") {
          const hint = a?.context?.hint ? `: ${String(a.context.hint).slice(0, 120)}` : "";
          actDisplay.textContent = `${icon} VERIFY${hint}`;
        } else {
          actDisplay.textContent = `${icon} ${a.type}`;
        }
      }
    }
  });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
