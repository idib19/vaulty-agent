// Profile storage and management for the extension

const PROFILE_KEY = "userProfile";
const PROFILE_CACHE_TTL = 1000 * 60 * 60; // 1 hour cache

// Default empty profile
const emptyProfile = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  address: {
    street: "",
    street2: "",
    city: "",
    state: "",
    zipCode: "",
    country: "",
  },
  company: "",
  jobTitle: "",
  linkedIn: "",
  website: "",
  custom: {},
};

// Get profile from local storage
async function getProfile() {
  const data = await chrome.storage.local.get([PROFILE_KEY]);
  return data[PROFILE_KEY] || { ...emptyProfile };
}

// Save profile to local storage
async function saveProfile(profile) {
  const updatedProfile = {
    ...profile,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [PROFILE_KEY]: updatedProfile });
  return updatedProfile;
}

// Clear profile from local storage
async function clearProfile() {
  await chrome.storage.local.remove([PROFILE_KEY]);
}

// Sync profile with backend (optional)
async function syncProfileWithBackend(userId) {
  const apiBase = (await chrome.storage.local.get(["apiBase"])).apiBase || "http://localhost:3000";
  
  try {
    // Try to fetch from backend
    const response = await fetch(`${apiBase}/api/profile?userId=${encodeURIComponent(userId)}`);
    
    if (response.ok) {
      const data = await response.json();
      if (data.profile) {
        // Save to local storage
        await saveProfile(data.profile);
        return data.profile;
      }
    }
  } catch (error) {
    console.error("[Profile] Failed to sync with backend:", error);
  }
  
  // Return local profile if backend fails
  return getProfile();
}

// Push local profile to backend
async function pushProfileToBackend(userId) {
  const apiBase = (await chrome.storage.local.get(["apiBase"])).apiBase || "http://localhost:3000";
  const profile = await getProfile();
  
  try {
    const response = await fetch(`${apiBase}/api/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, profile }),
    });
    
    if (response.ok) {
      console.log("[Profile] Synced to backend");
      return true;
    }
  } catch (error) {
    console.error("[Profile] Failed to push to backend:", error);
  }
  
  return false;
}

// Validate profile has minimum required data
function isProfileValid(profile) {
  return profile && 
    (profile.firstName || profile.lastName || profile.email);
}

// Export for use in other scripts
if (typeof window !== "undefined") {
  window.profileManager = {
    getProfile,
    saveProfile,
    clearProfile,
    syncProfileWithBackend,
    pushProfileToBackend,
    isProfileValid,
    emptyProfile,
  };
}

