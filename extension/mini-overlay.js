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

  const POSITION_KEY = "vaulty-mini-overlay-position";
  const ICON_SIZE = 40;

  let currentStep = 0;
  let isActive = false;
  let appState = { phase: "navigating", progress: 0 };

  function getSavedPosition() {
    try {
      const saved = localStorage.getItem(POSITION_KEY);
      if (saved) {
        const pos = JSON.parse(saved);
        if (typeof pos.x === "number" && typeof pos.y === "number") {
          return pos;
        }
      }
    } catch (e) {}
    return null;
  }

  function savePosition(x, y) {
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify({ x, y }));
    } catch (e) {}
  }

  function clampPosition(x, y) {
    const maxX = window.innerWidth - ICON_SIZE - 8;
    const maxY = window.innerHeight - ICON_SIZE - 8;
    return {
      x: Math.max(8, Math.min(x, maxX)),
      y: Math.max(8, Math.min(y, maxY)),
    };
  }

  function updateBadge() {
    const badge = document.getElementById("vaulty-mini-badge");
    if (!badge) return;
    if (isActive && currentStep > 0) {
      badge.textContent = String(currentStep);
      badge.style.display = "flex";
      badge.style.animation = "vaulty-mini-pulse 1.5s ease-in-out infinite";
    } else {
      badge.style.display = "none";
      badge.style.animation = "none";
    }
  }

  function init() {
    if (isBlockedProtocol()) return;
    if (!document.body) return;

    const id = "vaulty-mini-overlay";
    if (document.getElementById(id)) return;

    const savedPos = getSavedPosition();
    const defaultX = window.innerWidth - ICON_SIZE - 16;
    const defaultY = window.innerHeight - ICON_SIZE - 16;
    const initialX = savedPos ? savedPos.x : defaultX;
    const initialY = savedPos ? savedPos.y : defaultY;

    const style = document.createElement("style");
    style.textContent = `
      @keyframes vaulty-mini-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }
    `;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = id;
    root.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      left: ${initialX}px;
      top: ${initialY}px;
      width: ${ICON_SIZE}px;
      height: ${ICON_SIZE}px;
      border-radius: 50%;
      background: rgba(99, 102, 241, 0.85);
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 2px 12px rgba(99, 102, 241, 0.5);
      font-family: system-ui, -apple-system, sans-serif;
      font-weight: 700;
      font-size: 16px;
      user-select: none;
      transition: background 0.2s, transform 0.15s;
    `;
    root.innerHTML = `
      <span id="vaulty-mini-icon" style="line-height:1;">V</span>
      <span id="vaulty-mini-badge" style="
        position: absolute;
        top: -4px;
        right: -4px;
        min-width: 18px;
        height: 18px;
        padding: 0 4px;
        background: #22c55e;
        border-radius: 9px;
        font-size: 11px;
        display: none;
        align-items: center;
        justify-content: center;
      "></span>
    `;

    root.addEventListener("mouseenter", () => {
      root.style.background = "rgba(99, 102, 241, 1)";
      root.style.transform = "scale(1.08)";
    });
    root.addEventListener("mouseleave", () => {
      root.style.background = "rgba(99, 102, 241, 0.85)";
      root.style.transform = "scale(1)";
    });

    root.addEventListener("click", () => {
      window.postMessage({ source: "agent-mini-overlay", type: "TOGGLE_SIDE_PANEL" }, "*");
    });

    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let elemStartX = 0;
    let elemStartY = 0;

    root.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      elemStartX = root.offsetLeft;
      elemStartY = root.offsetTop;
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      const clamped = clampPosition(elemStartX + dx, elemStartY + dy);
      root.style.left = clamped.x + "px";
      root.style.top = clamped.y + "px";
    });

    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        const clamped = clampPosition(parseFloat(root.style.left) || 0, parseFloat(root.style.top) || 0);
        savePosition(clamped.x, clamped.y);
      }
    });

    window.addEventListener("message", (ev) => {
      if (!ev.data || ev.data.source !== "agent") return;

      if (ev.data.type === "ACTION") {
        currentStep = ev.data.step ?? currentStep;
        isActive = ev.data.action?.type !== "DONE";
        updateBadge();
      }

      if (ev.data.type === "STATE_UPDATE") {
        const state = ev.data.state;
        if (state) {
          appState = {
            phase: state.progress?.phase || "navigating",
            progress: state.progress?.estimatedProgress || 0,
          };
          isActive = appState.phase !== "completed";
          updateBadge();
        }
      }
    });

    document.body.appendChild(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
