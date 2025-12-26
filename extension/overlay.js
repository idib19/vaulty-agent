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

  // State
  let currentThinking = "";
  let currentConfidence = 0.7;
  let currentAction = null;
  let isPaused = false;
  let showingElements = false;
  
  // Application state for progress display
  let appState = {
    phase: "navigating",
    progress: 0,
    jobTitle: "",
    company: "",
    fieldsFilledCount: 0
  };
  
  // Helper to get phase icon
  function getPhaseIcon(phase) {
    const icons = {
      navigating: "📍",
      logging_in: "🔐",
      filling_form: "📝",
      reviewing: "👁️",
      submitting: "🚀",
      completed: "✅"
    };
    return icons[phase] || "⏳";
  }
  
  // Helper to get phase label
  function getPhaseLabel(phase) {
    const labels = {
      navigating: "Navigating",
      logging_in: "Logging in",
      filling_form: "Filling form",
      reviewing: "Reviewing",
      submitting: "Submitting",
      completed: "Done!"
    };
    return labels[phase] || "Working";
  }
  
  // Update status bar content (global so handleMessage can call it)
  function updateStatusBar() {
    const statusBar = document.getElementById("agent-status-bar");
    if (!statusBar) return;
    
    const icon = getPhaseIcon(appState.phase);
    const label = getPhaseLabel(appState.phase);
    const progress = appState.progress || 0;
    
    let statusText = `${icon} ${label}`;
    if (appState.phase === "filling_form" && appState.fieldsFilledCount > 0) {
      statusText += ` (${appState.fieldsFilledCount} fields)`;
    }
    statusText += ` ${progress}%`;
    
    statusBar.innerHTML = `
      <span style="font-size: 14px;">🤖</span>
      <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ffffff;">${statusText}</span>
    `;
  }
  
  // Drag state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let hudStartX = 0;
  let hudStartY = 0;
  
  const HUD_POSITION_KEY = "vaulty-hud-position";
  
  function getSavedPosition() {
    try {
      const saved = localStorage.getItem(HUD_POSITION_KEY);
      if (saved) {
        const pos = JSON.parse(saved);
        // Validate position is within viewport
        if (typeof pos.x === "number" && typeof pos.y === "number") {
          return pos;
        }
      }
    } catch (e) {}
    return null;
  }
  
  function savePosition(x, y) {
    try {
      localStorage.setItem(HUD_POSITION_KEY, JSON.stringify({ x, y }));
    } catch (e) {}
  }
  
  function clampPosition(x, y, hudWidth, hudHeight) {
    const maxX = window.innerWidth - hudWidth - 8;
    const maxY = window.innerHeight - hudHeight - 8;
    return {
      x: Math.max(8, Math.min(x, maxX)),
      y: Math.max(8, Math.min(y, maxY))
    };
  }

  function init() {
    if (isBlockedProtocol()) return;
    if (!document.body) return;

    const id = "agent-hud";
    if (document.getElementById(id)) return;

    // Create main HUD container
    const hud = document.createElement("div");
    hud.id = id;
    
    // Get saved position or use default (bottom-right)
    const savedPos = getSavedPosition();
    const defaultX = window.innerWidth - 320 - 16;
    const defaultY = window.innerHeight - 300 - 16; // Approximate height
    const initialX = savedPos ? savedPos.x : defaultX;
    const initialY = savedPos ? savedPos.y : defaultY;
    
    hud.style.cssText = `
      position: fixed; z-index: 2147483647;
      left: ${initialX}px; top: ${initialY}px;
      width: 320px; border-radius: 14px;
      background: rgba(15, 23, 42, 0.98); color: #ffffff;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 10px 40px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.15);
      font-size: 13px;
      overflow: hidden;
    `;

    // Header with controls (also serves as drag handle)
    const header = document.createElement("div");
    header.id = "agent-hud-header";
    header.style.cssText = `
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px;
      background: rgba(255,255,255,.05);
      border-bottom: 1px solid rgba(255,255,255,.1);
      cursor: move;
      user-select: none;
    `;
    
    // Drag handlers
    header.addEventListener("mousedown", (e) => {
      // Don't drag if clicking on buttons
      if (e.target.tagName === "BUTTON") return;
      
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      hudStartX = hud.offsetLeft;
      hudStartY = hud.offsetTop;
      
      // Prevent text selection while dragging
      e.preventDefault();
    });
    
    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - dragStartX;
      const deltaY = e.clientY - dragStartY;
      
      const newX = hudStartX + deltaX;
      const newY = hudStartY + deltaY;
      
      const clamped = clampPosition(newX, newY, hud.offsetWidth, hud.offsetHeight);
      
      hud.style.left = clamped.x + "px";
      hud.style.top = clamped.y + "px";
    });
    
    document.addEventListener("mouseup", () => {
      if (isDragging) {
        isDragging = false;
        // Save position when drag ends
        savePosition(hud.offsetLeft, hud.offsetTop);
      }
    });
    
    // Reposition on window resize to keep in bounds
    window.addEventListener("resize", () => {
      const clamped = clampPosition(hud.offsetLeft, hud.offsetTop, hud.offsetWidth, hud.offsetHeight);
      hud.style.left = clamped.x + "px";
      hud.style.top = clamped.y + "px";
    });

    // Title section (shown when expanded)
    const titleEl = document.createElement("div");
    titleEl.id = "agent-hud-title";
    titleEl.style.cssText = "font-weight: 600; display: flex; align-items: center; gap: 8px; color: #ffffff;";
    titleEl.innerHTML = `<span style="font-size: 16px;">🤖</span> <span style="color: #ffffff;">Vaulty Agent</span>`;
    
    // Compact status bar (shown when minimized)
    const statusBar = document.createElement("div");
    statusBar.id = "agent-status-bar";
    statusBar.style.cssText = `
      display: none;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #e2e8f0;
      flex: 1;
      overflow: hidden;
    `;
    
    // Initialize status bar content
    updateStatusBar();

    const controls = document.createElement("div");
    controls.style.cssText = "display: flex; gap: 6px; flex-shrink: 0;";

    const pauseBtn = document.createElement("button");
    pauseBtn.id = "agent-pause-btn";
    pauseBtn.textContent = "⏸";
    pauseBtn.title = "Pause agent";
    pauseBtn.style.cssText = `
      background: rgba(255,255,255,.1); border: none; border-radius: 6px;
      width: 28px; height: 28px; cursor: pointer; font-size: 12px;
      transition: background 0.15s;
    `;
    pauseBtn.onmouseenter = () => pauseBtn.style.background = "rgba(255,255,255,.2)";
    pauseBtn.onmouseleave = () => pauseBtn.style.background = "rgba(255,255,255,.1)";
    pauseBtn.onclick = () => {
      isPaused = !isPaused;
      pauseBtn.textContent = isPaused ? "▶" : "⏸";
      pauseBtn.title = isPaused ? "Resume agent" : "Pause agent";
      window.postMessage({ source: "agent-hud", type: "PAUSE_TOGGLE", paused: isPaused }, "*");
    };

    const minimizeBtn = document.createElement("button");
    minimizeBtn.id = "agent-minimize-btn";
    minimizeBtn.textContent = "−";
    minimizeBtn.title = "Minimize";
    minimizeBtn.style.cssText = pauseBtn.style.cssText;
    minimizeBtn.onmouseenter = () => minimizeBtn.style.background = "rgba(255,255,255,.2)";
    minimizeBtn.onmouseleave = () => minimizeBtn.style.background = "rgba(255,255,255,.1)";
    
    let minimized = false;
    minimizeBtn.onclick = () => {
      minimized = !minimized;
      const content = document.getElementById("agent-hud-content");
      const title = document.getElementById("agent-hud-title");
      const status = document.getElementById("agent-status-bar");
      
      if (minimized) {
        // Collapse: hide content, show status bar
        if (content) content.style.display = "none";
        if (title) title.style.display = "none";
        if (status) {
          updateStatusBar();
          status.style.display = "flex";
        }
        minimizeBtn.textContent = "+";
        minimizeBtn.title = "Expand";
        // Make HUD narrower when minimized
        hud.style.width = "auto";
        hud.style.minWidth = "180px";
        hud.style.maxWidth = "280px";
      } else {
        // Expand: show content, hide status bar
        if (content) content.style.display = "block";
        if (title) title.style.display = "flex";
        if (status) status.style.display = "none";
        minimizeBtn.textContent = "−";
        minimizeBtn.title = "Minimize";
        // Restore full width
        hud.style.width = "320px";
        hud.style.minWidth = "";
        hud.style.maxWidth = "";
      }
    };

    controls.appendChild(pauseBtn);
    controls.appendChild(minimizeBtn);
    header.appendChild(titleEl);
    header.appendChild(statusBar);
    header.appendChild(controls);

    // Main content area
    const content = document.createElement("div");
    content.id = "agent-hud-content";
    content.style.cssText = "padding: 12px 14px;";

    // Thinking section
    const thinkingSection = document.createElement("div");
    thinkingSection.id = "agent-thinking-section";
    thinkingSection.style.cssText = `
      background: rgba(99, 102, 241, 0.15);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 10px;
      display: none;
    `;
    
    const thinkingLabel = document.createElement("div");
    thinkingLabel.style.cssText = "font-size: 11px; margin-bottom: 4px; display: flex; align-items: center; gap: 4px; color: #e2e8f0; font-weight: 500;";
    thinkingLabel.innerHTML = `<span>💭</span> <span style="color: #e2e8f0;">Thinking</span>`;
    
    const thinkingText = document.createElement("div");
    thinkingText.id = "agent-thinking-text";
    thinkingText.style.cssText = "font-size: 12px; line-height: 1.5; color: #f1f5f9;";
    
    thinkingSection.appendChild(thinkingLabel);
    thinkingSection.appendChild(thinkingText);

    // Action section
    const actionSection = document.createElement("div");
    actionSection.style.cssText = "margin-bottom: 10px;";
    
    const actionEl = document.createElement("div");
    actionEl.id = "agent-action";
    actionEl.style.cssText = `
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px;
      background: rgba(255,255,255,.08);
      border-radius: 8px;
      color: #ffffff;
    `;
    actionEl.innerHTML = `<span style="font-size: 14px;">⏳</span> <span style="color: #ffffff; font-weight: 500;">Waiting...</span>`;
    
    actionSection.appendChild(actionEl);

    // Confidence bar
    const confidenceSection = document.createElement("div");
    confidenceSection.id = "agent-confidence-section";
    confidenceSection.style.cssText = "margin-bottom: 12px; display: none;";
    
    const confidenceLabel = document.createElement("div");
    confidenceLabel.style.cssText = "font-size: 11px; margin-bottom: 4px; color: #e2e8f0; font-weight: 500;";
    confidenceLabel.textContent = "Confidence";
    
    const confidenceBar = document.createElement("div");
    confidenceBar.style.cssText = `
      height: 6px;
      background: rgba(255,255,255,.1);
      border-radius: 3px;
      overflow: hidden;
    `;
    
    const confidenceFill = document.createElement("div");
    confidenceFill.id = "agent-confidence-fill";
    confidenceFill.style.cssText = `
      height: 100%;
      width: 70%;
      background: linear-gradient(90deg, #22c55e, #84cc16);
      border-radius: 3px;
      transition: width 0.3s ease, background 0.3s ease;
    `;
    
    confidenceBar.appendChild(confidenceFill);
    confidenceSection.appendChild(confidenceLabel);
    confidenceSection.appendChild(confidenceBar);

    // Quick actions
    const quickActions = document.createElement("div");
    quickActions.style.cssText = "display: flex; gap: 8px;";

    const showElementsBtn = document.createElement("button");
    showElementsBtn.id = "agent-show-elements-btn";
    showElementsBtn.textContent = "👁 Show what I see";
    showElementsBtn.style.cssText = `
      flex: 1;
      background: rgba(255,255,255,.12);
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 8px;
      padding: 8px 12px;
      color: #ffffff;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    `;
    showElementsBtn.onmouseenter = () => showElementsBtn.style.background = "rgba(255,255,255,.2)";
    showElementsBtn.onmouseleave = () => showElementsBtn.style.background = "rgba(255,255,255,.12)";
    showElementsBtn.onclick = () => {
      showingElements = !showingElements;
      showElementsBtn.textContent = showingElements ? "👁 Hide elements" : "👁 Show what I see";
      window.postMessage({ source: "agent-hud", type: "TOGGLE_HIGHLIGHTS", show: showingElements }, "*");
    };

    const helpBtn = document.createElement("button");
    helpBtn.id = "agent-help-btn";
    helpBtn.textContent = "❓ Need help?";
    helpBtn.style.cssText = showElementsBtn.style.cssText;
    helpBtn.onmouseenter = () => helpBtn.style.background = "rgba(255,255,255,.15)";
    helpBtn.onmouseleave = () => helpBtn.style.background = "rgba(255,255,255,.08)";
    helpBtn.onclick = () => {
      window.postMessage({ source: "agent-hud", type: "REQUEST_HELP" }, "*");
    };

    quickActions.appendChild(showElementsBtn);
    quickActions.appendChild(helpBtn);

    // Assemble content
    content.appendChild(thinkingSection);
    content.appendChild(actionSection);
    content.appendChild(confidenceSection);
    content.appendChild(quickActions);

    // Assemble HUD
    hud.appendChild(header);
    hud.appendChild(content);

    try {
      document.body.appendChild(hud);
    } catch (e) {
      console.warn("[Vaulty Agent] Could not inject HUD:", e);
      return;
    }

    // Listen for messages from content script
    window.addEventListener("message", handleMessage);
  }

  function handleMessage(ev) {
    if (!ev.data || ev.data.source !== "agent") return;

    if (ev.data.type === "ACTION") {
      const data = ev.data;
      updateAction(data.action, data.thinking, data.confidence, data.fieldName, data.planProgress);
    }

    if (ev.data.type === "ASK_USER") {
      showAskUserModal(ev.data.question, ev.data.options, ev.data.allowCustom, ev.data.actionId);
    }

    if (ev.data.type === "CLOSE_MODAL") {
      closeAskUserModal();
    }
    
    // Handle application state updates for progress display
    if (ev.data.type === "STATE_UPDATE") {
      const state = ev.data.state;
      if (state) {
        appState.phase = state.progress?.phase || "navigating";
        appState.progress = state.progress?.estimatedProgress || 0;
        appState.jobTitle = state.goal?.jobTitle || "";
        appState.company = state.goal?.company || "";
        appState.fieldsFilledCount = state.progress?.fieldsFilledThisPage?.length || 0;
        
        // Update status bar if it exists (will be shown when minimized)
        const statusBar = document.getElementById("agent-status-bar");
        if (statusBar && statusBar.style.display !== "none") {
          // Trigger update by calling the function if available
          if (typeof updateStatusBar === "function") {
            updateStatusBar();
          }
        }
      }
    }
  }

  // Helper to get a human-readable display name from an action target
  function getTargetDisplayName(action) {
    if (!action || !action.target) return "element";
    
    const target = action.target;
    
    // Prefer text-based targets (most human-readable)
    if (target.text) {
      return String(target.text).slice(0, 30);
    }
    
    // Label is also human-readable
    if (target.label) {
      return String(target.label).slice(0, 30);
    }
    
    // CSS selector might be somewhat readable
    if (target.selector) {
      // Try to extract a meaningful part from the selector
      const sel = String(target.selector);
      // If it's an ID selector, show the id
      if (sel.startsWith("#")) {
        return sel.slice(1, 31);
      }
      // If it starts with a class, show the class
      if (sel.startsWith(".")) {
        return sel.slice(1, 31);
      }
      // Otherwise truncate
      return sel.slice(0, 30);
    }
    
    // ID-based targeting
    if (target.id) {
      return String(target.id).slice(0, 30);
    }
    
    // Index-based targeting - least readable, show generic text
    if (typeof target.index === "number") {
      const elementType = target.elementType === "button" ? "button" : "field";
      return `${elementType} #${target.index}`;
    }
    
    // Name-based (for roles)
    if (target.name) {
      return String(target.name).slice(0, 30);
    }
    
    return "element";
  }

  function updateAction(action, thinking, confidence, fieldName, planProgress) {
    currentAction = action;
    currentThinking = thinking || "";
    currentConfidence = typeof confidence === "number" ? confidence : 0.7;

    // Update thinking section
    const thinkingSection = document.getElementById("agent-thinking-section");
    const thinkingText = document.getElementById("agent-thinking-text");
    if (thinkingSection && thinkingText) {
      if (currentThinking && currentThinking !== "(No reasoning provided)") {
        thinkingSection.style.display = "block";
        // Truncate long thinking text
        const displayThinking = currentThinking.length > 150 
          ? currentThinking.slice(0, 150) + "..." 
          : currentThinking;
        thinkingText.textContent = displayThinking;
      } else {
        thinkingSection.style.display = "none";
      }
    }

    // Update action display
    const actDisplay = document.getElementById("agent-action");
    if (actDisplay && action) {
      const icons = {
        FILL: "✏️",
        CLICK: "👆",
        SELECT: "📋",
        SELECT_CUSTOM: "📋",
        CHECK: "☑️",
        NAVIGATE: "🔗",
        WAIT_FOR: "⏳",
        EXTRACT: "🔍",
        REQUEST_VERIFICATION: "🔐",
        ASK_USER: "🤔",
        DONE: "✅"
      };
      const icon = icons[action.type] || "▶️";
      
      // Build human-readable action text
      let actionText = action.type;
      
      // Use fieldName if provided (from multi-step plan), otherwise extract from target
      const displayName = fieldName || getTargetDisplayName(action);
      
      if (action.type === "DONE" && action.summary) {
        actionText = `DONE: ${String(action.summary).slice(0, 80)}`;
      } else if (action.type === "REQUEST_VERIFICATION") {
        actionText = `VERIFY: ${action.kind || "needed"}`;
      } else if (action.type === "ASK_USER") {
        actionText = `Asking: ${String(action.question).slice(0, 50)}...`;
      } else if (action.type === "FILL") {
        actionText = `FILL "${displayName}"`;
      } else if (action.type === "CLICK") {
        actionText = `CLICK "${displayName}"`;
      } else if (action.type === "SELECT" || action.type === "SELECT_CUSTOM") {
        actionText = `SELECT "${displayName}"`;
      } else if (action.type === "CHECK") {
        actionText = `CHECK "${displayName}"`;
      }
      
      // Add plan progress indicator if we're executing a plan
      let progressBadge = "";
      if (planProgress && planProgress.totalSteps > 0) {
        progressBadge = `<span style="font-size: 10px; background: rgba(99, 102, 241, 0.3); padding: 2px 6px; border-radius: 4px; margin-left: 8px; color: #a5b4fc;">Step ${planProgress.currentStep}/${planProgress.totalSteps}</span>`;
      }

      actDisplay.innerHTML = `<span style="font-size: 14px;">${icon}</span> <span style="color: #ffffff; font-weight: 500;">${actionText}</span>${progressBadge}`;
    }

    // Update confidence bar
    const confidenceSection = document.getElementById("agent-confidence-section");
    const confidenceFill = document.getElementById("agent-confidence-fill");
    if (confidenceSection && confidenceFill) {
      confidenceSection.style.display = "block";
      const percent = Math.round(currentConfidence * 100);
      confidenceFill.style.width = `${percent}%`;
      
      // Color based on confidence level
      if (currentConfidence >= 0.8) {
        confidenceFill.style.background = "linear-gradient(90deg, #22c55e, #84cc16)";
      } else if (currentConfidence >= 0.5) {
        confidenceFill.style.background = "linear-gradient(90deg, #eab308, #f59e0b)";
      } else {
        confidenceFill.style.background = "linear-gradient(90deg, #ef4444, #f97316)";
      }
    }
  }

  function showAskUserModal(question, options, allowCustom, actionId) {
    // Remove existing modal if present
    closeAskUserModal();

    // Create overlay backdrop
    const backdrop = document.createElement("div");
    backdrop.id = "agent-modal-backdrop";
    backdrop.style.cssText = `
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      z-index: 2147483646;
      display: flex;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.2s ease;
    `;

    // Create modal
    const modal = document.createElement("div");
    modal.id = "agent-ask-modal";
    modal.style.cssText = `
      background: #1e293b;
      border-radius: 16px;
      padding: 24px;
      max-width: 420px;
      width: 90%;
      color: white;
      font-family: system-ui, -apple-system, sans-serif;
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
      animation: slideUp 0.25s ease;
    `;

    // Modal header
    const header = document.createElement("div");
    header.style.cssText = "display: flex; align-items: center; gap: 10px; margin-bottom: 16px;";
    header.innerHTML = `<span style="font-size: 24px;">🤔</span><span style="font-weight: 600; font-size: 16px; color: #ffffff;">Agent needs your help</span>`;

    // Question
    const questionEl = document.createElement("div");
    questionEl.style.cssText = "font-size: 14px; line-height: 1.6; margin-bottom: 20px; color: #f1f5f9; font-weight: 400;";
    questionEl.textContent = question;

    // Options
    const optionsContainer = document.createElement("div");
    optionsContainer.style.cssText = "display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;";

    let selectedOption = null;
    
    options.forEach((opt, idx) => {
      const optBtn = document.createElement("button");
      optBtn.dataset.optionId = opt.id;
      optBtn.style.cssText = `
        display: flex; align-items: center; gap: 10px;
        background: rgba(255,255,255,.08);
        border: 2px solid rgba(255,255,255,.2);
        border-radius: 10px;
        padding: 12px 16px;
        color: #ffffff;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
        text-align: left;
      `;
      
      const radio = document.createElement("span");
      radio.className = "opt-radio";
      radio.style.cssText = `
        width: 18px; height: 18px;
        border: 2px solid rgba(255,255,255,.4);
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      `;
      
      const label = document.createElement("span");
      label.textContent = opt.label;
      
      optBtn.appendChild(radio);
      optBtn.appendChild(label);
      
      optBtn.onclick = () => {
        // Deselect all
        optionsContainer.querySelectorAll("button").forEach(b => {
          b.style.borderColor = "rgba(255,255,255,.2)";
          b.style.background = "rgba(255,255,255,.08)";
          b.querySelector(".opt-radio").innerHTML = "";
        });
        // Select this one
        optBtn.style.borderColor = "#6366f1";
        optBtn.style.background = "rgba(99, 102, 241, 0.2)";
        radio.innerHTML = '<div style="width: 8px; height: 8px; background: #6366f1; border-radius: 50%;"></div>';
        selectedOption = opt.id;
      };
      
      optBtn.onmouseenter = () => {
        if (selectedOption !== opt.id) {
          optBtn.style.background = "rgba(255,255,255,.15)";
        }
      };
      optBtn.onmouseleave = () => {
        if (selectedOption !== opt.id) {
          optBtn.style.background = "rgba(255,255,255,.08)";
        }
      };
      
      optionsContainer.appendChild(optBtn);
    });

    // Custom input (if allowed)
    let customInput = null;
    if (allowCustom) {
      customInput = document.createElement("input");
      customInput.type = "text";
      customInput.placeholder = "Or type a custom response...";
      customInput.style.cssText = `
        width: 100%;
        background: rgba(255,255,255,.1);
        border: 1px solid rgba(255,255,255,.25);
        border-radius: 8px;
        padding: 10px 14px;
        color: #ffffff;
        font-size: 14px;
        font-weight: 400;
        margin-bottom: 16px;
        box-sizing: border-box;
      `;
      customInput.onfocus = () => {
        customInput.style.borderColor = "#6366f1";
        // Deselect options when typing
        selectedOption = null;
        optionsContainer.querySelectorAll("button").forEach(b => {
          b.style.borderColor = "rgba(255,255,255,.2)";
          b.style.background = "rgba(255,255,255,.08)";
          b.querySelector(".opt-radio").innerHTML = "";
        });
      };
    }

    // Buttons row
    const buttonsRow = document.createElement("div");
    buttonsRow.style.cssText = "display: flex; gap: 10px; justify-content: flex-end;";

    const skipBtn = document.createElement("button");
    skipBtn.textContent = "Skip";
    skipBtn.style.cssText = `
      background: rgba(255,255,255,.12);
      border: none;
      border-radius: 8px;
      padding: 10px 20px;
      color: #ffffff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    `;
    skipBtn.onmouseenter = () => skipBtn.style.background = "rgba(255,255,255,.2)";
    skipBtn.onmouseleave = () => skipBtn.style.background = "rgba(255,255,255,.1)";
    skipBtn.onclick = () => {
      window.postMessage({
        source: "agent-hud",
        type: "USER_RESPONSE",
        actionId,
        skipped: true
      }, "*");
      closeAskUserModal();
    };

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "Confirm";
    confirmBtn.style.cssText = `
      background: #6366f1;
      border: none;
      border-radius: 8px;
      padding: 10px 24px;
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    `;
    confirmBtn.onmouseenter = () => confirmBtn.style.background = "#4f46e5";
    confirmBtn.onmouseleave = () => confirmBtn.style.background = "#6366f1";
    confirmBtn.onclick = () => {
      const customValue = customInput?.value?.trim();
      if (!selectedOption && !customValue) {
        // Shake the modal if nothing selected
        modal.style.animation = "shake 0.3s ease";
        setTimeout(() => modal.style.animation = "", 300);
        return;
      }
      
      window.postMessage({
        source: "agent-hud",
        type: "USER_RESPONSE",
        actionId,
        selectedOptionId: selectedOption,
        customResponse: customValue || undefined
      }, "*");
      closeAskUserModal();
    };

    buttonsRow.appendChild(skipBtn);
    buttonsRow.appendChild(confirmBtn);

    // Assemble modal
    modal.appendChild(header);
    modal.appendChild(questionEl);
    modal.appendChild(optionsContainer);
    if (customInput) modal.appendChild(customInput);
    modal.appendChild(buttonsRow);

    backdrop.appendChild(modal);

    // Add animations and styles
    const style = document.createElement("style");
    style.textContent = `
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes slideUp {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      @keyframes shake {
        0%, 100% { transform: translateX(0); }
        20% { transform: translateX(-6px); }
        40% { transform: translateX(6px); }
        60% { transform: translateX(-4px); }
        80% { transform: translateX(4px); }
      }
      #agent-ask-modal input::placeholder {
        color: rgba(255, 255, 255, 0.5) !important;
      }
    `;
    document.head.appendChild(style);

    document.body.appendChild(backdrop);

    // Close on backdrop click (outside modal)
    backdrop.onclick = (e) => {
      if (e.target === backdrop) {
        window.postMessage({
          source: "agent-hud",
          type: "USER_RESPONSE",
          actionId,
          skipped: true
        }, "*");
        closeAskUserModal();
      }
    };
  }

  function closeAskUserModal() {
    const backdrop = document.getElementById("agent-modal-backdrop");
    if (backdrop) backdrop.remove();
  }

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
