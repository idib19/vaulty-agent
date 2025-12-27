// User profile types for form filling

export interface ResumeData {
  // Bio/Summary
  bio?: string;
  summary?: string;
  
  // Work Experience
  experiences?: {
    company: string;
    title: string;
    startDate?: string;
    endDate?: string;
    current?: boolean;
    description?: string;
    location?: string;
  }[];
  
  // Education
  education?: {
    school: string;
    degree?: string;
    field?: string;
    startDate?: string;
    endDate?: string;
    gpa?: string;
  }[];
  
  // Skills
  skills?: string[];
  
  // Certifications
  certifications?: string[];
  
  // Languages
  languages?: string[];
  
  // Raw text fallback (if user pastes unstructured resume)
  rawText?: string;
}

export interface UserProfile {
  // Personal info
  firstName: string;
  lastName: string;
  fullName?: string;
  email: string;
  phone?: string;
  
  // Authentication
  password?: string;
  preferOAuth?: boolean;
  oauthProvider?: "google" | "linkedin" | "github" | "apple";
  // Note: email field should be in Vaulty proxy format (user@mailbox.vaulty.ca) for auto-OTP
  
  // Address
  address?: {
    street?: string;
    street2?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
  };
  
  // Professional info
  company?: string;
  jobTitle?: string;
  linkedIn?: string;
  website?: string;
  github?: string;
  
  // Resume data
  resume?: ResumeData;
  
  // Resume file (for upload to job applications)
  resumeFile?: {
    name: string;
    type: string;
    size: number;
    base64: string;
    uploadedAt?: string;
  };
  
  // Additional fields (flexible key-value)
  custom?: Record<string, string>;
  
  // Metadata
  updatedAt?: string;
}

// Default empty profile
export const emptyProfile: UserProfile = {
  firstName: "",
  lastName: "",
  email: "",
};

// Helper to get full name
export function getFullName(profile: UserProfile): string {
  if (profile.fullName) return profile.fullName;
  return `${profile.firstName} ${profile.lastName}`.trim();
}

// Helper to format address
export function formatAddress(profile: UserProfile): string {
  if (!profile.address) return "";
  const { street, street2, city, state, zipCode, country } = profile.address;
  const parts = [street, street2, city, state, zipCode, country].filter(Boolean);
  return parts.join(", ");
}

// Helper to format work experience
export function formatExperience(profile: UserProfile): string {
  if (!profile.resume?.experiences?.length) return "";
  
  return profile.resume.experiences.map(exp => {
    const dates = exp.current 
      ? `${exp.startDate || ''} - Present`
      : `${exp.startDate || ''} - ${exp.endDate || ''}`;
    return `${exp.title} at ${exp.company} (${dates})${exp.description ? ': ' + exp.description : ''}`;
  }).join('\n');
}

// Helper to format education
export function formatEducation(profile: UserProfile): string {
  if (!profile.resume?.education?.length) return "";
  
  return profile.resume.education.map(edu => {
    const degree = edu.degree ? `${edu.degree}${edu.field ? ' in ' + edu.field : ''}` : edu.field || '';
    return `${degree} from ${edu.school}`;
  }).join('\n');
}

// Convert profile to flat key-value pairs for LLM context
export function profileToContext(profile: UserProfile): Record<string, string> {
  const context: Record<string, string> = {};
  
  // Personal info
  if (profile.firstName) context["first name"] = profile.firstName;
  // Alias for prompts expecting camelCase keys
  if (profile.firstName) context["firstName"] = profile.firstName;
  if (profile.lastName) context["last name"] = profile.lastName;
  // Alias for prompts expecting camelCase keys
  if (profile.lastName) context["lastName"] = profile.lastName;
  if (profile.fullName) context["full name"] = profile.fullName;
  else context["full name"] = getFullName(profile);
  if (profile.email) context["email"] = profile.email;
  if (profile.phone) context["phone"] = profile.phone;
  
  // Password (if stored)
  if (profile.password) context["password"] = profile.password;
  
  // Address
  if (profile.address) {
    if (profile.address.street) context["street address"] = profile.address.street;
    if (profile.address.street2) context["address line 2"] = profile.address.street2;
    if (profile.address.city) context["city"] = profile.address.city;
    if (profile.address.state) context["state"] = profile.address.state;
    if (profile.address.zipCode) context["zip code"] = profile.address.zipCode;
    if (profile.address.country) context["country"] = profile.address.country;
    context["full address"] = formatAddress(profile);
    // "Location" is commonly just city/state/country; provide a dedicated key used by prompts.
    const locParts = [profile.address.city, profile.address.state, profile.address.country].filter(Boolean);
    if (locParts.length > 0) context["location"] = locParts.join(", ");
  }
  
  // Professional
  if (profile.company) context["current company"] = profile.company;
  if (profile.jobTitle) context["job title"] = profile.jobTitle;
  if (profile.linkedIn) context["linkedin url"] = profile.linkedIn;
  // Alias for prompts expecting camelCase keys
  if (profile.linkedIn) context["linkedIn"] = profile.linkedIn;
  if (profile.website) context["website"] = profile.website;
  // Alias for prompts expecting "portfolio"
  if (profile.website) context["portfolio"] = profile.website;
  if (profile.github) context["github"] = profile.github;
  
  // Resume data
  if (profile.resume) {
    if (profile.resume.bio) context["bio"] = profile.resume.bio;
    if (profile.resume.summary) context["professional summary"] = profile.resume.summary;
    
    if (profile.resume.skills?.length) {
      context["skills"] = profile.resume.skills.join(", ");
    }
    
    if (profile.resume.experiences?.length) {
      context["work experience"] = formatExperience(profile);
      
      // Also extract most recent job details
      const current = profile.resume.experiences[0];
      if (current) {
        context["most recent job title"] = current.title;
        context["most recent company"] = current.company;
        if (current.description) context["job description"] = current.description;
      }
    }
    
    if (profile.resume.education?.length) {
      context["education"] = formatEducation(profile);
      
      // Extract highest degree
      const latest = profile.resume.education[0];
      if (latest) {
        if (latest.degree) context["degree"] = latest.degree;
        if (latest.field) context["field of study"] = latest.field;
        if (latest.school) context["school"] = latest.school;
      }
    }
    
    if (profile.resume.certifications?.length) {
      context["certifications"] = profile.resume.certifications.join(", ");
    }
    
    if (profile.resume.languages?.length) {
      context["languages"] = profile.resume.languages.join(", ");
    }
    
    // Raw resume text as fallback
    if (profile.resume.rawText) {
      context["resume text"] = profile.resume.rawText;
    }
  }
  
  // Custom fields
  if (profile.custom) {
    Object.entries(profile.custom).forEach(([key, value]) => {
      context[key.toLowerCase()] = value;
    });
  }
  
  // Resume file availability (for UPLOAD_FILE action)
  if (profile.resumeFile?.base64) {
    context["RESUME FILE AVAILABLE"] = `Yes - ${profile.resumeFile.name} (${Math.round(profile.resumeFile.size / 1024)} KB)`;
  }
  
  return context;
}

// Parse resume from text or JSON
export function parseResumeInput(input: string): ResumeData {
  const trimmed = input.trim();
  
  // Try to parse as JSON first
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      
      // If it's a valid resume object, return it
      if (typeof parsed === 'object') {
        return {
          bio: parsed.bio || parsed.summary || parsed.objective,
          summary: parsed.summary || parsed.bio,
          experiences: parsed.experiences || parsed.experience || parsed.work,
          education: parsed.education,
          skills: Array.isArray(parsed.skills) ? parsed.skills : 
                  typeof parsed.skills === 'string' ? parsed.skills.split(',').map((s: string) => s.trim()) : undefined,
          certifications: parsed.certifications,
          languages: parsed.languages,
          rawText: trimmed,
        };
      }
    } catch {
      // Not valid JSON, treat as raw text
    }
  }
  
  // Return as raw text
  return {
    rawText: trimmed,
  };
}
