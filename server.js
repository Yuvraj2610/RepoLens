import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // max requests per IP
  message: {
    error: "Too many requests. Please try again later."
  }
});

app.use("/analyze", limiter);
app.use("/ask", limiter);
app.use("/file", limiter);
app.use(cors({
  origin: [
    "https://your-vercel-domain.vercel.app"
  ]
}));
app.use(express.json({
  limit: "1mb"
}));
dotenv.config();

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});
// ─── In-memory cache ──────────────────────────────────────────────────────────
// Avoids re-fetching GitHub data for the same repo within a session.
// Key: "owner/repo"  Value: { ctx, expiresAt }

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.ctx;
}

function cacheSet(key, ctx) {
  cache.set(key, { ctx, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────

function parseRepoUrl(url) {
  const m = url.trim().match(/github\.com\/([^\/\s]+)\/([^\/\s\?#]+)/);
  if (!m) throw new Error("Invalid GitHub URL");
  return { owner: m[1], repo: m[2] };
}

function ghHeaders(raw = false) {
  const headers = {
    Accept: raw ? "application/vnd.github.v3.raw" : "application/vnd.github.v3+json",
    "User-Agent": "RepoLens/1.0",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function ghFetch(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${path}`);
  return res.json();
}

async function ghRaw(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: ghHeaders(true) });
  if (!res.ok) return "";
  return res.text();
}

// Fetch and assemble full repo context (cached)
async function fetchRepoContext(owner, repo) {
  const cacheKey = `${owner}/${repo}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    console.log(`[cache hit] ${cacheKey}`);
    return cached;
  }

  console.log(`[github] fetching ${cacheKey}`);

  // Parallel fetches — fast, and failures don't crash the whole thing
  const [meta, contents, readme, languages] = await Promise.allSettled([
    ghFetch(`/repos/${owner}/${repo}`),
    ghFetch(`/repos/${owner}/${repo}/contents`),
    ghRaw(`/repos/${owner}/${repo}/readme`),
    ghFetch(`/repos/${owner}/${repo}/languages`),
  ]);

  const m = meta.status === "fulfilled" ? meta.value : {};
  const files = contents.status === "fulfilled" && Array.isArray(contents.value) ? contents.value : [];
  const readmeText = readme.status === "fulfilled" ? readme.value : "";
  const langs = languages.status === "fulfilled" ? languages.value : {};

  // Try to grab config/dependency files (best-effort, in parallel)
  const configNames = ["package.json", "requirements.txt", "Cargo.toml", "go.mod", "pyproject.toml", "composer.json"];
  const foundConfigs = files.filter((f) => configNames.includes(f.name)).map((f) => f.name);

  const configResults = await Promise.allSettled(
    foundConfigs.map((name) => ghRaw(`/repos/${owner}/${repo}/contents/${name}`))
  );

  const configs = {};
  foundConfigs.forEach((name, i) => {
    if (configResults[i].status === "fulfilled") {
      configs[name] = configResults[i].value.slice(0, 1500);
    }
  });

  // Parse dependency names
  let deps = [];
  try {
    if (configs["package.json"]) {
      const pkg = JSON.parse(configs["package.json"]);
      deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).slice(0, 30);
    } else if (configs["requirements.txt"]) {
      deps = configs["requirements.txt"].split("\n").filter(Boolean).slice(0, 30);
    }
  } catch (_) {}

  const tree = files
    .slice(0, 15)
    .map((f) => `${f.type === "dir" ? "📁" : "📄"} ${f.name}`)
    .join("\n");

  const ctx = {
    name: m.full_name || `${owner}/${repo}`,
    description: m.description || "",
    stars: m.stargazers_count ?? 0,
    forks: m.forks_count ?? 0,
    openIssues: m.open_issues_count ?? 0,
    language: m.language || "",
    topics: (m.topics || []).join(", "),
    languages: Object.keys(langs).join(", "),
    license: m.license?.name || "",
    tree,
    files,        // raw file list for /tree route
    deps,
    configs,
    readme: readmeText.slice(0, 1200),
  };

  cacheSet(cacheKey, ctx);
  return ctx;
}

// ─── Mode system prompts ──────────────────────────────────────────────────────

const SYSTEM_PROMPTS = {
  beginner:  "You explain GitHub repositories to complete beginners using simple language, analogies, and zero jargon.",
  developer: "You are a senior developer doing a thorough technical review. Be precise, opinionated, and highlight non-obvious details.",
  architect: "You are a software architect. Focus on design patterns, system boundaries, scalability, coupling, and trade-offs.",
  interview: "You are preparing someone for a technical interview. Give strong talking points, potential gotchas, and realistic interview questions.",
};

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildAnalyzePrompt(ctx, mode) {
  const configBlock = Object.entries(ctx.configs)
    .map(([name, content]) => `--- ${name} ---\n${content}`)
    .join("\n\n");

  return `Analyze this GitHub repository. Return ONLY a valid JSON object — no markdown fences, no preamble, no trailing text.

Repository: ${ctx.name}
Description: ${ctx.description}
Stars: ${ctx.stars.toLocaleString()} | Forks: ${ctx.forks} | Open issues: ${ctx.openIssues}
License: ${ctx.license || "unknown"}
Primary language: ${ctx.language}
All languages: ${ctx.languages}
Topics: ${ctx.topics || "none"}

Top-level file structure:
${ctx.tree}

Dependencies:
${ctx.deps.length ? ctx.deps.join(", ") : "none found"}

Config files:
${configBlock || "none found"}

README (first 4000 chars):
${ctx.readme}

Return exactly this JSON shape — all fields required:
{
  "repoName": "${ctx.name}",
  "description": "one-line description",
  "language": "${ctx.language}",
  "stars": "${ctx.stars.toLocaleString()}",
  "summary": "2-3 sentence summary for ${mode} audience",
  "whatItDoes": "detailed paragraph — purpose, how it works internally, why it exists",
  "techStack": {
    "frontend": ["e.g. React, Next.js, TailwindCSS — only if present, else empty array"],
    "backend": ["e.g. Express.js, Node.js, FastAPI — only if present"],
    "database": ["e.g. MongoDB, PostgreSQL, Redis — only if present"],
    "authentication": ["e.g. JWT, Auth0, Clerk — only if present"],
    "styling": ["e.g. CSS Modules, Styled Components — only if present and not already in frontend"],
    "testing": ["e.g. Jest, Vitest, Pytest — only if present"],
    "deployment": ["e.g. Docker, Vercel, AWS — only if present"],
    "devops": ["e.g. GitHub Actions, CI/CD tools — only if present"],
    "aiml": ["e.g. OpenAI, LangChain, TensorFlow — only if present"]
  },
  "howToRun": "numbered step-by-step setup guide for ${mode} audience",
  "folderExplanation": "explain each top-level folder/file and its role",
  "keyInsights": ["3-4 non-obvious insights for ${mode} audience"],
  "interviewQuestions": ["3-4 questions a ${mode} interviewer might ask about this codebase"]
}`;
}

function buildAskPrompt(ctx, question) {
  return `You are an expert on this GitHub repository: ${ctx.name}

Context:
- Description: ${ctx.description}
- Tech stack: ${ctx.languages}
- Dependencies: ${ctx.deps.join(", ")}
- Structure:\n${ctx.tree}
- README:\n${ctx.readme.slice(0, 2000)}

Answer this question concisely and accurately. Don't invent details you're not sure about.

Question: ${question}`;
}

function buildFilePrompt(ctx, filepath, fileContent, mode) {
  return `You are explaining a source file from the GitHub repo "${ctx.name}" to a ${mode} audience.

Repo: ${ctx.description}
Tech stack: ${ctx.languages}
Dependencies: ${ctx.deps.join(", ")}

File: ${filepath}
\`\`\`
${fileContent.slice(0, 3000)}
\`\`\`

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "filename": "${filepath}",
  "purpose": "one sentence — what this file does",
  "explanation": "paragraph explaining what the code does, how it works, and why it exists",
  "keyParts": ["3-5 important functions, classes, or sections and what each one does"],
  "howItFits": "how this file connects to the rest of the project"
}`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /analyze — full repo analysis
app.post("/analyze", async (req, res) => {
  const { repoUrl, mode = "developer" } = req.body;
  if (!repoUrl) return res.status(400).json({ error: "repoUrl is required" });

  let owner, repo;
  try { ({ owner, repo } = parseRepoUrl(repoUrl)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const ctx = await fetchRepoContext(owner, repo);
    if (ctx.files.length > 120) {
      ctx.tree = ctx.tree.slice(0, 800);
      ctx.readme = ctx.readme.slice(0, 1000);
    }
    // detect very large repos
      const isLargeRepo =
      ctx.readme.length > 3000 ||
      ctx.files.length > 80;

      if (isLargeRepo) {
      console.log("Large repo detected:", ctx.name);
      }
    const completionPromise = openai.chat.completions.create({
      model: "openai/gpt-oss-20b:free",
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.developer },
        { role: "user", content: buildAnalyzePrompt(ctx, mode) },
      ],
      temperature: 0.4,
      max_tokens: mode === "interview" ? 700 : 1000,
    });
    
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("AI timeout")), 250000)
    );
    
    let completion;

    try {
      completion = await Promise.race([
        completionPromise,
        timeoutPromise
      ]);
    } catch (err) {

      console.error("[AI ERROR]", err);

      return res.status(500).json({
        error:
          err.message === "AI timeout"
            ? "AI model took too long to respond for this repository."
            : "AI analysis failed. Try a smaller repository or retry."
      });
    }

    const raw = completion.choices[0].message.content || "";
    let analysis;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      analysis = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] ?? clean);
    } catch (_) {
      return res.json({ raw }); // graceful fallback
    }

    res.json({ analysis });
  } catch (err) {
    console.error("[/analyze]", err.message);
    res.status(err.message?.includes("GitHub 404") ? 404 : 500).json({ error: err.message });
  }
});

// POST /ask — follow-up question about a repo
app.post("/ask", async (req, res) => {
  const { repoUrl, question, mode = "developer" } = req.body;
  if (!repoUrl || !question) {
    return res.status(400).json({ error: "repoUrl and question are required" });
  }

  let owner, repo;
  try { ({ owner, repo } = parseRepoUrl(repoUrl)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const ctx = await fetchRepoContext(owner, repo);

    const completionPromise = openai.chat.completions.create({
      model: "openai/gpt-oss-20b:free",
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.developer },
        { role: "user", content: buildAnalyzePrompt(ctx, mode) },
      ],
      temperature: 0.4,
      max_tokens: mode === "interview" ? 700 : 1000,
    });
    
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("AI timeout")), 250000)
    );
    
    const completion = await Promise.race([
      completionPromise,
      timeoutPromise
    ]);

    res.json({ answer: completion.choices[0].message.content || "" });
  } catch (err) {
    console.error("[/ask]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /file — explain a specific file in the repo
app.post("/file", async (req, res) => {
  const { repoUrl, filepath, mode = "developer" } = req.body;
  if (!repoUrl || !filepath) {
    return res.status(400).json({ error: "repoUrl and filepath are required" });
  }

  let owner, repo;
  try { ({ owner, repo } = parseRepoUrl(repoUrl)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const [ctx, fileContent] = await Promise.all([
      fetchRepoContext(owner, repo),
      ghRaw(`/repos/${owner}/${repo}/contents/${filepath}`),
    ]);

    if (!fileContent) return res.status(404).json({ error: `File not found: ${filepath}` });

    const completionPromise = openai.chat.completions.create({
      model: "openai/gpt-oss-20b:free",
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[mode] || SYSTEM_PROMPTS.developer },
        { role: "user", content: buildAnalyzePrompt(ctx, mode) },
      ],
      temperature: 0.4,
      max_tokens: mode === "interview" ? 700 : 1000,
    });
    
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("AI timeout")), 250000)
    );
    
    const completion = await Promise.race([
      completionPromise,
      timeoutPromise
    ]);

    const raw = completion.choices[0].message.content || "";
    let fileAnalysis;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      fileAnalysis = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] ?? clean);
    } catch (_) {
      return res.json({ raw });
    }

    res.json({ fileAnalysis });
  } catch (err) {
    console.error("[/file]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /tree — return the clickable file list for a repo
app.get("/tree", async (req, res) => {
  const { repoUrl } = req.query;
  if (!repoUrl) return res.status(400).json({ error: "repoUrl query param required" });

  let owner, repo;
  try { ({ owner, repo } = parseRepoUrl(repoUrl)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const ctx = await fetchRepoContext(owner, repo);
    res.json({
      files: ctx.files.map((f) => ({
        name: f.name,
        type: f.type,   // "file" or "dir"
        path: f.path,
        size: f.size,
      })),
    });
  } catch (err) {
    console.error("[/tree]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /contents — fetch contents of any folder path within a repo
app.get("/contents", async (req, res) => {
  const { repoUrl, path: folderPath = "" } = req.query;
  if (!repoUrl) return res.status(400).json({ error: "repoUrl query param required" });

  let owner, repo;
  try { ({ owner, repo } = parseRepoUrl(repoUrl)); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const apiPath = folderPath
      ? `/repos/${owner}/${repo}/contents/${folderPath}`
      : `/repos/${owner}/${repo}/contents`;
    const contents = await ghFetch(apiPath);
    if (!Array.isArray(contents)) return res.status(400).json({ error: "Path is not a directory" });

    const files = contents.map((f) => ({
      name: f.name,
      type: f.type,   // "file" or "dir"
      path: f.path,
      size: f.size,
    }));

    res.json({ files });
  } catch (err) {
    console.error("[/contents]", err.message);
    res.status(err.message?.includes("GitHub 404") ? 404 : 500).json({ error: err.message });
  }
});

// GET /health
app.get("/health", (_req, res) => {
  res.json({ ok: true, cachedRepos: cache.size, uptime: process.uptime().toFixed(1) + "s" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ RepoLens backend → http://localhost:${PORT}`);
  console.log(`   POST /analyze   — full repo analysis`);
  console.log(`   POST /ask       — follow-up questions`);
  console.log(`   POST /file      — explain a specific file`);
  console.log(`   GET  /tree      — file tree for a repo`);
  console.log(`   GET  /health    — server status\n`);
});
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});