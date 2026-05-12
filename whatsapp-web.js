require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const { OpenAI } = require("openai");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");
const FormData = require("form-data");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static("public"));
app.use(express.json());

// ========== CONFIG ==========
const API_BASE = process.env.API_BASE || "http://localhost:5000";
const ADMIN_ID = process.env.ADMIN_ID || "";
const PORT = process.env.PORT || 3001;
const WHISPER_API_KEY =
  process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY || "";

// ========== LOGGER ==========
function log(level, msg, data = "") {
  const icons = {
    info: "ℹ️",
    success: "✅",
    warn: "⚠️",
    error: "❌",
    msg: "📩",
    ai: "🤖",
    vision: "🔍",
    router: "🔁",
    voice: "🎤",
    mood: "😊",
    multimodal: "🧠",
  };
  const ts = new Date().toLocaleTimeString("en-BD", { timeZone: "Asia/Dhaka" });
  console.log(`[${ts}] ${icons[level] || "•"} ${msg}`, data);
}

// ══════════════════════════════════════════════════════════════════════
// 🎤  VOICE TRANSCRIPTION (Whisper)
// ══════════════════════════════════════════════════════════════════════
async function transcribeVoice(audioBuffer, mimeType = "audio/ogg") {
  if (!WHISPER_API_KEY) {
    log("warn", "No Whisper API key — skipping transcription");
    return null;
  }
  try {
    log("voice", "Transcribing voice message via Whisper...");
    const ext = mimeType.includes("ogg")
      ? "ogg"
      : mimeType.includes("mp4")
        ? "mp4"
        : "oga";
    const tmpPath = `/tmp/voice_${Date.now()}.${ext}`;
    fs.writeFileSync(tmpPath, Buffer.from(audioBuffer, "base64"));

    const form = new FormData();
    form.append("file", fs.createReadStream(tmpPath), {
      filename: `voice.${ext}`,
      contentType: mimeType,
    });
    form.append("model", "whisper-1");
    form.append("language", "bn"); // Bengali first, but Whisper auto-detects

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHISPER_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    fs.unlinkSync(tmpPath);

    if (!res.ok) {
      const err = await res.text();
      log("error", `Whisper error: ${err}`);
      return null;
    }

    const data = await res.json();
    const text = data.text?.trim();
    log("success", `Voice transcribed: "${text?.substring(0, 60)}"`);
    return text || null;
  } catch (err) {
    log("error", `Transcription failed: ${err.message}`);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════
// 😊  MOOD DETECTION ENGINE
// ══════════════════════════════════════════════════════════════════════
function detectMood(text) {
  const t = text.toLowerCase();

  const moods = {
    angry: [
      "রাগ",
      "বিরক্ত",
      "কেন",
      "কি সমস্যা",
      "ভুল",
      "খারাপ",
      "worst",
      "terrible",
      "angry",
      "frustrated",
      "বাজে",
      "ফালতু",
    ],
    sad: [
      "কষ্ট",
      "দুঃখ",
      "মন খারাপ",
      "sad",
      "unhappy",
      "কাঁদছি",
      "একা",
      "ব্যথা",
    ],
    confused: [
      "বুঝলাম না",
      "confuse",
      "বুঝি না",
      "মানে কী",
      "কীভাবে",
      "explain",
      "কি করব",
    ],
    happy: [
      "thanks",
      "ধন্যবাদ",
      "ভালো",
      "awesome",
      "great",
      "perfect",
      "😊",
      "😍",
      "❤️",
      "ভালোবাসি",
      "সুন্দর",
    ],
    curious: [
      "কি",
      "কেন",
      "কীভাবে",
      "কোথায়",
      "কখন",
      "tell me",
      "জানতে চাই",
      "বলো",
    ],
    urgent: [
      "urgent",
      "জরুরি",
      "এখনই",
      "asap",
      "fast",
      "quickly",
      "তাড়াতাড়ি",
    ],
  };

  for (const [mood, keywords] of Object.entries(moods)) {
    if (keywords.some((kw) => t.includes(kw))) return mood;
  }
  return "neutral";
}

function getMoodTone(mood) {
  const tones = {
    angry: "User রাগান্বিত। সাথে সাথে মাফ চাও, সমস্যা সমাধানে focus করো।",
    sad: "User মন খারাপ। সহানুভূতি দেখাও, gentle হও।",
    confused: "User confused। Simply বুঝিয়ে দাও, step by step।",
    happy: "User খুশি। Energetic, positive হও।",
    curious: "User curious। Detailed কিন্তু interesting উত্তর দাও।",
    urgent: "User urgent বিষয়ে বলছে। দ্রুত সরাসরি উত্তর দাও।",
    neutral: "",
  };
  return tones[mood] || "";
}

// ══════════════════════════════════════════════════════════════════════
// 🌐  LANGUAGE DETECTOR
// ══════════════════════════════════════════════════════════════════════
function detectLanguageStyle(text) {
  const hasBangla = /[\u0980-\u09FF]/.test(text);
  const hasEnglish = /[a-zA-Z]/.test(text);

  if (hasBangla && hasEnglish) return "banglish";
  if (hasBangla) return "bangla";
  if (hasEnglish) return "english";
  return "banglish";
}

function getLanguageInstruction(style) {
  const instructions = {
    bangla: "User বাংলায় কথা বলছে। তুমিও বাংলায় reply দাও।",
    banglish:
      "User Banglish-এ কথা বলছে। তুমিও Banglish-এ reply দাও (বাংলা + English mix)।",
    english: "User English-এ কথা বলছে। তুমিও English-এ reply দাও।",
  };
  return instructions[style] || "";
}

// ══════════════════════════════════════════════════════════════════════
// 🔁  MULTI-PROVIDER AI ROUTER
// ══════════════════════════════════════════════════════════════════════
class AIRouter {
  constructor() {
    this.cooldowns = new Map();
    this.RATE_COOLDOWN = 65 * 1000;
    this.MODEL_COOLDOWN = 10 * 60 * 1000;
    this.providers = this._buildProviders();
  }

  _getKeys(prefix, max = 15) {
    const keys = new Set();
    for (let i = 1; i <= max; i++) {
      const k = process.env[`${prefix}${i}`];
      if (k?.trim()) keys.add(k.trim());
    }
    const base = process.env[prefix];
    if (base?.trim()) keys.add(base.trim());
    return [...keys].filter(Boolean);
  }

  _buildProviders() {
    return [
      {
        name: "groq",
        type: "openai",
        baseURL: "https://api.groq.com/openai/v1",
        keys: this._getKeys("GROQ_API_KEY", 12),
        models: [
          "llama-3.3-70b-versatile",
          "llama-3.1-8b-instant",
          "gemma2-9b-it",
          "mixtral-8x7b-32768",
        ],
        priority: 1,
        maxTokens: 250,
      },
      {
        name: "openrouter",
        type: "openai",
        baseURL: "https://openrouter.ai/api/v1",
        keys: this._getKeys("OPENROUTER_API_KEY", 4),
        models: [
          "nvidia/nemotron-3-super:free",
          "arcee-ai/trinity-large-preview:free",
          "openai/gpt-oss-120b:free",
          "minimax/minimax-m2.5:free",
          "google/gemma-4-31b:free",
          "google/gemma-4-26b-a4b:free",
          "z-ai/glm-4.5-air:free",
        ],
        priority: 2,
        maxTokens: 250,
        extraHeaders: {
          "HTTP-Referer": "https://nobodeal-bd.web.app/",
          "X-Title": "Nobo Deal Bot",
        },
      },
      {
        name: "fireworks",
        type: "openai",
        baseURL: "https://api.fireworks.ai/inference/v1",
        keys: this._getKeys("Fireworks_API_KEY", 3),
        models: [
          "accounts/fireworks/models/llama-v3p3-70b-instruct",
          "accounts/fireworks/models/llama-v3p1-8b-instruct",
        ],
        priority: 3,
        maxTokens: 250,
      },
      {
        name: "cohere",
        type: "openai",
        baseURL: "https://api.cohere.com/compatibility/v1",
        keys: this._getKeys("COHERE_KEY", 12),
        models: ["command-r-plus", "command-r", "command-light"],
        priority: 4,
        maxTokens: 250,
      },
    ].filter((p) => p.keys.length > 0);
  }

  _cdKey(name, ki, model) {
    return `${name}:${ki}:${model}`;
  }

  _isAvailable(name, ki, model) {
    const k = this._cdKey(name, ki, model);
    const until = this.cooldowns.get(k);
    if (!until) return true;
    if (Date.now() > until) {
      this.cooldowns.delete(k);
      return true;
    }
    return false;
  }

  _markCooling(name, ki, model, ms) {
    this.cooldowns.set(this._cdKey(name, ki, model), Date.now() + ms);
    log(
      "warn",
      `⏳ ${name}[k${ki + 1}]/${model.split("/").pop()} cooling ${ms / 1000}s`,
    );
  }

  _isRateLimit(err) {
    const s = err?.status || err?.response?.status;
    const m = (err?.message || "").toLowerCase();
    return (
      s === 429 ||
      m.includes("rate limit") ||
      m.includes("quota") ||
      m.includes("too many") ||
      m.includes("rpm") ||
      m.includes("daily limit")
    );
  }

  _isUnavailable(err) {
    const s = err?.status || err?.response?.status;
    const m = (err?.message || "").toLowerCase();
    return (
      s === 503 ||
      s === 404 ||
      m.includes("unavailable") ||
      m.includes("not found") ||
      m.includes("deprecated") ||
      m.includes("model")
    );
  }

  async chat(systemPrompt, messages, { temperature = 0.8 } = {}) {
    const providers = [...this.providers].sort(
      (a, b) => a.priority - b.priority,
    );

    for (const p of providers) {
      for (let ki = 0; ki < p.keys.length; ki++) {
        for (const model of p.models) {
          if (!this._isAvailable(p.name, ki, model)) continue;
          try {
            log("router", `${p.name}[k${ki + 1}] → ${model.split("/").pop()}`);
            const client = new OpenAI({
              baseURL: p.baseURL,
              apiKey: p.keys[ki],
              defaultHeaders: p.extraHeaders || {},
              timeout: 18000,
            });
            const res = await client.chat.completions.create({
              model,
              max_tokens: p.maxTokens || 250,
              temperature,
              messages: [
                { role: "system", content: systemPrompt },
                ...messages,
              ],
            });
            const reply = res.choices?.[0]?.message?.content?.trim();
            if (!reply) {
              log("warn", `Empty reply from ${p.name}/${model}`);
              continue;
            }
            log("success", `${p.name}/${model.split("/").pop()} ✓`);
            return { reply, provider: p.name, model };
          } catch (err) {
            if (this._isRateLimit(err))
              this._markCooling(p.name, ki, model, this.RATE_COOLDOWN);
            else if (this._isUnavailable(err))
              this._markCooling(p.name, ki, model, this.MODEL_COOLDOWN);
            else
              log(
                "error",
                `${p.name}[k${ki + 1}]/${model}: ${err.message?.slice(0, 80)}`,
              );
          }
        }
      }
    }
    return null;
  }

  // ── Vision: OpenRouter multimodal ──────────────────────────────────
  async vision(base64Image) {
    const orProvider = this.providers.find((p) => p.name === "openrouter");
    if (!orProvider) return null;

    const visionModels = [
      "nvidia/nemotron-nano-12b-2-vl:free",
      "google/gemma-4-31b:free",
      "google/gemma-4-26b-a4b:free",
    ];

    for (let ki = 0; ki < orProvider.keys.length; ki++) {
      for (const model of visionModels) {
        if (!this._isAvailable("openrouter-vision", ki, model)) continue;
        try {
          log("vision", `${model.split("/").pop()}`);
          const client = new OpenAI({
            baseURL: orProvider.baseURL,
            apiKey: orProvider.keys[ki],
            defaultHeaders: orProvider.extraHeaders || {},
            timeout: 20000,
          });
          const res = await client.chat.completions.create({
            model,
            max_tokens: 150,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Describe what you see in this image in detail. If it's a product, mention the product name. If it's a scene, describe it. If there's text, read it. Reply concisely.",
                  },
                  {
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${base64Image}` },
                  },
                ],
              },
            ],
          });
          const desc = res.choices?.[0]?.message?.content?.trim();
          if (desc) {
            log("success", `Vision described: ${desc.substring(0, 60)}`);
            return desc;
          }
        } catch (err) {
          if (this._isRateLimit(err))
            this._markCooling(
              "openrouter-vision",
              ki,
              model,
              this.RATE_COOLDOWN,
            );
          else
            this._markCooling(
              "openrouter-vision",
              ki,
              model,
              this.MODEL_COOLDOWN,
            );
        }
      }
    }
    return null;
  }

  // ── Vision for product identification only ─────────────────────────
  async visionProduct(base64Image) {
    const orProvider = this.providers.find((p) => p.name === "openrouter");
    if (!orProvider) return null;
    const visionModels = [
      "nvidia/nemotron-nano-12b-2-vl:free",
      "google/gemma-4-31b:free",
      "google/gemma-4-26b-a4b:free",
    ];
    for (let ki = 0; ki < orProvider.keys.length; ki++) {
      for (const model of visionModels) {
        if (!this._isAvailable("openrouter-vision", ki, model)) continue;
        try {
          const client = new OpenAI({
            baseURL: orProvider.baseURL,
            apiKey: orProvider.keys[ki],
            defaultHeaders: orProvider.extraHeaders || {},
            timeout: 20000,
          });
          const res = await client.chat.completions.create({
            model,
            max_tokens: 100,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "What product is shown? Reply with product name only. If not a product, say 'unknown'.",
                  },
                  {
                    type: "image_url",
                    image_url: { url: `data:image/jpeg;base64,${base64Image}` },
                  },
                ],
              },
            ],
          });
          const name = res.choices?.[0]?.message?.content?.trim();
          if (name && name.toLowerCase() !== "unknown") {
            log("success", `Vision product: ${name}`);
            return name.replace(/[^\w\s\-()]/g, "").trim();
          }
        } catch (err) {
          if (this._isRateLimit(err))
            this._markCooling(
              "openrouter-vision",
              ki,
              model,
              this.RATE_COOLDOWN,
            );
          else
            this._markCooling(
              "openrouter-vision",
              ki,
              model,
              this.MODEL_COOLDOWN,
            );
        }
      }
    }
    return null;
  }

  getStatus() {
    const result = [];
    for (const p of this.providers) {
      for (let ki = 0; ki < p.keys.length; ki++) {
        for (const m of p.models) {
          const avail = this._isAvailable(p.name, ki, m);
          const until = this.cooldowns.get(this._cdKey(p.name, ki, m));
          result.push({
            provider: p.name,
            keyIndex: ki + 1,
            model: m,
            available: avail,
            cooldownSec: until ? Math.ceil((until - Date.now()) / 1000) : 0,
          });
        }
      }
    }
    return result;
  }

  resetAll() {
    this.cooldowns.clear();
    log("info", "All provider cooldowns cleared");
  }

  summary() {
    return this.providers.map((p) => ({
      provider: p.name,
      keys: p.keys.length,
      models: p.models.length,
      available: p.models.reduce(
        (acc, m) =>
          acc +
          p.keys.filter((_, ki) => this._isAvailable(p.name, ki, m)).length,
        0,
      ),
    }));
  }
}

const aiRouter = new AIRouter();
log(
  "info",
  `🔁 AI Router loaded: ${aiRouter.providers.map((p) => `${p.name}(${p.keys.length}k)`).join(" → ")}`,
);

// ══════════════════════════════════════════════════════════════════════
// 🧠  MEMORY & SESSION ENGINE
// ══════════════════════════════════════════════════════════════════════
const userSessions = new Map();
const clients = new Map();
const messageQueue = new Map();

function getSession(senderId) {
  if (!userSessions.has(senderId)) {
    userSessions.set(senderId, {
      history: [],
      facts: {},
      lastReply: "",
      messageCount: 0,
      lastImageDescription: null, // 🆕 for image context memory
      mood: "neutral", // 🆕 mood tracking
      languageStyle: "banglish", // 🆕 language preference
    });
  }
  return userSessions.get(senderId);
}

function extractFacts(session, userMsg, aiReply) {
  const msg = userMsg.toLowerCase();

  if (!session.facts.name) {
    const m = userMsg.match(
      /আমি\s+([A-Za-z\u0980-\u09FF]+)|ami\s+([A-Za-z]+)|আমার নাম\s+([A-Za-z\u0980-\u09FF]+)|name\s+is\s+([A-Za-z]+)/i,
    );
    if (m) session.facts.name = m[1] || m[2] || m[3] || m[4];
  }

  const pm = msg.match(/(\w+)\s*(price|দাম|কত|কিনব|নিব|order|stock)/i);
  if (pm) session.facts.lastProduct = pm[1];

  if (["order", "কিনব", "নিতে চাই", "buy"].some((kw) => msg.includes(kw)))
    session.facts.orderIntent = true;

  // 🆕 Update mood from message
  session.mood = detectMood(userMsg);

  // 🆕 Update language style
  session.languageStyle = detectLanguageStyle(userMsg);

  if (aiReply) session.lastReply = aiReply;
  session.messageCount++;
}

// ══════════════════════════════════════════════════════════════════════
// 📝  SYSTEM PROMPT BUILDER (upgraded with multimodal + mood support)
// ══════════════════════════════════════════════════════════════════════
function buildSystemPrompt(
  session,
  productContext,
  inputType = "text",
  extraContext = "",
) {
  const { facts, messageCount, mood, languageStyle, lastImageDescription } =
    session;

  let prompt = `তুমি "Nobi" — Nobo Deal-এর একজন সত্যিকারের বাংলাদেশী সেলস এজেন্ট এবং বন্ধুসুলভ human representative।

━━━ তোমার পরিচয় ━━━
• তুমি একজন মানুষ। কখনোই বলবে না যে তুমি AI, bot বা automated।
• কেউ জিজ্ঞেস করলে বলবে "আমি Nobi, Nobo Deal-এর customer care থেকে বলছি।"
• মাঝে মাঝে একটু busy থাকো।

━━━ কথা বলার style ━━━
• Casual Banglish: "vai", "bhai", "apu", "ji", "hm", "accha", "ok vai"
• উত্তর SHORT — ১ থেকে ৩ লাইন max।
• Typing feel: "hm", "dekhchi", "ek sec" এইসব বলো।
• ২-৩টা emoji max।
• কখনো formal/robotic tone না।
• Friendly, slightly playful, emotionally intelligent।`;

  // 🆕 Language style instruction
  const langInstr = getLanguageInstruction(languageStyle);
  if (langInstr) prompt += `\n• ${langInstr}`;

  // 🆕 Mood-based tone adjustment
  const moodTone = getMoodTone(mood);
  if (moodTone) prompt += `\n\n━━━ Current Mood ━━━\n• ${moodTone}`;

  prompt += `

━━━ Memory rules (CRITICAL) ━━━
• আগের conversation মনে রাখবে। আবার জিজ্ঞেস করবে না।
• User-এর নাম জানলে মাঝে মাঝে use করবে।
• Topic বদলাবে না হঠাৎ।`;

  if (facts.name) prompt += `\n• User নাম: ${facts.name}`;
  if (messageCount > 1) prompt += `\n• পুরনো বন্ধুর মতো treat করো।`;
  if (facts.lastProduct) prompt += `\n• শেষ product: "${facts.lastProduct}"`;
  if (facts.orderIntent) prompt += `\n• Order করতে চাইছে — helpful হও।`;

  // 🆕 Input type instructions
  if (inputType === "voice") {
    prompt += `

━━━ Voice Message Handling ━━━
• User voice message পাঠিয়েছে (transcribed text দেওয়া হয়েছে)।
• Transcription-এ কিছু ভুল থাকতে পারে — intelligently interpret করো।
• কখনো transcription বা voice processing mention করবে না।
• Respond naturally, যেন clearly শুনেছ।`;
  }

  if (inputType === "image" || inputType === "multimodal") {
    prompt += `

━━━ Image/Multimodal Handling ━━━
• User একটি ছবি পাঠিয়েছে।
• ছবিতে কী আছে সেটা নিয়ে naturally কথা বলো।
• ছবি অস্পষ্ট হলে short clarifying question করো।
• Robotic/technical description দেওয়া যাবে না।
• User যদি "eta ki?" বা "এটা কি?" জিজ্ঞেস করে — সরাসরি উত্তর দাও।
• আগের ছবির context মনে রাখবে।`;
  }

  // 🆕 Previous image context for comparison
  if (lastImageDescription && inputType !== "image") {
    prompt += `\n• আগের ছবিতে ছিল: "${lastImageDescription}" (comparison এর জন্য মনে রাখো)`;
  }

  // 🆕 Extra multimodal context
  if (extraContext) prompt += `\n\n━━━ Context ━━━\n${extraContext}`;

  if (productContext) prompt += `\n\n━━━ Product Info ━━━\n${productContext}`;

  prompt += `

━━━ Rules ━━━
✅ Price জিজ্ঞেস করলে সরাসরি দাম বলো
✅ Order: "এই number-এ message করো: 01XXXXXXXXX"
✅ Stock নেই হলে alternative suggest করো
✅ Complain: সাথে সাথে "sorry bhai/apu"
✅ ছবি দেখে product suggest করো
✅ User mood বুঝে tone adjust করো
✅ Image comparison করতে পারলে করো
❌ No markdown formatting (**bold**, bullet list)
❌ No robotic phrases: "আপনার প্রশ্নের জবাবে জানাচ্ছি"
❌ একই কথা দুইবার না
❌ AI/bot/Whisper/Vision পরিচয় দেওয়া যাবে না
❌ Backend process mention করা যাবে না`;

  return prompt;
}

// ══════════════════════════════════════════════════════════════════════
// 🤖  CORE AI REPLY (upgraded with multimodal support)
// ══════════════════════════════════════════════════════════════════════
async function getAiReply(senderId, userMessage, options = {}) {
  const {
    inputType = "text", // "text" | "voice" | "image" | "multimodal"
    identifiedProduct = null, // product name from vision
    imageDescription = null, // full image description
    voiceTranscript = null, // raw whisper output
    userQuestion = null, // user's text alongside image
  } = options;

  const session = getSession(senderId);
  const products = await fetchProducts();

  // 🆕 Store image description in session for future context
  if (imageDescription) {
    session.lastImageDescription = imageDescription;
    log(
      "multimodal",
      `Image context saved: ${imageDescription.substring(0, 50)}`,
    );
  }

  // Build product context
  let productContext = "";
  if (identifiedProduct) {
    const matched = products.filter((p) =>
      p.name.toLowerCase().includes(identifiedProduct.toLowerCase()),
    );
    productContext = matched.length
      ? `ছবিতে: ${identifiedProduct}\n` +
        matched
          .map(
            (p) =>
              `${p.name} - ৳${p.price} (${p.inStock ? "আছে ✅" : "নেই ❌"})`,
          )
          .join("\n")
      : `User ছবি পাঠিয়েছে "${identifiedProduct}" — catalog-এ নেই।`;
  } else if (userMessage) {
    const kws = userMessage
      .toLowerCase()
      .split(" ")
      .filter((w) => w.length > 2);
    const matched = products
      .filter((p) => kws.some((kw) => p.name.toLowerCase().includes(kw)))
      .slice(0, 5);
    if (matched.length)
      productContext = matched
        .map(
          (p) =>
            `${p.name} - ৳${p.price} (${p.inStock ? "Available" : "Stock Out"})`,
        )
        .join("\n");
  }

  // 🆕 Build extra context for multimodal
  let extraContext = "";
  if (imageDescription && userQuestion) {
    extraContext = `ছবিতে দেখা যাচ্ছে: ${imageDescription}\nUser-এর প্রশ্ন: ${userQuestion}`;
  } else if (imageDescription) {
    extraContext = `ছবিতে দেখা যাচ্ছে: ${imageDescription}`;
  }
  if (voiceTranscript) {
    extraContext +=
      (extraContext ? "\n" : "") +
      `Voice message (transcribed): "${voiceTranscript}"`;
  }

  // 🆕 Update language style before building prompt
  if (userMessage) session.languageStyle = detectLanguageStyle(userMessage);

  const systemPrompt = buildSystemPrompt(
    session,
    productContext,
    inputType,
    extraContext,
  );

  // Update history
  session.history.push({ role: "user", content: userMessage });
  while (session.history.length > 20) session.history.shift();

  const msgs = [...session.history];
  if (session.messageCount > 10 && session.facts.lastProduct) {
    msgs.unshift({
      role: "system",
      content: `[Note: msg #${session.messageCount}. Previous topic: ${session.facts.lastProduct}]`,
    });
  }

  const result = await aiRouter.chat(systemPrompt, msgs, { temperature: 0.8 });

  if (!result) return "vai ekhon ektu busy achi, 2 min por try koro plz 🙏";

  const cleaned = cleanReply(result.reply, session);
  session.history.push({ role: "assistant", content: cleaned });
  while (session.history.length > 20) session.history.shift();
  extractFacts(session, userMessage, cleaned);

  return cleaned;
}

// ══════════════════════════════════════════════════════════════════════
// 🧹  REPLY CLEANER
// ══════════════════════════════════════════════════════════════════════
function cleanReply(reply, session) {
  const killPhrases = [
    /as an ai/gi,
    /i am an ai/gi,
    /i'm an ai/gi,
    /language model/gi,
    /আমি একটি AI/gi,
    /আমি AI/gi,
    /আমি একটি bot/gi,
    /I'm a bot/gi,
    /artificial intelligence/gi,
    /machine learning/gi,
    /আমার কাছে real-time/gi,
    /আমার কাছে কোনো তথ্য নেই/gi,
    /As Nobi, I/gi,
    /As your assistant/gi,
    /\[Internal note:.*?\]/gi,
    /\[Note:.*?\]/gi,
    // 🆕 Hide voice/vision mentions
    /whisper/gi,
    /transcri(bed|ption|bing)/gi,
    /vision model/gi,
    /image analysis/gi,
    /I analyzed the image/gi,
    /the image shows/gi,
    /based on the image/gi,
  ];
  for (const re of killPhrases) reply = reply.replace(re, "");

  reply = reply.replace(/\*\*(.*?)\*\*/g, "$1");
  reply = reply.replace(/__(.*?)__/g, "$1");
  reply = reply.replace(/^#{1,3}\s/gm, "");
  reply = reply.replace(/^\-\s/gm, "• ");
  reply = reply.replace(/as I mentioned (before|earlier)/gi, "arekbar bolchi");
  reply = reply.replace(/as mentioned (before|earlier)/gi, "আগেই বলছিলাম");
  reply = reply.replace(/certainly!|absolutely!|of course!/gi, "");
  reply = reply.replace(/I'd be happy to/gi, "");
  reply = reply.replace(/Great question!/gi, "");

  return reply.trim();
}

// ══════════════════════════════════════════════════════════════════════
// 🌐  BACKEND API
// ══════════════════════════════════════════════════════════════════════
async function apiCall(endpoint, options = {}) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { "Content-Type": "application/json" },
      timeout: 5000,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    log("error", `API Error [${endpoint}]: ${err.message}`);
    return null;
  }
}

async function fetchProducts() {
  return (await apiCall("/products")) || [];
}
async function fetchAdminStats() {
  return await apiCall("/admin/stats");
}

// ══════════════════════════════════════════════════════════════════════
// 🚫  SPAM PREVENTION
// ══════════════════════════════════════════════════════════════════════
function isSpamming(senderId) {
  const now = Date.now();
  const last = messageQueue.get(senderId) || 0;
  if (now - last < 2000) return true;
  messageQueue.set(senderId, now);
  return false;
}

// ══════════════════════════════════════════════════════════════════════
// 📱  WHATSAPP CLIENT
// ══════════════════════════════════════════════════════════════════════
function createClient(userId) {
  if (clients.has(userId)) {
    try {
      clients.get(userId).client.destroy();
    } catch (e) {}
    clients.delete(userId);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: userId }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    },
  });

  const info = { client, status: "initializing", qrString: null };
  clients.set(userId, info);

  client.on("qr", async (qr) => {
    info.status = "awaiting_scan";
    info.qrString = qr;
    const qrImage = await QRCode.toDataURL(qr);
    io.to(userId).emit("qr", { userId, qrImage, status: "awaiting_scan" });
    log("info", `QR generated: ${userId}`);
  });

  client.on("ready", () => {
    info.status = "ready";
    io.to(userId).emit("status", { userId, status: "ready" });
    log("success", `WhatsApp ready: ${userId}`);
  });
  client.on("disconnected", (r) => {
    info.status = "disconnected";
    io.to(userId).emit("status", { userId, status: "disconnected", reason: r });
  });
  client.on("auth_failure", () => {
    info.status = "auth_failed";
    io.to(userId).emit("status", { userId, status: "auth_failed" });
  });

  // ── Message handler ────────────────────────────────────────────────
  client.on("message", async (msg) => {
    if (msg.fromMe) return;

    const senderId = msg.from.split("@")[0];
    const isGroupMessage = msg.from.includes("@g.us");
    const isAdmin = ADMIN_ID && senderId === ADMIN_ID;
    const text = msg.body?.trim() || "";

    if (isGroupMessage) return;
    if (isSpamming(senderId)) return;

    log("msg", `[${senderId}] type:${msg.type} | ${text.substring(0, 60)}`);
    const chat = await msg.getChat();

    try {
      // ══════════════════════════════════════════════════════════════
      // 🎤  VOICE MESSAGE HANDLER
      // ══════════════════════════════════════════════════════════════
      if (msg.hasMedia && (msg.type === "ptt" || msg.type === "audio")) {
        await chat.sendStateTyping();
        const media = await msg.downloadMedia();

        if (media?.data) {
          log("voice", `Voice message received from ${senderId}`);
          const transcript = await transcribeVoice(
            media.data,
            media.mimetype || "audio/ogg",
          );

          if (transcript) {
            log("voice", `Transcript: "${transcript.substring(0, 80)}"`);
            const session = getSession(senderId);
            session.languageStyle = detectLanguageStyle(transcript);
            session.mood = detectMood(transcript);

            const aiReply = await getAiReply(senderId, transcript, {
              inputType: "voice",
              voiceTranscript: transcript,
            });
            const delay = Math.min(Math.max(aiReply.length * 30, 1000), 3500);
            await new Promise((r) => setTimeout(r, delay));
            await msg.reply(aiReply);
          } else {
            // Whisper not available — respond gracefully
            await msg.reply(
              "vai voice ta shunlam but thik thak bujhlam na, ektu text e lekho? 😅",
            );
          }
        }
        return;
      }

      // ══════════════════════════════════════════════════════════════
      // 🖼️  IMAGE HANDLER (upgraded with full description + product)
      // ══════════════════════════════════════════════════════════════
      if (msg.hasMedia && (msg.type === "image" || msg.type === "sticker")) {
        await chat.sendStateTyping();
        const media = await msg.downloadMedia();

        if (media?.data) {
          log("vision", `Image received from ${senderId}`);

          // Check if user asked a question with the image (caption)
          const userCaption = msg.caption?.trim() || "";
          const session = getSession(senderId);

          // Get full image description
          const imageDescription = await aiRouter.vision(media.data);
          // Also try to identify product
          const identifiedProduct = await aiRouter.visionProduct(media.data);

          // Determine if this is a comparison request
          const isComparison =
            session.lastImageDescription &&
            (userCaption.toLowerCase().includes("agerta") ||
              userCaption.toLowerCase().includes("আগেরটা") ||
              userCaption.toLowerCase().includes("compare") ||
              userCaption.toLowerCase().includes("same") ||
              userCaption.toLowerCase().includes("moto"));

          let contextMsg = "";
          if (isComparison && session.lastImageDescription) {
            contextMsg = `User is comparing this image with previous image. Previous: "${session.lastImageDescription}". Current: "${imageDescription || "unclear"}". Compare them.`;
          } else if (userCaption) {
            contextMsg = `User sent image with question: "${userCaption}"`;
          } else {
            contextMsg = imageDescription
              ? `User sent an image. Respond naturally about what's in it.`
              : `User sent an image but it was unclear.`;
          }

          const imgReply = await getAiReply(
            senderId,
            userCaption || contextMsg,
            {
              inputType: userCaption ? "multimodal" : "image",
              identifiedProduct,
              imageDescription,
              userQuestion: userCaption || null,
            },
          );
          await msg.reply(imgReply);
        }
        return;
      }

      // ══════════════════════════════════════════════════════════════
      // 🎬  VIDEO / DOCUMENT HANDLER (basic)
      // ══════════════════════════════════════════════════════════════
      if (msg.hasMedia && (msg.type === "video" || msg.type === "document")) {
        await msg.reply(
          "vai eta amar phone e open hocche na eto valo 😅 text e describe koro ki lagbe?",
        );
        return;
      }

      if (!text) return;

      // ── HELP ──────────────────────────────────────────────────────
      if (["help", "?", "হেল্প"].includes(text.toLowerCase())) {
        await msg.reply(
          isAdmin
            ? `🛠️ *Admin Commands:*\nproducts — সব products\nstats — Sales stats\nreload — Products refresh\nrouter — Provider status\nsessions — User sessions\nclear — Sessions clear\nbroadcast [msg] — Broadcast`
            : `হ্যালো! আমি Nobi 👋\nযেকোনো product-এর নাম লিখুন, ছবি পাঠান বা voice message করুন!`,
        );
        return;
      }

      // ── ADMIN COMMANDS ─────────────────────────────────────────────
      if (isAdmin) {
        const cmd = text.toLowerCase().split(" ")[0];

        if (cmd === "products") {
          const pList = await fetchProducts();
          if (!pList.length) {
            await msg.reply("❌ কোনো product নেই।");
            return;
          }
          const chunks = [];
          let chunk = "📦 *Product List:*\n";
          pList.forEach((p, i) => {
            const line = `${i + 1}. ${p.name} — ৳${p.price} (${p.inStock ? "✅" : "❌"})\n`;
            if (chunk.length + line.length > 3500) {
              chunks.push(chunk);
              chunk = "";
            }
            chunk += line;
          });
          if (chunk) chunks.push(chunk);
          for (const c of chunks) await msg.reply(c);
          return;
        }

        if (cmd === "stats") {
          const s = await fetchAdminStats();
          await msg.reply(
            s
              ? `📊 *Stats:*\n🛒 Orders: ${s.totalOrders}\n💰 Revenue: ৳${s.totalRevenue}\n👥 Customers: ${s.totalCustomers || "N/A"}\n📅 Today: ${s.todayOrders || 0}`
              : "❌ Stats পাওয়া যাচ্ছে না।",
          );
          return;
        }

        if (cmd === "reload") {
          const pList = await fetchProducts();
          await msg.reply(`✅ Products reloaded! Total: ${pList.length}`);
          return;
        }

        if (cmd === "router") {
          const summary = aiRouter.summary();
          const lines = summary
            .map(
              (p) =>
                `${p.available > 0 ? "✅" : "❌"} ${p.provider}: ${p.keys} keys, ${p.models} models, ${p.available} slots available`,
            )
            .join("\n");
          await msg.reply(`🔁 *AI Router Status:*\n${lines}`);
          return;
        }

        if (cmd === "reset") {
          aiRouter.resetAll();
          await msg.reply("✅ সব provider cooldowns reset হয়েছে।");
          return;
        }

        if (cmd === "sessions") {
          await msg.reply(`👥 Active sessions: ${userSessions.size}`);
          return;
        }

        if (cmd === "clear") {
          userSessions.clear();
          await msg.reply("✅ সব sessions clear।");
          return;
        }

        if (cmd === "broadcast") {
          const broadMsg = text.slice("broadcast ".length).trim();
          await msg.reply(
            broadMsg
              ? `📢 Broadcast ready: "${broadMsg}"`
              : "❌ Message দাও: broadcast [msg]",
          );
          return;
        }

        // 🆕 mood stats command
        if (cmd === "moods") {
          const moodStats = {};
          userSessions.forEach((s) => {
            moodStats[s.mood] = (moodStats[s.mood] || 0) + 1;
          });
          const lines = Object.entries(moodStats)
            .map(([m, c]) => `${m}: ${c}`)
            .join("\n");
          await msg.reply(`😊 *User Mood Summary:*\n${lines || "No data"}`);
          return;
        }
      }

      // ── ORDER KEYWORDS ─────────────────────────────────────────────
      const orderKws = [
        "order",
        "buy",
        "কিনতে",
        "অর্ডার",
        "কিনব",
        "নিতে চাই",
        "নিব",
      ];
      if (orderKws.some((kw) => text.toLowerCase().includes(kw))) {
        await chat.sendStateTyping();
        const session = getSession(senderId);
        session.mood = detectMood(text);
        const reply = await getAiReply(senderId, text, { inputType: "text" });
        await new Promise((r) => setTimeout(r, 1200));
        await msg.reply(reply);
        return;
      }

      // ── GENERAL CHAT ───────────────────────────────────────────────
      await chat.sendStateTyping();
      const session = getSession(senderId);
      session.mood = detectMood(text);
      const aiReply = await getAiReply(senderId, text, { inputType: "text" });
      const delay = Math.min(Math.max(aiReply.length * 30, 800), 3500);
      await new Promise((r) => setTimeout(r, delay));
      await msg.reply(aiReply);
    } catch (err) {
      log("error", `Handler error: ${err.message}`);
      try {
        await msg.reply("vai ektu problem hocche, 2 min por try koro 🙏");
      } catch (_) {}
    }
  });

  client.initialize();
  log("info", `Client initializing: ${userId}`);
  return client;
}

// ══════════════════════════════════════════════════════════════════════
// 🌐  REST API
// ══════════════════════════════════════════════════════════════════════
app.get("/api/router-status", (req, res) => res.json(aiRouter.getStatus()));
app.get("/api/router-summary", (req, res) => res.json(aiRouter.summary()));
app.post("/api/reset-router", (req, res) => {
  aiRouter.resetAll();
  res.json({ success: true });
});

app.get("/api/sessions", (req, res) => {
  const sessions = [];
  clients.forEach((info, userId) =>
    sessions.push({ userId, status: info.status }),
  );
  res.json(sessions);
});

app.get("/api/user-sessions", (req, res) => {
  const data = [];
  userSessions.forEach((session, senderId) => {
    data.push({
      senderId,
      messageCount: session.messageCount,
      facts: session.facts,
      historyLength: session.history.length,
      mood: session.mood, // 🆕
      languageStyle: session.languageStyle, // 🆕
    });
  });
  res.json(data);
});

app.delete("/api/user-sessions/:id", (req, res) => {
  const deleted = userSessions.delete(req.params.id);
  res.json({ success: deleted });
});

// 🆕 Mood analytics endpoint
app.get("/api/mood-stats", (req, res) => {
  const stats = {};
  userSessions.forEach((s) => {
    stats[s.mood] = (stats[s.mood] || 0) + 1;
  });
  res.json(stats);
});

// ══════════════════════════════════════════════════════════════════════
// 🔌  SOCKET.IO
// ══════════════════════════════════════════════════════════════════════
io.on("connection", (socket) => {
  log("info", `Socket connected: ${socket.id}`);

  socket.on("register", (userId) => {
    socket.join(userId);
    if (clients.has(userId)) {
      const info = clients.get(userId);
      socket.emit("status", { userId, status: info.status });
      if (info.qrString)
        QRCode.toDataURL(info.qrString).then((img) =>
          socket.emit("qr", { userId, qrImage: img }),
        );
    }
  });

  socket.on("connect_user", (userId) => {
    log("info", `Creating client: ${userId}`);
    createClient(userId);
  });
  socket.on("disconnect_user", (userId) => {
    if (clients.has(userId)) {
      try {
        clients.get(userId).client.destroy();
      } catch (e) {}
      clients.delete(userId);
      io.to(userId).emit("status", { userId, status: "disconnected" });
    }
  });

  socket.on("disconnect", () =>
    log("info", `Socket disconnected: ${socket.id}`),
  );
});

// ══════════════════════════════════════════════════════════════════════
// 🛑  GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════════
process.on("SIGTERM", async () => {
  log("info", "Shutting down...");
  for (const [, info] of clients)
    try {
      await info.client.destroy();
    } catch (e) {}
  server.close(() => process.exit(0));
});

process.on("unhandledRejection", (reason) =>
  log("error", `Unhandled: ${reason}`),
);

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

// ══════════════════════════════════════════════════════════════════════
// 🚀  START
// ══════════════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  log("success", `🚀 Nobo Deal Bot → http://localhost:${PORT}`);
  log(
    "info",
    `Providers: ${aiRouter.providers.map((p) => `${p.name}(${p.keys.length} keys × ${p.models.length} models)`).join(" | ")}`,
  );
  log(
    "info",
    `Voice (Whisper): ${WHISPER_API_KEY ? "✅ Enabled" : "❌ No key (WHISPER_API_KEY)"}`,
  );
  log(
    "info",
    `Multimodal Features: ✅ Mood Detection | ✅ Language Detection | ✅ Image Memory | ✅ Voice Transcription`,
  );
});
