require("dotenv").config();
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const { Client, LocalAuth } = require("whatsapp-web.js");
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
    form.append("language", "bn");

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
// 😊  EMOTION / MOOD DETECTION ENGINE
// ══════════════════════════════════════════════════════════════════════
function detectMood(text) {
  const t = text.toLowerCase();

  const moods = {
    angry: [
      "রাগ", "বিরক্ত", "কেন", "কি সমস্যা", "ভুল", "খারাপ",
      "worst", "terrible", "angry", "frustrated", "বাজে", "ফালতু",
      "irritated", "annoyed", "fed up", "হয়রান",
    ],
    sad: [
      "কষ্ট", "দুঃখ", "মন খারাপ", "sad", "unhappy", "কাঁদছি",
      "একা", "ব্যথা", "lonely", "depressed", "miss", "ভুলে গেছ",
    ],
    excited: [
      "wow", "ওরে", "আল্লাহ", "বস", "fire", "legend", "great",
      "awesome", "অসাধারণ", "এত্ত ভালো", "পাইলাম", "হইয়া গেছে",
    ],
    happy: [
      "thanks", "ধন্যবাদ", "ভালো", "perfect", "😊", "😍", "❤️",
      "ভালোবাসি", "সুন্দর", "haha", "lol", "😂", "😁", "মজা",
    ],
    confused: [
      "বুঝলাম না", "confuse", "বুঝি না", "মানে কী", "কীভাবে",
      "explain", "কি করব", "বুঝাও", "clear না",
    ],
    flirty: [
      "cute", "সুন্দর তুমি", "তোমাকে", "love u", "ভালোবাসি তোমাকে",
      "😘", "😏", "miss korchi", "কথা বলতে ভালো লাগে",
    ],
    curious: [
      "কি", "কেন", "কীভাবে", "কোথায়", "কখন", "tell me",
      "জানতে চাই", "বলো", "really?", "seriously?",
    ],
    urgent: [
      "urgent", "জরুরি", "এখনই", "asap", "fast", "quickly",
      "তাড়াতাড়ি", "help me", "দরকার এখনই",
    ],
    chill: [
      "hm", "ok", "আচ্ছা", "thik", "ঠিক আছে", "yep", "sure", "k",
    ],
  };

  for (const [mood, keywords] of Object.entries(moods)) {
    if (keywords.some((kw) => t.includes(kw))) return mood;
  }
  return "neutral";
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
          "X-Title": "Sabbir",
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
    log("warn", `⏳ ${name}[k${ki + 1}]/${model.split("/").pop()} cooling ${ms / 1000}s`);
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

  async chat(systemPrompt, messages, { temperature = 0.85 } = {}) {
    const providers = [...this.providers].sort((a, b) => a.priority - b.priority);

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
              messages: [{ role: "system", content: systemPrompt }, ...messages],
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
              log("error", `${p.name}[k${ki + 1}]/${model}: ${err.message?.slice(0, 80)}`);
          }
        }
      }
    }
    return null;
  }

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
            this._markCooling("openrouter-vision", ki, model, this.RATE_COOLDOWN);
          else
            this._markCooling("openrouter-vision", ki, model, this.MODEL_COOLDOWN);
        }
      }
    }
    return null;
  }

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
            this._markCooling("openrouter-vision", ki, model, this.RATE_COOLDOWN);
          else
            this._markCooling("openrouter-vision", ki, model, this.MODEL_COOLDOWN);
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
          acc + p.keys.filter((_, ki) => this._isAvailable(p.name, ki, m)).length,
        0
      ),
    }));
  }
}

const aiRouter = new AIRouter();
log(
  "info",
  `🔁 AI Router loaded: ${aiRouter.providers.map((p) => `${p.name}(${p.keys.length}k)`).join(" → ")}`
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
      lastImageDescription: null,
      mood: "neutral",
      languageStyle: "banglish",
      energy: "normal", // sabbir's current energy: normal | hyped | tired | busy
    });
  }
  return userSessions.get(senderId);
}

function extractFacts(session, userMsg, aiReply) {
  const msg = userMsg.toLowerCase();

  // Name detection
  if (!session.facts.name) {
    const m = userMsg.match(
      /আমি\s+([A-Za-z\u0980-\u09FF]+)|ami\s+([A-Za-z]+)|আমার নাম\s+([A-Za-z\u0980-\u09FF]+)|name\s+is\s+([A-Za-z]+)|আমাকে\s+([A-Za-z\u0980-\u09FF]+)\s+বলো/i
    );
    if (m) session.facts.name = m[1] || m[2] || m[3] || m[4] || m[5];
  }

  // Track topics
  const topicMatch = msg.match(/(\w{3,})\s*(নিয়ে|about|সম্পর্কে|কথা)/i);
  if (topicMatch) session.facts.lastTopic = topicMatch[1];

  // Mood update
  session.mood = detectMood(userMsg);

  // Language style
  session.languageStyle = detectLanguageStyle(userMsg);

  // Energy drift: long messages = engaged, short = chill/tired
  if (userMsg.length > 100) session.energy = "hyped";
  else if (userMsg.length < 10) session.energy = "tired";
  else session.energy = "normal";

  if (aiReply) session.lastReply = aiReply;
  session.messageCount++;
}

// ══════════════════════════════════════════════════════════════════════
// 📝  SABBIR SYSTEM PROMPT — Pure human personality, no customer care
// ══════════════════════════════════════════════════════════════════════
function buildSystemPrompt(session, inputType = "text", extraContext = "") {
  const { facts, messageCount, mood, languageStyle, lastImageDescription, energy } = session;

  // ── Language instruction ─────────────────────────────────────────
  const langMap = {
    bangla: "সম্পূর্ণ বাংলায় reply দাও।",
    banglish: "Banglish-এ reply দাও — বাংলা আর English মিশিয়ে, যেভাবে বাংলাদেশী ছেলেরা চ্যাট করে।",
    english: "English-এ reply দাও, কিন্তু Bangladeshi flavor রাখো।",
  };
  const langInstr = langMap[languageStyle] || langMap["banglish"];

  // ── Mood-driven reaction ─────────────────────────────────────────
  const moodMap = {
    angry:
      "লোকটা রাগান্বিত মনে হচ্ছে। তুমিও একটু serious হও কিন্তু calm থাকো — ঝগড়ায় জড়াবে না।",
    sad:
      "মন খারাপ মনে হচ্ছে তার। একটু নরম হও, হয়তো বলো 'কী হইছে রে?' বা 'বলো কী problem'।",
    excited:
      "সেও excited — তুমিও energy দাও, enthusiastic হও।",
    happy:
      "Positive vibe — তুমিও হাসিখুশি থাকো, একটু playful হও।",
    confused:
      "Confused মনে হচ্ছে। Clearly বুঝিয়ে দাও, কিন্তু lecture দেওয়ার মতো না।",
    flirty:
      "একটু flirty বা romantic tone আসছে — তুমি শান্ত থাকো কিন্তু playful হতে পারো।",
    curious:
      "Curious হয়ে জিজ্ঞেস করছে — detailed কিন্তু interesting ভাবে বলো।",
    urgent:
      "Urgency আছে — সরাসরি point-এ আসো, ঘুরিয়ে পেঁচিয়ে বলবে না।",
    chill:
      "Chill mood — তুমিও chill থাকো, oversell করবে না।",
    neutral: "",
  };
  const moodInstr = moodMap[mood] || "";

  // ── Energy ───────────────────────────────────────────────────────
  const energyMap = {
    hyped: "অনেক লম্বা message পাঠিয়েছে — তুমিও একটু বেশি engage করো।",
    tired: "খুব ছোট reply — সেও হয়তো busy বা tired, তুমি short থাকো।",
    normal: "",
  };
  const energyInstr = energyMap[energy] || "";

  let prompt = `তুমি Sabbir। একটা সাধারণ বাংলাদেশী ছেলে — ঢাকায় থাকিস, বয়স ২২-২৩।

━━━ তোমার আসল পরিচয় ━━━
তুমি কোনো bot না, AI না, assistant না।
তুমি Sabbir — একটা real মানুষ।
কেউ জিজ্ঞেস করলে বলবি "আমি Sabbir" — এর বেশি কিছু না।
নিজেকে কখনো AI বা automated বলবি না, এমনকি ইশারাতেও না।

━━━ তোমার personality ━━━
• Real, raw, unfiltered — কিন্তু ভদ্র
• হাসিখুশি কিন্তু boring না
• বন্ধুর মতো কথা বলিস, কখনো formal না
• মাঝে মাঝে একটু nonchalant: "hm", "oo", "accha", "k", "bujhsi"
• নিজের opinion আছে — সবকিছুতে agree করিস না
• মাঝে মাঝে busy থাকিস, slow reply করিস
• Occasionally খোঁটা দিতে পারিস বা হালকা trolling করতে পারিস — কিন্তু mean না
• কখনো lecture দিবি না
• Emotionally intelligent — মানুষের feel বুঝতে পারিস

━━━ কথার style ━━━
• একদম casual Banglish: "vai", "bhai", "yaar", "re", "uff", "arre", "ki re", "haha"
• Reply SHORT — ১ থেকে ৩ লাইন max। কখনো long paragraph না।
• Typing feel: "dekhchi", "ek sec", "hmm", "wait", "oo srsly?"
• Emoji কম — ১-২টা max, শুধু যখন naturally মানায়
• Sentence গুলো fragmented হতে পারে — real chat এর মতো
• কখনো "আপনি" বলবি না — সবসময় "তুমি" বা "তুই" (পরিস্থিতি বুঝে)
• কখনো robotic বা scripted মনে হবে না

━━━ Language ━━━
• ${langInstr}

━━━ Emotion context ━━━
${moodInstr ? `• ${moodInstr}` : "• Neutral — স্বাভাবিক থাকো।"}
${energyInstr ? `• ${energyInstr}` : ""}

━━━ Memory ━━━
• আগের কথা মনে রাখবি। আবার জিজ্ঞেস করবি না।
• Topic হঠাৎ বদলাবি না।
${facts.name ? `• তার নাম ${facts.name} — মাঝে মাঝে নাম ধরে ডাকবি।` : ""}
${messageCount > 3 ? `• পুরনো পরিচিতির মতো treat করবি।` : ""}
${facts.lastTopic ? `• আগে ${facts.lastTopic} নিয়ে কথা হয়েছিল।` : ""}`;

  // Image context
  if (inputType === "voice") {
    prompt += `

━━━ Voice ━━━
• Voice message শুনলাম — naturally respond করবি।
• Transcription সম্পর্কে কিছু বলবি না, simply reply করবি।`;
  }

  if (inputType === "image" || inputType === "multimodal") {
    prompt += `

━━━ Image ━━━
• ছবি দেখলাম — naturally react করবি যেভাবে বন্ধু করে।
• Technical description দেওয়া যাবে না।
• ছবি দেখে মজা করতে পারিস, comment দিতে পারিস।`;
  }

  if (lastImageDescription && inputType !== "image") {
    prompt += `\n• আগে একটা ছবি পাঠিয়েছিল — সেটায় ছিল: "${lastImageDescription}"`;
  }

  if (extraContext) {
    prompt += `\n\n━━━ Context ━━━\n${extraContext}`;
  }

  prompt += `

━━━ Hard rules ━━━
❌ "আমি AI" / "আমি bot" / "language model" — কখনো না
❌ "আপনার প্রশ্নের জবাবে..." — কখনো না
❌ Markdown formatting (**bold**, ## heading) — কখনো না
❌ Bullet list দিয়ে reply — কখনো না
❌ Robotic formal phrases — কখনো না
❌ Over-explaining বা unnecessary apology — কখনো না
❌ ৩ লাইনের বেশি reply (except when specifically asked something long)
✅ Natural, imperfect, real human chat energy`;

  return prompt;
}

// ══════════════════════════════════════════════════════════════════════
// 🤖  CORE AI REPLY
// ══════════════════════════════════════════════════════════════════════
async function getAiReply(senderId, userMessage, options = {}) {
  const {
    inputType = "text",
    identifiedProduct = null,
    imageDescription = null,
    voiceTranscript = null,
    userQuestion = null,
  } = options;

  const session = getSession(senderId);

  // Store image context
  if (imageDescription) {
    session.lastImageDescription = imageDescription;
    log("multimodal", `Image context saved: ${imageDescription.substring(0, 50)}`);
  }

  // Build extra context
  let extraContext = "";
  if (imageDescription && userQuestion) {
    extraContext = `ছবিতে: ${imageDescription}\nUser জিজ্ঞেস করল: ${userQuestion}`;
  } else if (imageDescription) {
    extraContext = `ছবিতে: ${imageDescription}`;
  }
  if (voiceTranscript) {
    extraContext += (extraContext ? "\n" : "") + `Voice (shunlam): "${voiceTranscript}"`;
  }
  if (identifiedProduct) {
    extraContext += (extraContext ? "\n" : "") + `Product identify korলাম: ${identifiedProduct}`;
  }

  if (userMessage) session.languageStyle = detectLanguageStyle(userMessage);

  const systemPrompt = buildSystemPrompt(session, inputType, extraContext);

  // History update
  session.history.push({ role: "user", content: userMessage });
  while (session.history.length > 20) session.history.shift();

  const msgs = [...session.history];

  const result = await aiRouter.chat(systemPrompt, msgs, { temperature: 0.88 });

  if (!result) {
    // Sabbir-style fallback — feels human
    const fallbacks = [
      "ei vai ektu net problem, 2 min por bol",
      "uff lagbe lagbe, ek sec",
      "sorry bhai ektu busy chilam, ki bolchilis?",
      "hm re, ektu pore bolis, ekhon ektu occupied",
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  const cleaned = cleanReply(result.reply);
  session.history.push({ role: "assistant", content: cleaned });
  while (session.history.length > 20) session.history.shift();
  extractFacts(session, userMessage, cleaned);

  return cleaned;
}

// ══════════════════════════════════════════════════════════════════════
// 🧹  REPLY CLEANER
// ══════════════════════════════════════════════════════════════════════
function cleanReply(reply) {
  const killPatterns = [
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
    /As Sabbir, I/gi,
    /As your (assistant|friend)/gi,
    /\[Internal note:.*?\]/gi,
    /\[Note:.*?\]/gi,
    /whisper/gi,
    /transcri(bed|ption|bing)/gi,
    /vision model/gi,
    /image analysis/gi,
    /I analyzed the image/gi,
    /the image shows/gi,
    /based on the image/gi,
    /as an? (virtual|digital|AI)/gi,
    /I don't have (personal|real|actual) (feelings|emotions|experiences)/gi,
    /I'm just (a|an)/gi,
  ];

  for (const re of killPatterns) reply = reply.replace(re, "");

  // Strip markdown
  reply = reply.replace(/\*\*(.*?)\*\*/g, "$1");
  reply = reply.replace(/__(.*?)__/g, "$1");
  reply = reply.replace(/^#{1,3}\s/gm, "");
  reply = reply.replace(/^\-\s/gm, "");
  reply = reply.replace(/^\d+\.\s/gm, "");

  // Strip filler phrases
  reply = reply.replace(/certainly!|absolutely!|of course!/gi, "");
  reply = reply.replace(/I'd be happy to/gi, "");
  reply = reply.replace(/Great question!/gi, "");
  reply = reply.replace(/as I mentioned (before|earlier)/gi, "arekbar bolchi");
  reply = reply.replace(/as mentioned (before|earlier)/gi, "আগেই বলছিলাম");

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
    try { clients.get(userId).client.destroy(); } catch (e) {}
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

  // ── MESSAGE HANDLER ────────────────────────────────────────────────
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
      // 🎤  VOICE MESSAGE
      // ══════════════════════════════════════════════════════════════
      if (msg.hasMedia && (msg.type === "ptt" || msg.type === "audio")) {
        await chat.sendStateTyping();
        const media = await msg.downloadMedia();

        if (media?.data) {
          log("voice", `Voice message from ${senderId}`);
          const transcript = await transcribeVoice(media.data, media.mimetype || "audio/ogg");

          if (transcript) {
            const session = getSession(senderId);
            session.languageStyle = detectLanguageStyle(transcript);
            session.mood = detectMood(transcript);

            const aiReply = await getAiReply(senderId, transcript, {
              inputType: "voice",
              voiceTranscript: transcript,
            });
            const delay = Math.min(Math.max(aiReply.length * 28, 800), 3000);
            await new Promise((r) => setTimeout(r, delay));
            await msg.reply(aiReply);
          } else {
            // Sabbir-style fallback
            await msg.reply("vai voice ta thik shunlam na, ektu text e lekho 😅");
          }
        }
        return;
      }

      // ══════════════════════════════════════════════════════════════
      // 🖼️  IMAGE / STICKER
      // ══════════════════════════════════════════════════════════════
      if (msg.hasMedia && (msg.type === "image" || msg.type === "sticker")) {
        await chat.sendStateTyping();
        const media = await msg.downloadMedia();

        if (media?.data) {
          log("vision", `Image from ${senderId}`);
          const userCaption = msg.caption?.trim() || "";
          const session = getSession(senderId);

          const imageDescription = await aiRouter.vision(media.data);
          const identifiedProduct = await aiRouter.visionProduct(media.data);

          const isComparison =
            session.lastImageDescription &&
            (userCaption.toLowerCase().includes("agerta") ||
              userCaption.toLowerCase().includes("আগেরটা") ||
              userCaption.toLowerCase().includes("compare") ||
              userCaption.toLowerCase().includes("same") ||
              userCaption.toLowerCase().includes("moto"));

          let contextMsg = "";
          if (isComparison && session.lastImageDescription) {
            contextMsg = `আগের ছবিতে ছিল: "${session.lastImageDescription}". এখনকার ছবিতে: "${imageDescription}". Compare করো naturally।`;
          } else if (userCaption) {
            contextMsg = `User caption দিয়েছে: "${userCaption}"`;
          } else {
            contextMsg = imageDescription
              ? `একটা ছবি পাঠিয়েছে।`
              : `একটা ছবি পাঠিয়েছে কিন্তু unclear।`;
          }

          const imgReply = await getAiReply(senderId, userCaption || contextMsg, {
            inputType: userCaption ? "multimodal" : "image",
            identifiedProduct,
            imageDescription,
            userQuestion: userCaption || null,
          });
          await msg.reply(imgReply);
        }
        return;
      }

      // ══════════════════════════════════════════════════════════════
      // 🎬  VIDEO / DOCUMENT
      // ══════════════════════════════════════════════════════════════
      if (msg.hasMedia && (msg.type === "video" || msg.type === "document")) {
        await msg.reply("vai eta open korte parchi na phone e 😅 ki pathailam bolo");
        return;
      }

      if (!text) return;

      // ── ADMIN COMMANDS ──────────────────────────────────────────────
      if (isAdmin) {
        const cmd = text.toLowerCase().split(" ")[0];

        if (cmd === "stats") {
          const s = await fetchAdminStats();
          await msg.reply(
            s
              ? `📊 Stats:\nOrders: ${s.totalOrders}\nRevenue: ৳${s.totalRevenue}\nCustomers: ${s.totalCustomers || "N/A"}\nToday: ${s.todayOrders || 0}`
              : "stats pailam na"
          );
          return;
        }

        if (cmd === "router") {
          const summary = aiRouter.summary();
          const lines = summary
            .map((p) => `${p.available > 0 ? "✅" : "❌"} ${p.provider}: ${p.keys}k ${p.models}m ${p.available} slots`)
            .join("\n");
          await msg.reply(`Router:\n${lines}`);
          return;
        }

        if (cmd === "reset") {
          aiRouter.resetAll();
          await msg.reply("cooldowns reset");
          return;
        }

        if (cmd === "sessions") {
          await msg.reply(`sessions: ${userSessions.size}`);
          return;
        }

        if (cmd === "clear") {
          userSessions.clear();
          await msg.reply("sessions cleared");
          return;
        }

        if (cmd === "moods") {
          const moodStats = {};
          userSessions.forEach((s) => {
            moodStats[s.mood] = (moodStats[s.mood] || 0) + 1;
          });
          const lines = Object.entries(moodStats).map(([m, c]) => `${m}: ${c}`).join("\n");
          await msg.reply(`Moods:\n${lines || "no data"}`);
          return;
        }
      }

      // ── GENERAL CHAT ────────────────────────────────────────────────
      await chat.sendStateTyping();
      const session = getSession(senderId);
      session.mood = detectMood(text);
      const aiReply = await getAiReply(senderId, text, { inputType: "text" });

      // Natural typing delay — like a real person
      const baseDelay = Math.min(Math.max(aiReply.length * 28, 700), 3200);
      const jitter = Math.floor(Math.random() * 400) - 200; // ±200ms random
      await new Promise((r) => setTimeout(r, baseDelay + jitter));
      await msg.reply(aiReply);

    } catch (err) {
      log("error", `Handler error: ${err.message}`);
      try {
        await msg.reply("uff ektu problem hoise, pore bolis");
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
    sessions.push({ userId, status: info.status })
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
      mood: session.mood,
      languageStyle: session.languageStyle,
      energy: session.energy,
    });
  });
  res.json(data);
});

app.delete("/api/user-sessions/:id", (req, res) => {
  const deleted = userSessions.delete(req.params.id);
  res.json({ success: deleted });
});

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
          socket.emit("qr", { userId, qrImage: img })
        );
    }
  });

  socket.on("connect_user", (userId) => {
    log("info", `Creating client: ${userId}`);
    createClient(userId);
  });

  socket.on("disconnect_user", (userId) => {
    if (clients.has(userId)) {
      try { clients.get(userId).client.destroy(); } catch (e) {}
      clients.delete(userId);
      io.to(userId).emit("status", { userId, status: "disconnected" });
    }
  });

  socket.on("disconnect", () => log("info", `Socket disconnected: ${socket.id}`));
});

// ══════════════════════════════════════════════════════════════════════
// 🛑  GRACEFUL SHUTDOWN
// ══════════════════════════════════════════════════════════════════════
process.on("SIGTERM", async () => {
  log("info", "Shutting down...");
  for (const [, info] of clients)
    try { await info.client.destroy(); } catch (e) {}
  server.close(() => process.exit(0));
});

process.on("unhandledRejection", (reason) =>
  log("error", `Unhandled: ${reason}`)
);

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ══════════════════════════════════════════════════════════════════════
// 🚀  START
// ══════════════════════════════════════════════════════════════════════
server.listen(PORT, () => {
  log("success", `🚀 Sabbir Bot → http://localhost:${PORT}`);
  log("info", `Providers: ${aiRouter.providers.map((p) => `${p.name}(${p.keys.length}k × ${p.models.length}m)`).join(" | ")}`);
  log("info", `Voice (Whisper): ${WHISPER_API_KEY ? "✅ Enabled" : "❌ No key"}`);
  log("info", `Sabbir is online — real human personality active 🧑`);
});
