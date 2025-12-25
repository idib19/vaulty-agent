# Vaulty Agent in Browser

An intelligent browser automation agent powered by LLM, with a Next.js backend and Chrome MV3 extension.

## Features

- **LLM-Powered Form Filling**: Uses AI to understand and fill web forms intelligently
- **Flexible LLM Support**: OpenAI, Anthropic, OpenRouter, or local Ollama
- **User Profile Storage**: Save your personal data for automatic form filling
- **Hybrid Storage**: Profile stored locally in extension + optional backend sync
- **Live & Background Modes**: Watch the agent work or let it run in the background
- **Approval Gates**: Requires confirmation before submit-like actions
- **OTP/Verification Handling**: Pauses for manual code entry when needed

## Project Structure

```
vaulty-agent/
├── README.md
├── package.json              # Workspace root
├── web/                      # Next.js App Router backend
│   ├── package.json
│   ├── next.config.js
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── api/
│   │       ├── agent/
│   │       │   ├── next/route.ts     # LLM Planner endpoint
│   │       │   ├── verify/route.ts   # OTP endpoint
│   │       │   └── log/route.ts      # Logging endpoint
│   │       └── profile/
│   │           └── route.ts          # Profile sync endpoint
│   └── lib/
│       ├── cors.ts
│       ├── types.ts
│       ├── profile.ts
│       └── llm/
│           ├── router.ts             # LLM provider router
│           ├── prompts.ts            # System prompts
│           ├── types.ts
│           └── providers/
│               ├── openai.ts
│               ├── anthropic.ts
│               ├── openrouter.ts
│               └── ollama.ts
└── extension/                # Chrome MV3 extension
    ├── manifest.json
    ├── background.js
    ├── content.js
    ├── overlay.js
    ├── popup.html
    ├── popup.js
    ├── profile.js
    └── styles.css
```

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure LLM Provider

Create a `.env.local` file in the `web/` directory:

```bash
# Choose your LLM provider
LLM_PROVIDER=openai  # Options: openai, anthropic, openrouter, ollama

# API Keys (set the one matching your provider)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...

# For Ollama (local LLM)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3

# Optional: Override default models
OPENAI_MODEL=gpt-4o-mini
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022
OPENROUTER_MODEL=openai/gpt-4o-mini
```

### 3. Start the Backend

```bash
npm run dev:web
```

Backend will be available at http://localhost:3000

### 4. Load the Extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder

## Usage

### Setting Up Your Profile

1. Click the extension icon
2. Go to the **Profile** tab
3. Fill in your personal information (name, email, phone, address, etc.)
4. Click **Save Profile**

The agent will use this profile data to fill forms automatically.

### Running the Agent

1. Click the extension icon
2. In the **Agent** tab, paste the URL of a form you want to fill
3. Choose mode:
   - **Live**: Tab stays visible, watch the agent work
   - **Background**: Tab runs in background (may be throttled)
4. Click **Start**

### Approval & Verification

- **Submit Actions**: The agent pauses before clicking submit-like buttons. Click "Approve & Continue" to proceed.
- **OTP/Verification**: When a site asks for a code, enter it in the popup and click "Send OTP to Agent".

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agent/next` | POST | Get next action from LLM planner |
| `/api/agent/verify` | POST | Submit OTP/verification code |
| `/api/agent/log` | POST | Log agent actions |
| `/api/profile` | GET/POST | Sync user profile |

## LLM Providers

### OpenAI (Default)
```env
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini  # Optional, defaults to gpt-4o-mini
```

### Anthropic (Claude)
```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-sonnet-20241022  # Optional
```

### OpenRouter (Multiple Models)
```env
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4o-mini  # See openrouter.ai for models
```

### Ollama (Local)
```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3
```

First, install and run Ollama:
```bash
ollama run llama3
```

## Fallback Mode

If no LLM is configured (no API keys set), the agent falls back to a simple stub planner that:
- Fills fields labeled "First Name", "Last Name", "Email"
- Clicks "Next", "Continue", "Submit" buttons
- Pauses on verification requests

This is useful for testing without an LLM.

## Development

### Backend (Next.js)
```bash
cd web
npm run dev
```

### Extension
After making changes to extension files, reload the extension in Chrome:
1. Go to `chrome://extensions`
2. Click the refresh icon on "Agent Runner"

### Testing the LLM Integration
```bash
# Test the planner endpoint
curl -X POST http://localhost:3000/api/agent/next \
  -H "Content-Type: application/json" \
  -d '{
    "jobId": "test",
    "step": 1,
    "mode": "live",
    "observation": {
      "url": "https://example.com",
      "title": "Test Form",
      "fields": [
        {"index": 0, "type": "text", "label": "First Name", "value": ""}
      ],
      "buttons": [
        {"index": 0, "text": "Submit", "type": "submit"}
      ],
      "pageContext": "Please fill out this form"
    },
    "profile": {
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com"
    }
  }'
```

## Security Notes

- API keys are stored in environment variables (server-side only)
- User profiles are stored in Chrome's local storage
- The extension requires broad permissions for form automation
- Approval gates prevent accidental form submissions

## Troubleshooting

### Agent not filling fields?
1. Check that your profile is saved (Profile tab)
2. Check the browser console for errors
3. Verify the LLM is configured (check server logs)

### LLM errors?
1. Verify your API key is correct
2. Check the `web/.env.local` file
3. For Ollama, ensure it's running: `ollama list`

### Extension not loading?
1. Enable Developer mode in Chrome
2. Check for errors in the extension's service worker
3. Reload the extension after changes
