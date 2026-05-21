# RepoLens 🔍

AI-powered GitHub repository analyzer. Paste a repo URL → get a full breakdown: summary, tech stack, setup guide, folder structure, and interview questions. Powered by GitHub API + OpenAI.

## Architecture

```
Browser (index.html)
      ↓ POST /analyze
Express Backend (server.js)
      ↓ GitHub REST API (metadata, README, file tree, languages)
      ↓ OpenAI API (structured JSON analysis)
      ↑ JSON response
Browser renders results
```

## Quick Start

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env — add your OPENAI_API_KEY (and optionally GITHUB_TOKEN)
npm run dev
```

Backend runs at **http://localhost:3000**

### 2. Frontend

Just open `frontend/index.html` in your browser. No build step needed.

Or serve it:
```bash
cd frontend
npx serve .
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | ✅ Yes | Get from [platform.openai.com](https://platform.openai.com/api-keys) |
| `GITHUB_TOKEN` | Recommended | Raises rate limit from 60 → 5000 req/hr. Get from [github.com/settings/tokens](https://github.com/settings/tokens) (no scopes needed for public repos) |
| `PORT` | No | Defaults to 3000 |

## What the backend fetches from GitHub

Before sending anything to OpenAI, the backend fetches real data:

- **Repo metadata** — name, description, stars, forks, language, topics
- **Top-level file/folder structure** — up to 25 items
- **README** — first 3500 characters
- **package.json** — parsed for dependency list
- **Language breakdown** — all languages used

This gives OpenAI *real context* instead of just a URL — much better results.

## Modes

| Mode | Best for |
|---|---|
| 👶 Beginner | New devs, non-technical explanations |
| 💻 Developer | Technical deep-dive, patterns, implementation |
| 🏗 Architect | System design, scalability, trade-offs |
| 🎯 Interview Prep | Talking points, likely interview questions |

## Project Structure

```
repolens/
├── backend/
│   ├── server.js        # Express server + GitHub + OpenAI logic
│   ├── package.json
│   ├── .env.example     # Copy to .env and fill in your keys
│   └── .gitignore
└── frontend/
    └── index.html       # Standalone HTML/CSS/JS — no framework needed
```

## Deploying

**Backend → [Render](https://render.com)**
- New Web Service → connect your repo
- Build command: `npm install`
- Start command: `npm start`
- Add env vars in Render dashboard

**Frontend → [Vercel](https://vercel.com) or [Netlify](https://netlify.com)**
- Deploy the `frontend/` folder
- Update `API_BASE` in `index.html` to your Render URL

## Resume Description

> "Built an AI-powered GitHub repository analysis platform that parses repository metadata, README files, language breakdowns, and project structures via the GitHub REST API, then generates architectural explanations, tech stack summaries, and interview prep material using OpenAI GPT-4.1-mini."
