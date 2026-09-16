import express from "express";
import OpenAI from "openai";
import { protect, checkAICredits } from "../middleware/auth.js";
import User from "../models/User.js";
import dotenv from "dotenv";
import { domainPromptContext } from "../config/domain-keywords.js";
import { DOMAINS, DEFAULT_DOMAIN } from "../config/domains.js";
import { logger } from "../services/logging/logger.js";
const router = express.Router();
router.use(protect, checkAICredits);

// Initialize the OpenRouter client lazily on first use. OpenRouter's API
// is OpenAI-compatible (it routes to 300+ underlying models), so the
// official `openai` SDK works unmodified — just point baseURL at
// openrouter.ai and use an OPENROUTER_API_KEY.
// Model id is configurable via OPENROUTER_MODEL. Defaults to
// "openrouter/free" — OpenRouter's own router that auto-selects a
// currently-available free model, so this stays working even as
// OpenRouter's specific free-tier model lineup changes over time. Pin
// a specific model instead (e.g. "meta-llama/llama-3.1-8b-instruct:free")
// if you want consistent behavior — see https://openrouter.ai/models?max_price=0
// for the current free list.
let openrouter = null;
function getOpenRouterClient() {
  if (!openrouter) {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error("OPENROUTER_API_KEY is not set in environment variables");
    }
    openrouter = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      // Optional but recommended by OpenRouter — attributes usage to your
      // app for their leaderboards and can affect rate limits on free
      // models. Harmless if these env vars aren't set.
      defaultHeaders: {
        "HTTP-Referer": process.env.CLIENT_URL || "http://localhost:5173",
        "X-Title": "ResumeCraft",
      },
    });
  }
  return openrouter;
}
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

// ── Prompts ────────────────────────────────────────────────────
// Every prompt function now takes `domain` and appends a domain-context
// fragment (persona + relevant keyword bank) built by domainPromptContext.
// Falls through to "" for unknown/missing domains, so requests from
// older clients that don't send a domain still work exactly as before.

// Introducing Summary Structure to make Generations more deterministic
const SUMMARY_STRUCTURE = `
Structure:
1. Achievement opener — one quantified achievement, credential, or strong claim ("Built X used by Y", "3x founder", "Top 1% on X platform")
2. Role stack — 2-4 roles/identities, comma-separated, ordered by relevance
3. Interest triplet — exactly 3 specific interests that imply values, not just skills

Style:
- Name the actual activity, not the category ("CTF player" not "cybersecurity enthusiast")
- Triplet rhythm — two feels thin, four feels like a list
- Interests should imply values without stating them
- ATS-optimized: include domain-relevant keywords naturally
- 3-4 sentences total
- Never use: "results-driven", "self-starter", "passionate about", "dynamic", "detail-oriented"
`
// More Grounded, Uniform Prompting.

const PROMPTS = {
  improve_summary: ({ content, jobTitle, domain }) => `
You are an expert resume writer. Improve this professional summary for a ${jobTitle || "professional"}.
${domainPromptContext(domain)}
${SUMMARY_STRUCTURE}
If no strong metric exists, open with a credential or recognition instead.
Return ONLY the improved summary text, nothing else.

ORIGINAL: ${content}`,

  generate_summary: ({ content, jobTitle, domain }) => `
You are an expert resume writer. Write a professional summary for a ${jobTitle || "professional"}.
${domainPromptContext(domain)}
${SUMMARY_STRUCTURE}
Based on their experience: ${content}
If no strong metric exists, open with a credential or recognition instead.
Return ONLY the summary text, nothing else.`,

  improve_bullets: ({ content, domain }) => `
You are an expert resume writer. Transform these job description points into powerful resume bullets.
${domainPromptContext(domain)}
Rules:
- Start each with a strong action verb (Led, Built, Engineered, Increased, Reduced, etc.)
- Add quantifiable metrics where reasonable (%, $, numbers, time)
- Keep each bullet under 20 words
- Make them ATS-friendly
Return ONLY the bullets, one per line, each starting with a dash (-). No other text.

ORIGINAL:
${content}`,

  generate_bullets: ({ content, jobTitle, domain }) => `
You are an expert resume writer. Generate 4-5 strong resume bullet points for this role.
${domainPromptContext(domain)}
Position: ${jobTitle || "the role"}
Details: ${content}
Rules:
- Strong action verbs
- Include realistic metrics
- ATS-optimized
Return ONLY the bullets, one per line starting with dash (-). No other text.`,

  tailor_to_job: ({ content, context, domain }) => `
You are an expert resume writer. Tailor this resume content to match the job description.
${domainPromptContext(domain)}
- Identify and incorporate keywords from the job description naturally
- Reframe experience to match the role's requirements
- Keep all facts truthful, just reframed
Return ONLY the tailored content, no explanations.

JOB DESCRIPTION:
${context}

RESUME CONTENT:
${content}`,

  improve_skills: ({ content, domain }) => `
You are an expert resume writer. Review and optimize this skills section.
${domainPromptContext(domain)}
- Group skills logically by category
- Add relevant industry-standard skills that complement existing ones
- Remove redundant or outdated skills
Return ONLY a JSON array like: [{"category": "Programming", "items": ["Python", "JavaScript"]}]
No markdown, no explanation, pure JSON only.

CURRENT SKILLS: ${content}`,
};

// const PROMPTS = {
//   improve_summary: ({ content, jobTitle, domain }) => `
// You are an expert resume writer. Improve this professional summary for a ${jobTitle || "professional"}.
// ${domainPromptContext(domain)}
// Requirements:
// - 3-4 sentences maximum
// - Start with a strong action word or impressive credential
// - Include relevant skills and value proposition
// - ATS-optimized with keywords
// - Do NOT use generic phrases like "results-driven" or "self-starter"
// Return ONLY the improved summary text, nothing else.

// ORIGINAL: ${content}`,

//   generate_summary: ({ content, jobTitle, domain }) => `
// You are an expert resume writer. Write a compelling professional summary for a ${jobTitle || "professional"}.
// ${domainPromptContext(domain)}
// Based on their experience: ${content}
// To better enhance grounding, refer to ${context_prompts} to identify the sentence structure, framing and vocabulary used to convey one's identiy. Use only the ideas and not the explicit content.
// Requirements:
// - 3-4 sentences
// - Specific and impressive
// - ATS-friendly
// Return ONLY the summary text, nothing else.`,

//   improve_bullets: ({ content, domain }) => `
// You are an expert resume writer. Transform these job description points into powerful resume bullets.
// ${domainPromptContext(domain)}
// Rules:
// - Start each with a strong action verb (Led, Built, Engineered, Increased, Reduced, etc.)
// - Add quantifiable metrics where reasonable (%, $, numbers, time)
// - Keep each bullet under 20 words
// - Make them ATS-friendly
// Return ONLY the bullets, one per line, each starting with a dash (-). No other text.

// ORIGINAL:
// ${content}`,

//   generate_bullets: ({ content, jobTitle, domain }) => `
// You are an expert resume writer. Generate 4-5 strong resume bullet points for this role.
// ${domainPromptContext(domain)}
// Position: ${jobTitle || "the role"}
// Details: ${content}
// Rules:
// - Strong action verbs
// - Include realistic metrics
// - ATS-optimized
// Return ONLY the bullets, one per line starting with dash (-). No other text.`,

//   tailor_to_job: ({ content, context, domain }) => `
// You are an expert resume writer. Tailor this resume content to match the job description.
// ${domainPromptContext(domain)}
// - Identify and incorporate keywords from the job description naturally
// - Reframe experience to match the role's requirements  
// - Keep all facts truthful, just reframed
// Return ONLY the tailored content, no explanations.

// JOB DESCRIPTION:
// ${context}

// RESUME CONTENT:
// ${content}`,

//   improve_skills: ({ content, domain }) => `
// You are an expert resume writer. Review and optimize this skills section.
// ${domainPromptContext(domain)}
// - Group skills logically by category
// - Add relevant industry-standard skills that complement existing ones
// - Remove redundant or outdated skills
// Return ONLY a JSON array like: [{"category": "Programming", "items": ["Python", "JavaScript"]}]
// No markdown, no explanation, pure JSON only.

// CURRENT SKILLS: ${content}`,
// };

// ── POST /api/ai/generate ──────────────────────────────────────
router.post("/generate", async (req, res, next) => {
  try {
    const { action, content, jobTitle, context, domain } = req.body;

    if (!action || !content) {
      return res.status(400).json({ error: "action and content are required." });
    }

    if (!PROMPTS[action]) {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    const prompt = PROMPTS[action]({ content, jobTitle, context, domain });

    // Use OpenRouter, via the OpenAI-compatible chat completions API
    const completion = await getOpenRouterClient().chat.completions.create({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    });
    const text = completion.choices?.[0]?.message?.content?.trim() || "";

    // Increment AI credits used
    await User.findByIdAndUpdate(req.user._id, {
      $inc: { "usage.aiCreditsUsed": 1 },
    });

    const updatedUser = await User.findById(req.user._id);

    res.json({
      success: true,
      result: text,
      creditsUsed: updatedUser.usage.aiCreditsUsed,
      creditsLimit: updatedUser.usage.aiCreditsLimit,
    });
  } catch (err) {
    logger.error("OpenRouter AI error", { error: err.message });
    if (err.message?.includes("API_KEY") || err.message?.includes("api_key") || err.status === 401) {
      return res.status(500).json({ error: "AI service configuration error." });
    }
    if (err.status === 429 || err.message?.includes("quota") || err.message?.includes("rate limit")) {
      return res.status(429).json({ error: "AI quota exceeded. Please try again later." });
    }
    next(err);
  }
});

// ── POST /api/ai/suggest-domain ─────────────────────────────────
// Feature: "which domain fits my background?" — the reverse of the
// domain quiz. A student pastes free-text about what they've done
// (projects, coursework, internships) and an LLM suggests the best-fit
// domain(s) with a short reason each. Kept as its own endpoint rather
// than a generic PROMPTS action because the response is structured
// JSON that we validate against the canonical domain list before
// returning — an unvalidated hallucinated domain id would silently
// break the client's domain-to-layout lookup.
router.post("/suggest-domain", async (req, res, next) => {
  try {
    const { background } = req.body;
    if (!background || background.trim().length < 20) {
      return res.status(400).json({ error: "Please describe your background in a bit more detail (projects, coursework, internships)." });
    }

    const domainIds = DOMAINS.map((d) => d.id).join(", ");
    const prompt = `You are a career advisor helping a CS student figure out which specialization fits their background.

Valid domain ids (use ONLY these, exactly as spelled): ${domainIds}

Based on the student's background below, return the top 2 best-fit domains ranked by fit, each with a one-sentence reason a student would understand.

Return ONLY valid JSON in this exact shape, no markdown, no explanation:
[{"domain": "ai-ml", "reason": "..."}, {"domain": "swe", "reason": "..."}]

STUDENT BACKGROUND:
${background}`;

    const completion = await getOpenRouterClient().chat.completions.create({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
    });
    const raw = completion.choices?.[0]?.message?.content?.trim() || "[]";

    let suggestions;
    try {
      // Some free/smaller models wrap JSON in markdown fences despite instructions —
      // strip them defensively before parsing.
      const cleaned = raw.replace(/^```json\s*|```\s*$/g, "").trim();
      suggestions = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.warn("suggest-domain: failed to parse AI JSON response", { raw: raw.slice(0, 300) });
      return res.status(502).json({ error: "Couldn't process the AI response. Please try again." });
    }

    const validIds = new Set(DOMAINS.map((d) => d.id));
    const validated = (Array.isArray(suggestions) ? suggestions : [])
      .filter((s) => s && validIds.has(s.domain))
      .slice(0, 2);

    if (validated.length === 0) {
      // Never let a hallucinated/invalid response reach the client silently —
      // fall back to a safe, generic default rather than a broken suggestion.
      validated.push({ domain: DEFAULT_DOMAIN, reason: "Based on a general CS background — feel free to browse other domains too." });
    }

    await User.findByIdAndUpdate(req.user._id, { $inc: { "usage.aiCreditsUsed": 1 } });
    const updatedUser = await User.findById(req.user._id);

    res.json({
      success: true,
      suggestions: validated,
      creditsUsed: updatedUser.usage.aiCreditsUsed,
      creditsLimit: updatedUser.usage.aiCreditsLimit,
    });
  } catch (err) {
    logger.error("suggest-domain error", { error: err.message });
    if (err.status === 401) return res.status(500).json({ error: "AI service configuration error." });
    if (err.status === 429) return res.status(429).json({ error: "AI quota exceeded. Please try again later." });
    next(err);
  }
});

// ── GET /api/ai/credits ────────────────────────────────────────
router.get("/credits", protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json({
    success: true,
    used: user.usage.aiCreditsUsed,
    limit: user.usage.aiCreditsLimit,
    remaining: user.usage.aiCreditsLimit - user.usage.aiCreditsUsed,
  });
});

export default router;
