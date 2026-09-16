import express from "express";
import Resume from "../models/Resume_Schema.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import { generateLatex } from "../services/latex/tex_generator.js";
import { compileToPDF } from "../services/latex/tex_compiler.js";
import { DEFAULT_DOMAIN, DEFAULT_LAYOUT } from "../config/domains.js";

const router = express.Router();

// All resume routes require authentication
router.use(protect);

// ── GET /api/resumes ───────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const resumes = await Resume.find({ user: req.user._id }).sort({ updatedAt: -1 });
    res.json({ success: true, resumes });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/resumes ──────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const count = await Resume.countDocuments({ user: req.user._id });

    // Enforce limits for free users
    if (user.subscription.plan === "free" && count >= user.usage.resumesLimit) {
      return res.status(403).json({
        error: `Free plan allows only ${user.usage.resumesLimit} resumes. Upgrade to Pro.`,
        code: "RESUME_LIMIT",
      });
    }

    const resume = await Resume.create({
      user: req.user._id,
      title: req.body.title || "My Resume",
      domain: req.body.domain || DEFAULT_DOMAIN,
      templateId: req.body.templateId || DEFAULT_LAYOUT,
      content: req.body.content || {},
    });

    res.status(201).json({ success: true, resume });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/resumes/:id ───────────────────────────────────────
router.get("/:id", async (req, res, next) => {
  try {
    const resume = await Resume.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!resume) return res.status(404).json({ error: "Resume not found." });
    res.json({ success: true, resume });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/resumes/:id ─────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { title, domain, templateId, content, atsScore } = req.body;

    const resume = await Resume.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      {
        ...(title !== undefined && { title }),
        ...(domain !== undefined && { domain }),
        ...(templateId !== undefined && { templateId }),
        ...(content !== undefined && { content }),
        ...(atsScore !== undefined && { atsScore }),
      },
      { new: true, runValidators: true }
    );

    if (!resume) return res.status(404).json({ error: "Resume not found." });
    res.json({ success: true, resume });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/resumes/:id ────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const resume = await Resume.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!resume) return res.status(404).json({ error: "Resume not found." });
    res.json({ success: true, message: "Resume deleted." });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/resumes/:id/duplicate ───────────────────────────
router.post("/:id/duplicate", async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const count = await Resume.countDocuments({ user: req.user._id });

    if (user.subscription.plan === "free" && count >= user.usage.resumesLimit) {
      return res.status(403).json({
        error: "Resume limit reached. Upgrade to Pro.",
        code: "RESUME_LIMIT",
      });
    }

    const original = await Resume.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!original) return res.status(404).json({ error: "Resume not found." });

    const duplicate = await Resume.create({
      user: req.user._id,
      title: `${original.title} (Copy)`,
      domain: original.domain,
      templateId: original.templateId,
      content: original.content,
    });

    res.status(201).json({ success: true, resume: duplicate });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/resumes/:id/download ────────────────────────────
router.post("/:id/download", async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);

    if (
      user.subscription.plan === "free" &&
      user.usage.downloadsCount >= user.usage.downloadsLimit
    ) {
      return res.status(403).json({
        error: `Download limit reached (${user.usage.downloadsLimit} on free plan).`,
        code: "DOWNLOAD_LIMIT",
      });
    }

    const resume = await Resume.findOne({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!resume) return res.status(404).json({ error: "Resume not found." });

    // latex -> pdf blob
    const latex = generateLatex(resume.toObject(), { isPro: user.isPro });
    // blob -> downloable pdf
    const pdf = await compileToPDF(latex);

    const updatedUser = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        "usage.downloadsCount": { $lt: user.usage.downloadsLimit },
      },
      { $inc: { "usage.downloadsCount": 1 } },
      { new: true }
    );
    if (!updatedUser) {
      return res.status(403).json({
        error: `Download limit reached (${user.usage.downloadsLimit} on free plan).`,
        code: "DOWNLOAD_LIMIT",
      });
    }

    await Resume.updateOne(
      { _id: resume._id },
      { $inc: { downloads: 1 }, $set: { lastExportedAt: new Date() } }
    );

    const filename = `${(resume.title || "Resume")
      .replace(/[^a-z0-9 _-]/gi, "")
      .trim() || "Resume"}.pdf`;
    res.set({
      "Content-Type": "application/pdf",
      "Content-Length": pdf.length,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
    });
    res.send(pdf);
  } catch (err) {
    next(err);
  }
});

export default router;
