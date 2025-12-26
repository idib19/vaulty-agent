# External App Integration Guide

This document explains how to integrate an external web application (e.g., Vaulty Dashboard) with the Vaulty Chrome Extension to trigger automated job applications.

## Overview

The Vaulty Chrome Extension supports external messaging, allowing a web application to:
- Check if the extension is installed
- Trigger job applications with pre-filled data
- Monitor job application progress
- Cancel running jobs

## Architecture

```
┌─────────────────────┐     chrome.runtime.sendMessage()     ┌─────────────────────┐
│   Vaulty Web App    │ ───────────────────────────────────► │  Chrome Extension   │
│  (Dashboard/Jobs)   │                                       │  (Background.js)    │
│                     │ ◄─────────────────────────────────── │                     │
│  localhost:3000     │      Response (jobId, status)        │  Agent Runner       │
└─────────────────────┘                                       └─────────────────────┘
          │                                                             │
          │                                                             │
          │                                                             ▼
          │                                                   ┌─────────────────────┐
          │                                                   │   New Browser Tab   │
          │                                                   │   (Job Page)        │
          │                                                   │                     │
          └───────────────────────────────────────────────────│   Content Script    │
                         Status updates                       │   + Overlay HUD     │
                                                              └─────────────────────┘
```

## Prerequisites

### 1. Extension Configuration

The extension's `manifest.json` must include your web app's origin in `externally_connectable`:

```json
{
  "externally_connectable": {
    "matches": [
      "https://vaulty.ca/*",
      "https://*.vaulty.ia/*",
      "http://localhost:3001/*",
      "http://localhost:5173/*"
    ]
  }
}
```

### 2. Get Extension ID

You'll need the extension's ID to communicate with it. Find this at:
- `chrome://extensions` (with Developer Mode enabled)
- Look for "Agent Runner (Live + Background)"
- Copy the ID (e.g., `abcdefghijklmnopqrstuvwxyz123456`)

## API Reference

### Check Extension Status

Verify if the extension is installed and get its version.

```javascript
const EXTENSION_ID = "your-extension-id-here";

async function checkExtension() {
  try {
    const response = await chrome.runtime.sendMessage(
      EXTENSION_ID,
      { type: "GET_EXTENSION_STATUS" }
    );
    
    if (response?.ok && response?.installed) {
      console.log("Extension installed, version:", response.version);
      return true;
    }
    return false;
  } catch (error) {
    // Extension not installed or not accessible
    console.log("Extension not found");
    return false;
  }
}
```

### Start a Job Application

Trigger the agent to apply to a job with optional pre-filled data.

```javascript
async function startJobApplication(jobData) {
  const response = await chrome.runtime.sendMessage(EXTENSION_ID, {
    type: "START_JOB_FROM_EXTERNAL",
    payload: {
      // Required
      jobUrl: "https://example.com/jobs/software-engineer",
      
      // Optional - pre-fill data
      jobTitle: "Software Engineer",
      company: "Tech Corp",
      coverLetter: "Dear Hiring Manager...",
      resumeId: "resume-uuid-123",
      customFields: {
        "salary_expectation": "$120,000",
        "start_date": "2 weeks",
        "work_authorization": "yes"
      },
      
      // Optional - mode
      mode: "live" // or "background"
    }
  });
  
  if (response.ok) {
    console.log("Job started:", response.jobId);
    console.log(response.message);
    return response.jobId;
  } else {
    console.error("Failed to start job:", response.error);
    return null;
  }
}
```

#### Payload Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `jobUrl` | string | Yes | Full URL of the job posting |
| `jobTitle` | string | No | Job title for agent context |
| `company` | string | No | Company name for agent context |
| `coverLetter` | string | No | Pre-written cover letter to use |
| `resumeId` | string | No | ID of resume to use (if multi-resume support) |
| `customFields` | object | No | Pre-filled answers for common questions |
| `mode` | string | No | "live" (default) or "background" |

### Get Job Status

Check the progress of a running job.

```javascript
async function getJobStatus(jobId) {
  const response = await chrome.runtime.sendMessage(EXTENSION_ID, {
    type: "GET_JOB_STATUS",
    jobId: jobId
  });
  
  if (response.ok && response.job) {
    console.log("Status:", response.job.status);
    console.log("Phase:", response.job.phase);
    console.log("Progress:", response.job.progress + "%");
    return response.job;
  }
  return null;
}
```

#### Job Status Values

| Status | Description |
|--------|-------------|
| `starting` | Job is being initialized |
| `running` | Agent is actively working |
| `paused` | Waiting for user input |
| `waiting_for_user` | ASK_USER action pending |
| `done` | Application completed successfully |
| `error` | An error occurred |
| `stopping` | Job is being cancelled |

### Cancel a Job

Stop a running job application.

```javascript
async function cancelJob(jobId) {
  const response = await chrome.runtime.sendMessage(EXTENSION_ID, {
    type: "CANCEL_JOB",
    jobId: jobId
  });
  
  if (response.ok) {
    console.log("Job cancelled");
    return true;
  }
  return false;
}
```

## Complete Integration Example

Here's a full example of integrating with a React/Next.js job board:

```typescript
// lib/vaulty-extension.ts

const EXTENSION_ID = process.env.NEXT_PUBLIC_EXTENSION_ID || "";

export interface JobApplicationRequest {
  jobUrl: string;
  jobTitle?: string;
  company?: string;
  coverLetter?: string;
  customFields?: Record<string, string>;
}

export interface ExtensionStatus {
  installed: boolean;
  version?: string;
}

export interface JobStatus {
  status: string;
  phase?: string;
  progress?: number;
  error?: string;
}

class VaultyExtension {
  private extensionId: string;

  constructor(extensionId: string) {
    this.extensionId = extensionId;
  }

  private async sendMessage<T>(message: object): Promise<T | null> {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      console.warn("Chrome runtime not available");
      return null;
    }

    try {
      return await chrome.runtime.sendMessage(this.extensionId, message);
    } catch (error) {
      console.error("Extension communication error:", error);
      return null;
    }
  }

  async isInstalled(): Promise<boolean> {
    const response = await this.sendMessage<{ ok: boolean; installed: boolean }>({
      type: "GET_EXTENSION_STATUS"
    });
    return response?.ok && response?.installed === true;
  }

  async getStatus(): Promise<ExtensionStatus> {
    const response = await this.sendMessage<{ 
      ok: boolean; 
      installed: boolean; 
      version?: string 
    }>({
      type: "GET_EXTENSION_STATUS"
    });
    
    return {
      installed: response?.ok && response?.installed === true,
      version: response?.version
    };
  }

  async startJob(data: JobApplicationRequest): Promise<string | null> {
    const response = await this.sendMessage<{ 
      ok: boolean; 
      jobId?: string; 
      error?: string 
    }>({
      type: "START_JOB_FROM_EXTERNAL",
      payload: data
    });

    if (response?.ok && response?.jobId) {
      return response.jobId;
    }
    
    console.error("Failed to start job:", response?.error);
    return null;
  }

  async getJobStatus(jobId: string): Promise<JobStatus | null> {
    const response = await this.sendMessage<{ 
      ok: boolean; 
      job?: JobStatus 
    }>({
      type: "GET_JOB_STATUS",
      jobId
    });

    return response?.ok ? response.job || null : null;
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const response = await this.sendMessage<{ ok: boolean }>({
      type: "CANCEL_JOB",
      jobId
    });
    return response?.ok === true;
  }
}

// Singleton instance
export const vaultyExtension = new VaultyExtension(EXTENSION_ID);
```

### React Component Example

```tsx
// components/ApplyWithVaultyButton.tsx

import { useState, useEffect } from "react";
import { vaultyExtension, JobApplicationRequest } from "@/lib/vaulty-extension";

interface Props {
  job: {
    url: string;
    title: string;
    company: string;
  };
  coverLetter?: string;
}

export function ApplyWithVaultyButton({ job, coverLetter }: Props) {
  const [isInstalled, setIsInstalled] = useState<boolean | null>(null);
  const [applying, setApplying] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  // Check extension on mount
  useEffect(() => {
    vaultyExtension.isInstalled().then(setIsInstalled);
  }, []);

  // Poll for job status
  useEffect(() => {
    if (!jobId) return;

    const interval = setInterval(async () => {
      const status = await vaultyExtension.getJobStatus(jobId);
      if (status) {
        setProgress(status.progress || 0);
        
        if (status.status === "done" || status.status === "error") {
          setApplying(false);
          clearInterval(interval);
          
          if (status.status === "done") {
            alert("Application submitted successfully!");
          } else {
            alert(`Application failed: ${status.error}`);
          }
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [jobId]);

  const handleApply = async () => {
    setApplying(true);
    
    const id = await vaultyExtension.startJob({
      jobUrl: job.url,
      jobTitle: job.title,
      company: job.company,
      coverLetter
    });

    if (id) {
      setJobId(id);
    } else {
      setApplying(false);
      alert("Failed to start application. Please try again.");
    }
  };

  if (isInstalled === null) {
    return <button disabled>Checking extension...</button>;
  }

  if (!isInstalled) {
    return (
      <a 
        href="https://chrome.google.com/webstore/detail/vaulty" 
        target="_blank"
        className="btn btn-secondary"
      >
        Install Vaulty Extension
      </a>
    );
  }

  if (applying) {
    return (
      <button disabled className="btn btn-loading">
        Applying... {progress}%
      </button>
    );
  }

  return (
    <button onClick={handleApply} className="btn btn-primary">
      🚀 Apply with Vaulty
    </button>
  );
}
```

## Security Considerations

### 1. Origin Validation

The extension validates the sender's origin before processing any message. Only origins listed in `externally_connectable` are allowed.

### 2. Input Validation

All incoming payloads are validated:
- `jobUrl` is required and must be a valid URL
- Other fields are sanitized before use

### 3. Rate Limiting

Consider implementing rate limiting on your web app to prevent abuse:

```javascript
// Simple rate limiter
const applicationAttempts = new Map();
const MAX_ATTEMPTS_PER_HOUR = 20;

function canApply(userId) {
  const attempts = applicationAttempts.get(userId) || [];
  const recentAttempts = attempts.filter(
    t => Date.now() - t < 3600000 // Last hour
  );
  
  if (recentAttempts.length >= MAX_ATTEMPTS_PER_HOUR) {
    return false;
  }
  
  applicationAttempts.set(userId, [...recentAttempts, Date.now()]);
  return true;
}
```

### 4. Extension ID Security

Keep your extension ID semi-private:
- Don't hardcode it in public repositories
- Use environment variables
- Consider using a published extension for production

## Troubleshooting

### Extension Not Responding

1. Verify the extension is installed and enabled
2. Check that your origin is in `externally_connectable`
3. Ensure you're using HTTPS in production (or localhost in development)
4. Check the extension's service worker console for errors

### Job Starts But Fails Immediately

1. Verify the job URL is accessible
2. Ensure user profile is set up in the extension
3. Check extension logs in the popup

### Cross-Origin Issues

If you see CORS or cross-origin errors:
1. Verify your domain is in `manifest.json`
2. Reload the extension after manifest changes
3. Try in incognito with only the extension enabled

## Best Practices

1. **Always check extension status** before showing apply buttons
2. **Provide fallback** to manual application if extension unavailable
3. **Show progress feedback** to users during application
4. **Handle errors gracefully** and inform users
5. **Pre-fill as much data as possible** to improve success rate
6. **Test thoroughly** with various job boards

## TypeScript Types

For TypeScript projects, you can use these type definitions:

```typescript
// types/vaulty-extension.d.ts

declare global {
  interface Chrome {
    runtime: {
      sendMessage: <T>(extensionId: string, message: object) => Promise<T>;
    };
  }
}

export interface VaultyMessage {
  type: 
    | "GET_EXTENSION_STATUS"
    | "START_JOB_FROM_EXTERNAL"
    | "GET_JOB_STATUS"
    | "CANCEL_JOB";
}

export interface StartJobPayload {
  jobUrl: string;
  jobTitle?: string;
  company?: string;
  coverLetter?: string;
  resumeId?: string;
  customFields?: Record<string, string>;
  mode?: "live" | "background";
}

export interface ExtensionStatusResponse {
  ok: boolean;
  installed?: boolean;
  version?: string;
  error?: string;
}

export interface JobStartResponse {
  ok: boolean;
  jobId?: string;
  message?: string;
  error?: string;
}

export interface JobStatusResponse {
  ok: boolean;
  job?: {
    status: string;
    step?: number;
    phase?: string;
    progress?: number;
    error?: string;
  };
}
```

## Version History

| Version | Changes |
|---------|---------|
| 0.1.0 | Initial external messaging support |

---

For more information, see the main [SYSTEM.md](../SYSTEM.md) documentation.

