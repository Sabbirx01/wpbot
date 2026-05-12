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
const os = require("os");
const FormData = require("form-data");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST", "DELETE"] },
});

app.use(express.static("public"));
app.use(express.json({ limit: "2mb" }));

// ========== CONFIG ==========
const API_BASE = process.env.API_BASE || "http://localhost:5000";
const ADMIN_ID = process.env.ADMIN_ID || "";
const PORT = Number(process.env.PORT || 3001);
const WHISPER_API_KEY =
  process.env.WHISPER_API_KEY || process.env.OPENAI_API_KEY || "";

const SABBIR_PROFILE = {
  name: process.env.SABBIR_NAME || "Sabbir",
  age: process.env.SABBIR_AGE || "22-23",
  location: process.env.SABBIR_LOCATION || "Azimpur, Dhaka",
  study: process.env.SABBIR_STUDY || "Dhaka College",
  replyLanguage: "bangla-first",
};

const AUTH_DIR = path.join(__dirname, ".wwebjs_auth");
const CACHE_DIR = path.join(__dirname, ".wwebjs_cache");
const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");
const MEMORY_FILE = path.join(DATA_DIR, "user-memory.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  const tmpPath = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

const DEFAULT_SYSTEM_SETTINGS = {
  transparencyDisclosure: true,
  banglaFirst: true,
  typingSimulation: true,
  naturalImperfections: true,
  smartExcuses: true,
  voiceNoteText: true,
  autoReconnect: true,
  maxHistory: 28,
  responseTemperature: 0.76,
  minDelayMs: 900,
  maxDelayMs: 6500,
  operatorStatus: "busy",
  safetyMode: "transparent_auto_reply",
};

let systemSettings = {
  ...DEFAULT_SYSTEM_SETTINGS,
  ...readJsonFile(SETTINGS_FILE, {}),
};
systemSettings.transparencyDisclosure = false;
systemSettings.safetyMode = "hidden_secret_bot";

let contactStore = readJsonFile(CONTACTS_FILE, {});
const activityEvents = [];
const MAX_ACTIVITY_EVENTS = 220;
const metrics = {
  startedAt: Date.now(),
  inboundMessages: 0,
  outboundMessages: 0,
  voiceMessages: 0,
  imageMessages: 0,
  generatedReplies: 0,
  fallbackReplies: 0,
  errors: 0,
  reconnects: 0,
  avgReplyDelayMs: 0,
  currentActivity: "idle",
};

function pushActivity(type, message, data = {}) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: Date.now(),
    type,
    message,
    data,
  };
  activityEvents.unshift(event);
  while (activityEvents.length > MAX_ACTIVITY_EVENTS) activityEvents.pop();
  try {
    io.emit("activity", event);
    io.emit("metrics", getMetrics());
  } catch (_) {}
  return event;
}

// ========== LOGGER ==========
function log(level, msg, data = "") {
  const icons = {
    info: "[i]",
    success: "[ok]",
    warn: "[!]",
    error: "[x]",
    msg: "[msg]",
    ai: "[ai]",
    vision: "[vision]",
    router: "[router]",
    voice: "[voice]",
    mood: "[mood]",
    multimodal: "[multi]",
  };
  const ts = new Date().toLocaleTimeString("en-BD", { timeZone: "Asia/Dhaka" });
  console.log(`[${ts}] ${icons[level] || "[.]"} ${msg}`, data);
  if (level === "error") metrics.errors++;
  pushActivity(level, msg, typeof data === "string" ? { detail: data } : data);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeId(userId) {
  return String(userId || "")
    .trim()
    .replace(/[^\w-]/g, "_")
    .slice(0, 80);
}

function safeResolveInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Refusing to delete outside ${base}`);
  }
  return target;
}

function removeDirSafe(baseDir, targetPath) {
  const target = safeResolveInside(baseDir, targetPath);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  }
  return false;
}

// ============================================================================
// VOICE TRANSCRIPTION
// ============================================================================
async function transcribeVoice(audioBase64, mimeType = "audio/ogg") {
  if (!WHISPER_API_KEY) {
    log("warn", "No Whisper API key, skipping transcription");
    return null;
  }

  let tmpPath = null;
  try {
    log("voice", "Transcribing voice message via Whisper...");
    const ext = mimeType.includes("ogg")
      ? "ogg"
      : mimeType.includes("mp4")
        ? "mp4"
        : "oga";

    tmpPath = path.join(os.tmpdir(), `voice_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(audioBase64, "base64"));

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
      timeout: 30000,
    });

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
  } finally {
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {}
    }
  }
}

// ============================================================================
// MOOD + LANGUAGE DETECTION
// ============================================================================
function detectMood(text = "") {
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
      "awesome", "অসাধারণ", "পাইলাম", "হইয়া গেছে", "হয়ে গেছে",
    ],
    happy: [
      "thanks", "ধন্যবাদ", "ভালো", "perfect", "😊", "😍", "❤️",
      "ভালোবাসি", "সুন্দর", "haha", "lol", "😂", "😁", "মজা",
    ],
    confused: [
      "বুঝলাম না", "confuse", "বুঝি না", "মানে কী", "মানে কি", "কীভাবে",
      "কিভাবে", "explain", "কি করব", "বুঝাও", "clear না",
    ],
    flirty: [
      "cute", "সুন্দর তুমি", "তোমাকে", "love u", "ভালোবাসি তোমাকে",
      "😘", "😏", "miss korchi", "কথা বলতে ভালো লাগে",
    ],
    curious: [
      "কি", "কী", "কেন", "কীভাবে", "কিভাবে", "কোথায়", "কখন",
      "tell me", "জানতে চাই", "বলো", "really?", "seriously?",
    ],
    urgent: [
      "urgent", "জরুরি", "এখনই", "asap", "fast", "quickly",
      "তাড়াতাড়ি", "help me", "দরকার এখনই",
    ],
    chill: ["hm", "hmm", "ok", "আচ্ছা", "ঠিক আছে", "yep", "sure", "k"],
  };

  for (const [mood, keywords] of Object.entries(moods)) {
    if (keywords.some((kw) => t.includes(kw))) return mood;
  }
  return "neutral";
}

function detectLanguageStyle(text = "") {
  const hasBangla = /[\u0980-\u09FF]/.test(text);
  const englishLetters = (text.match(/[a-zA-Z]/g) || []).length;
  const banglaLetters = (text.match(/[\u0980-\u09FF]/g) || []).length;

  if (hasBangla && englishLetters > banglaLetters * 0.45) return "mixed";
  if (hasBangla) return "bangla";
  if (englishLetters > 0) return "english";
  return "bangla";
}

function asksAboutIdentity(text = "") {
  return /(\bai\b|\bbot\b|automated|auto reply|autoreply|তুমি কে|কে তুমি|মানুষ|রিয়েল|রিয়েল|সাব্বির\??|sabbir\??|এটা কে|এইটা কে)/i.test(text);
}

function asksForLongAnswer(text = "") {
  return /(বিস্তারিত|details|detail|explain|বোঝাও|বুঝাও|লিস্ট|list|step|ধাপে|কীভাবে|কিভাবে)/i.test(text);
}

function detectEmotionProfile(text = "") {
  const t = text.toLowerCase();
  const tests = {
    romantic: /(ভালোবাসি|miss you|miss kori|miss কর|love u|love you|jan|jaan|baby|😘|❤️|💔)/i,
    funny: /(haha|hehe|lol|lmao|😂|🤣|মজা|হাসি|funny|joss|জোস)/i,
    serious: /(serious|সিরিয়াস|সিরিয়াস|important|জরুরি|urgent|problem|সমস্যা|দরকার)/i,
    caring: /(খেয়েছ|খেয়েছ|take care|careful|সাবধানে|ঘুমাইছ|ঘুমিয়েছ|ভালো আছ)/i,
    savage: /(roast|savage|ধুয়ে|বাঁশ|troll|ট্রল|পচা|খোঁচা)/i,
    angry: /(রাগ|বিরক্ত|ফালতু|বাজে|চুপ|annoyed|angry|wtf|shit)/i,
    sad: /(মন খারাপ|কষ্ট|দুঃখ|sad|depressed|lonely|একা|কাঁদ)/i,
    excited: /(wow|জোস|অসাধারণ|great|awesome|fire|🔥|হয়ে গেছে|পাইলাম)/i,
    casual: /(কি কর|কী কর|ki kor|আচ্ছা|hmm|hm|ok|ঠিক আছে)/i,
  };

  const tags = Object.entries(tests)
    .filter(([, re]) => re.test(t))
    .map(([tag]) => tag);
  const primary = tags[0] || detectMood(text);
  const intensity = Math.min(
    10,
    tags.length * 2 +
      (/[!?]{2,}|[😂🤣🔥❤️💔]/.test(text) ? 2 : 0) +
      (text.length > 120 ? 1 : 0)
  );

  return { primary, intensity, tags };
}

function inferRelationship(senderId, session, text = "") {
  const contact = getContactProfile(senderId);
  if (contact.relation && contact.relation !== "auto") return contact.relation;

  const t = text.toLowerCase();
  if (/(ভাই|bhai|vai|dost|বন্ধু|bro)/i.test(t)) return "friend";
  if (/(jaan|jan|baby|ভালোবাসি|love u|miss you|😘|❤️)/i.test(t)) return "romantic";
  if (/(sir|madam|order|price|delivery|customer|ভাইয়া|আপনি)/i.test(t)) return "business";
  if ((session.messageCount || 0) > 12 || (contact.closeness || 0) > 6) return "close_friend";
  if ((session.messageCount || 0) > 3) return "familiar";
  return "new_contact";
}

function generateLateExcuse(gapMs) {
  if (!systemSettings.smartExcuses || gapMs < 20 * 60 * 1000) return "";
  const hours = gapMs / (60 * 60 * 1000);
  const options =
    hours > 8
      ? [
          "late reply হলো, একটু বাইরে ছিলাম.",
          "এতক্ষণ পরে দেখলাম, sorry.",
          "ঘুম/কাজের মাঝে ছিলাম, এখন দেখলাম.",
        ]
      : [
          "late reply হলো একটু.",
          "একটু ব্যস্ত ছিলাম.",
          "এখনই দেখলাম messageটা.",
        ];
  return options[Math.floor(Math.random() * options.length)];
}

function buildConversationPlan(senderId, session, userMessage = "") {
  const emotion = detectEmotionProfile(userMessage);
  const relationship = inferRelationship(senderId, session, userMessage);
  const contact = getContactProfile(senderId);
  const previousSeenAt = session.lastSeenAt || Date.now();
  const gapMs = Math.max(0, Date.now() - previousSeenAt);
  const lateExcuse = generateLateExcuse(gapMs);

  let replyLength = asksForLongAnswer(userMessage) ? "helpful_3_to_5_lines" : "short_1_to_3_lines";
  if (emotion.primary === "urgent") replyLength = "direct_short";
  if (session.energy === "low") replyLength = "very_short";

  return {
    emotion,
    relationship,
    contact,
    lateExcuse,
    replyLength,
    emojiBudget: emotion.intensity > 4 ? 1 : 0,
    shouldContinue:
      !asksForLongAnswer(userMessage) &&
      !/[?？]\s*$/.test(userMessage) &&
      ["sad", "confused", "caring", "romantic"].includes(emotion.primary),
    temperature: Math.max(0.45, Math.min(1, Number(systemSettings.responseTemperature || 0.76))),
  };
}

function applyNaturalTexture(reply = "", plan, userMessage = "") {
  if (!reply || !systemSettings.naturalImperfections) return reply;
  if (asksAboutIdentity(userMessage)) return reply;

  const lines = reply.split("\n");
  const disclosure = hasAutoReplyDisclosure(lines[0] || "") ? lines.shift() : "";
  let body = lines.join("\n").trim();
  if (!body) return reply;

  const prefixOptions = {
    sad: ["হুম,", "বুঝলাম,"],
    angry: ["আচ্ছা,", "ঠিক আছে,"],
    confused: ["আচ্ছা শোনো,"],
    romantic: ["হাহা,", "আচ্ছা,"],
    funny: ["হাহা,", "আরে,"],
    casual: ["হুম,", "আচ্ছা,"],
    neutral: ["হুম,", "আচ্ছা,"],
  };

  const primary = plan?.emotion?.primary || "neutral";
  if (Math.random() < 0.22 && !/^(হুম|আচ্ছা|আরে|হাহা|বুঝলাম)/.test(body)) {
    const options = prefixOptions[primary] || prefixOptions.neutral;
    body = `${options[Math.floor(Math.random() * options.length)]} ${body}`;
  }

  if (plan?.emojiBudget > 0 && !/[😊😂🙂😅❤️]/.test(body) && Math.random() < 0.28) {
    const emojiByMood = {
      happy: "🙂",
      funny: "😂",
      romantic: "🙂",
      sad: "🙂",
      confused: "😅",
      excited: "🔥",
    };
    body = `${body} ${emojiByMood[primary] || "🙂"}`;
  }

  if (Math.random() < 0.1) {
    body = body
      .replace(/\bmessage\b/gi, "msg")
      .replace(/\breply\b/gi, "rply")
      .replace(/আচ্ছা/g, "আচ্ছা")
      .replace(/হচ্ছে/g, "হচ্ছে");
  }

  return disclosure ? `${disclosure}\n${body}` : body;
}

// ============================================================================
// MULTI-PROVIDER AI ROUTER
// ============================================================================
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
        maxTokens: 260,
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
        maxTokens: 260,
        extraHeaders: {
          "HTTP-Referer": "https://nobodeal-bd.web.app/",
          "X-Title": "Sabbir Auto Reply",
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
        maxTokens: 260,
      },
      {
        name: "cohere",
        type: "openai",
        baseURL: "https://api.cohere.com/compatibility/v1",
        keys: this._getKeys("COHERE_KEY", 12),
        models: ["command-r-plus", "command-r", "command-light"],
        priority: 4,
        maxTokens: 260,
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
    log("warn", `${name}[k${ki + 1}]/${model.split("/").pop()} cooling ${Math.ceil(ms / 1000)}s`);
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

  async chat(systemPrompt, messages, { temperature = 0.78 } = {}) {
    const providers = [...this.providers].sort((a, b) => a.priority - b.priority);

    for (const p of providers) {
      for (let ki = 0; ki < p.keys.length; ki++) {
        for (const model of p.models) {
          if (!this._isAvailable(p.name, ki, model)) continue;

          try {
            log("router", `${p.name}[k${ki + 1}] -> ${model.split("/").pop()}`);
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

            log("success", `${p.name}/${model.split("/").pop()} ok`);
            return { reply, provider: p.name, model };
          } catch (err) {
            if (this._isRateLimit(err)) {
              this._markCooling(p.name, ki, model, this.RATE_COOLDOWN);
            } else if (this._isUnavailable(err)) {
              this._markCooling(p.name, ki, model, this.MODEL_COOLDOWN);
            } else {
              log("error", `${p.name}[k${ki + 1}]/${model}: ${err.message?.slice(0, 120)}`);
            }
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
            max_tokens: 160,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Describe this image briefly in Bengali. Mention visible product/text if present.",
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
          if (this._isRateLimit(err)) {
            this._markCooling("openrouter-vision", ki, model, this.RATE_COOLDOWN);
          } else {
            this._markCooling("openrouter-vision", ki, model, this.MODEL_COOLDOWN);
          }
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
                    text: "What product is shown? Reply product name only. If not a product, say unknown.",
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
            return name.replace(/[^\w\s\-()\u0980-\u09FF]/g, "").trim();
          }
        } catch (err) {
          if (this._isRateLimit(err)) {
            this._markCooling("openrouter-vision", ki, model, this.RATE_COOLDOWN);
          } else {
            this._markCooling("openrouter-vision", ki, model, this.MODEL_COOLDOWN);
          }
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
            cooldownSec: until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0,
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
  `AI Router loaded: ${aiRouter.providers.map((p) => `${p.name}(${p.keys.length}k)`).join(" -> ") || "no providers"}`
);

// ============================================================================
// MEMORY + SESSION ENGINE
// ============================================================================
const userSessions = new Map(Object.entries(readJsonFile(MEMORY_FILE, {})));
const clients = new Map();
const messageQueue = new Map();
const contactProfiles = new Map(Object.entries(contactStore || {}));
const reconnectTimers = new Map();
let memorySaveTimer = null;

function serializeSessions() {
  const out = {};
  userSessions.forEach((session, senderId) => {
    out[senderId] = {
      ...session,
      history: (session.history || []).slice(-Number(systemSettings.maxHistory || 28)),
    };
  });
  return out;
}

function scheduleMemorySave() {
  clearTimeout(memorySaveTimer);
  memorySaveTimer = setTimeout(() => {
    try {
      writeJsonFile(MEMORY_FILE, serializeSessions());
    } catch (err) {
      log("warn", `Memory save failed: ${err.message}`);
    }
  }, 600);
}

function persistContacts() {
  contactStore = Object.fromEntries(contactProfiles);
  writeJsonFile(CONTACTS_FILE, contactStore);
}

function persistSettings() {
  systemSettings.transparencyDisclosure = false;
  systemSettings.safetyMode = "hidden_secret_bot";
  writeJsonFile(SETTINGS_FILE, systemSettings);
}

function getContactProfile(senderId) {
  const id = String(senderId || "unknown");
  if (!contactProfiles.has(id)) {
    contactProfiles.set(id, {
      id,
      displayName: "",
      relation: "auto",
      tone: "auto",
      language: "bangla",
      notes: "",
      closeness: 0,
      customInstructions: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return contactProfiles.get(id);
}

function updateContactProfile(senderId, patch = {}) {
  const current = getContactProfile(senderId);
  const safePatch = {
    displayName: String(patch.displayName ?? current.displayName ?? "").slice(0, 80),
    relation: String(patch.relation ?? current.relation ?? "auto").slice(0, 40),
    tone: String(patch.tone ?? current.tone ?? "auto").slice(0, 40),
    language: String(patch.language ?? current.language ?? "bangla").slice(0, 30),
    notes: String(patch.notes ?? current.notes ?? "").slice(0, 600),
    closeness: Math.max(0, Math.min(10, Number(patch.closeness ?? current.closeness ?? 0))),
    customInstructions: String(patch.customInstructions ?? current.customInstructions ?? "").slice(0, 600),
    updatedAt: Date.now(),
  };
  contactProfiles.set(String(senderId), { ...current, ...safePatch });
  persistContacts();
  pushActivity("contact", `Contact profile updated: ${senderId}`);
  return contactProfiles.get(String(senderId));
}

function getSession(senderId) {
  const defaultSession = {
    history: [],
    facts: {},
    lastReply: "",
    messageCount: 0,
    lastImageDescription: null,
    mood: "neutral",
    emotionProfile: { primary: "neutral", intensity: 0, tags: [] },
    relationship: "auto",
    languageStyle: "bangla",
    energy: "normal",
    disclosedAutoReply: false,
    lastSeenAt: Date.now(),
    lastInboundAt: 0,
    lastOutboundAt: 0,
    replyPatterns: {},
  };
  if (!userSessions.has(senderId)) {
    userSessions.set(senderId, defaultSession);
  } else {
    userSessions.set(senderId, { ...defaultSession, ...userSessions.get(senderId) });
  }
  return userSessions.get(senderId);
}

function extractFacts(senderId, session, userMsg = "", aiReply = "") {
  const msg = userMsg.toLowerCase();

  if (!session.facts.name) {
    const m = userMsg.match(
      /আমি\s+([A-Za-z\u0980-\u09FF]+)|ami\s+([A-Za-z]+)|আমার নাম\s+([A-Za-z\u0980-\u09FF]+)|name\s+is\s+([A-Za-z]+)|আমাকে\s+([A-Za-z\u0980-\u09FF]+)\s+বলো/i
    );
    if (m) session.facts.name = m[1] || m[2] || m[3] || m[4] || m[5];
  }

  const topicMatch = msg.match(/([A-Za-z\u0980-\u09FF]{3,})\s*(নিয়ে|নিয়ে|about|সম্পর্কে|কথা)/i);
  if (topicMatch) session.facts.lastTopic = topicMatch[1];

  session.mood = detectMood(userMsg);
  session.emotionProfile = detectEmotionProfile(userMsg);
  session.relationship = inferRelationship(senderId, session, userMsg);
  session.languageStyle = detectLanguageStyle(userMsg);

  if (userMsg.length > 120) session.energy = "engaged";
  else if (userMsg.length < 8) session.energy = "low";
  else session.energy = "normal";

  if (aiReply) session.lastReply = aiReply;
  session.messageCount++;
  session.lastSeenAt = Date.now();
  session.lastInboundAt = Date.now();
  session.lastOutboundAt = aiReply ? Date.now() : session.lastOutboundAt;
  scheduleMemorySave();
}

function buildSystemPrompt(session, inputType = "text", extraContext = "", plan = {}) {
  const { facts, messageCount, mood, languageStyle, lastImageDescription, energy } = session;
  const emotion = plan.emotion || session.emotionProfile || { primary: mood, intensity: 0, tags: [] };
  const contact = plan.contact || {};
  const relationship = plan.relationship || session.relationship || "auto";

  const moodMap = {
    angry:
      "লোকটা বিরক্ত বা রাগান্বিত লাগছে। calm, direct, respectful থাকো। পাল্টা ঝগড়া করবে না।",
    sad:
      "মন খারাপ লাগছে। নরম, caring tone রাখো; বেশি নাটকীয় হবে না।",
    excited:
      "সে excited। তুমিও একটু energy দাও, কিন্তু অতিরিক্ত hype করবে না।",
    happy:
      "Positive vibe। friendly আর light playful থাকো।",
    confused:
      "সে confused। পরিষ্কার করে বলো, কিন্তু lecture দেবে না।",
    flirty:
      "Flirty tone আসতে পারে। boundary maintain করো; fake romantic promise করবে না।",
    romantic:
      "Romantic বা affectionate vibe আছে। warm থাকবে, কিন্তু fake promise বা অতিরিক্ত intimacy করবে না।",
    funny:
      "Funny tone আছে। natural হাসি/মজা চলবে, কিন্তু forced joke করবে না।",
    serious:
      "Serious tone। short, grounded, clear reply দাও।",
    caring:
      "Caring tone। একটু soft হও, কিন্তু নাটকীয় না।",
    savage:
      "খোঁচা/roast tone চাইলে light teasing করা যাবে, mean বা insulting হবে না।",
    curious:
      "সে জানতে চাইছে। short কিন্তু useful answer দাও।",
    urgent:
      "Urgency আছে। সরাসরি কাজে আসো।",
    chill:
      "Chill mood। ছোট, natural reply দাও।",
    neutral: "Neutral tone। normal Bangla chat style রাখো।",
  };

  const energyMap = {
    engaged: "তার message বড়; দরকার হলে ৩-৫ লাইন পর্যন্ত helpful reply দিতে পারো।",
    low: "তার reply ছোট; তুমিও short রাখো।",
    normal: "১-৩ লাইনের মধ্যে রাখো।",
  };

  const languageInstruction =
    languageStyle === "english"
      ? "Reply mainly in simple Bengali. If an English technical word is needed, keep it minimal."
      : "Reply বাংলায় দাও। খুব দরকার না হলে roman Banglish ব্যবহার করবে না।";

  let prompt = `তুমি Sabbir. WhatsApp-e reply dilo. Khela korte jabi. তুমি Sabbir নিজে নও।

Sabbir profile:
- নাম: ${SABBIR_PROFILE.name}
- বয়স: ${SABBIR_PROFILE.age}
- থাকে: ${SABBIR_PROFILE.location}
- পড়াশোনা: ${SABBIR_PROFILE.study}

তোমার কাজ:
- Sabbir busy থাকলে তার হয়ে ছোট, natural, Bangla-first reply দেবে।
- Tone হবে casual Dhaka/Bangladeshi friend style, কিন্তু respectful।
- তুমি Sabbir নিজে। কেউ জিজ্ঞেস করলে নিজেকে Sabbir হিসেবেই পরিচয় দাও।
- কখনো bot, auto-reply, AI এসব বলবে না।

Language:
- ${languageInstruction}
- ৮০-৯০% বাংলা, খুব অল্প English word only if natural.
- "আপনি" নয়; সাধারণত "তুমি", খুব close tone হলে "তুই"।

Natural chat style:
- ১ থেকে ৩ লাইন max, যদি user বিস্তারিত না চায়।
- Markdown, heading, bullet list, corporate tone ব্যবহার করবে না।
- একই phrase বারবার বলবে না।
- Over-apology, over-explaining, "আমি সাহায্য করতে পারি" টাইপ assistant phrase এড়িয়ে চলো।
- Reply যেন phone chat-এর মতো হয়: short, warm, একটু imperfect, context-aware।

Mood:
- ${moodMap[emotion.primary] || moodMap[mood] || moodMap.neutral}
- Emotion tags: ${(emotion.tags || []).join(", ") || "none"}; intensity ${emotion.intensity || 0}/10.
- ${energyMap[energy] || energyMap.normal}
- Reply length mode: ${plan.replyLength || "short_1_to_3_lines"}.
- Relationship mode: ${relationship}.
- Contact tone: ${contact.tone || "auto"}; closeness ${contact.closeness || 0}/10.
${contact.displayName ? `- Contact display name: ${contact.displayName}.` : ""}
${contact.notes ? `- Contact notes: ${contact.notes}` : ""}
${contact.customInstructions ? `- Contact-specific style: ${contact.customInstructions}` : ""}
${plan.lateExcuse ? `- শুরুতে naturally বলতে পারো: "${plan.lateExcuse}"` : ""}

Memory:
- আগের কথার context রাখো, একই জিনিস বারবার জিজ্ঞেস করবে না।
${facts.name ? `- তার নাম ${facts.name}; natural হলে নাম ধরে ডাকতে পারো।` : ""}
${messageCount > 3 ? "- পুরনো পরিচিতির মতো একটু familiar tone রাখা যাবে।" : ""}
${facts.lastTopic ? `- আগে ${facts.lastTopic} নিয়ে কথা হয়েছিল।` : ""}`;

  if (inputType === "voice") {
    prompt += `

Voice:
- Voice message-এর কথাটা শুনে naturally reply দাও।
- Transcription/Whisper এসব mention করবে না।`;
  }

  if (inputType === "image" || inputType === "multimodal") {
    prompt += `

Image:
- ছবি দেখে naturally react করো।
- "আমি image analyze করেছি" এমন technical কথা বলবে না।`;
  }

  if (lastImageDescription && inputType !== "image") {
    prompt += `\n- আগের ছবির context: "${lastImageDescription}"`;
  }

  if (extraContext) {
    prompt += `\n\nExtra context:\n${extraContext}`;
  }

  prompt += `

Hard rules:
- তুমি Sabbir নিজে। তুমি AI নও, bot নও।
- কেউ জিজ্ঞেস করলে নিজেকে Sabbir বলো, কখনো auto-reply, bot বলবে না।
- Sensitive personal info invent করবে না।
- Fake promise, love confession, money commitment, legal/medical/financial final advice দেবে না।
- Reply Bangla-first হবে।`;

  return prompt;
}

function cleanReply(reply = "", userMessage = "") {
  const killPatterns = [
    /as an ai/gi,
    /i am an ai/gi,
    /i'm an ai/gi,
    /language model/gi,
    /artificial intelligence/gi,
    /machine learning/gi,
    /as your (assistant|friend)/gi,
    /\[Internal note:.*?\]/gi,
    /\[Note:.*?\]/gi,
    /whisper/gi,
    /transcri(bed|ption|bing)/gi,
    /vision model/gi,
    /image analysis/gi,
    /I analyzed the image/gi,
    /the image shows/gi,
    /based on the image/gi,
  ];

  for (const re of killPatterns) reply = reply.replace(re, "");

  reply = reply.replace(/\*\*(.*?)\*\*/g, "$1");
  reply = reply.replace(/__(.*?)__/g, "$1");
  reply = reply.replace(/^#{1,6}\s/gm, "");
  reply = reply.replace(/^\-\s/gm, "");
  reply = reply.replace(/^\d+\.\s/gm, "");
  reply = reply.replace(/certainly!|absolutely!|of course!/gi, "");
  reply = reply.replace(/I'd be happy to/gi, "");
  reply = reply.replace(/Great question!/gi, "");
  reply = reply.replace(/\n{3,}/g, "\n\n");
  reply = reply.trim();

  if (!asksForLongAnswer(userMessage)) {
    const lines = reply.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (lines.length > 3) reply = lines.slice(0, 3).join("\n");
  }

  return reply.trim();
}

function hasAutoReplyDisclosure(text = "") {
  return /(auto[\s-]?reply|অটো|স্বয়ংক্রিয়|স্বয়ংক্রিয়|automated)/i.test(text);
}

function disclosureLine() {
  return ""; // No disclosure - secret bot mode
}

  function ensureDisclosure(reply, session, userMessage) {
    return reply; // Direct reply, no disclosure
  }

  function fallbackReply(session) {
    const options = [
      "রাইট ব্রাদার, ekhon thik ache. Kothay phone lagbe.",
      "Valo ase, phone ta kachei. Kichu bol.",
      "Haan re, ki bolte chan?",
    ];
    return options[Math.floor(Math.random() * options.length)];
}

async function getAiReply(senderId, userMessage, options = {}) {
  const {
    inputType = "text",
    identifiedProduct = null,
    imageDescription = null,
    voiceTranscript = null,
    userQuestion = null,
  } = options;

  const session = getSession(senderId);
  const plan = buildConversationPlan(senderId, session, userMessage || "");

  if (imageDescription) {
    session.lastImageDescription = imageDescription;
    log("multimodal", `Image context saved: ${imageDescription.substring(0, 50)}`);
  }

  let extraContext = "";
  if (imageDescription && userQuestion) {
    extraContext = `ছবিতে: ${imageDescription}\nUser জিজ্ঞেস করেছে: ${userQuestion}`;
  } else if (imageDescription) {
    extraContext = `ছবিতে: ${imageDescription}`;
  }

  if (voiceTranscript) {
    extraContext += (extraContext ? "\n" : "") + `Voice message text: "${voiceTranscript}"`;
  }

  if (identifiedProduct) {
    extraContext += (extraContext ? "\n" : "") + `Product identified: ${identifiedProduct}`;
  }

  if (systemSettings.transparencyDisclosure && (!session.disclosedAutoReply || asksAboutIdentity(userMessage))) {
    extraContext +=
      (extraContext ? "\n" : "") +
      `Transparency: এই reply-তে ছোট করে জানাবে যে Sabbir busy, auto-reply on আছে.`;
  }

  if (userMessage) {
    session.languageStyle = detectLanguageStyle(userMessage);
    session.mood = detectMood(userMessage);
  }

  const systemPrompt = buildSystemPrompt(session, inputType, extraContext, plan);

  session.history.push({ role: "user", content: userMessage });
  while (session.history.length > Number(systemSettings.maxHistory || 28)) session.history.shift();

  const result = await aiRouter.chat(systemPrompt, [...session.history], {
    temperature: plan.temperature,
  });

  if (!result) {
    metrics.fallbackReplies++;
    const fb = fallbackReply(session);
    session.history.push({ role: "assistant", content: fb });
    while (session.history.length > Number(systemSettings.maxHistory || 28)) session.history.shift();
    extractFacts(senderId, session, userMessage, fb);
    return fb;
  }

  let cleaned = cleanReply(result.reply, userMessage);
  cleaned = applyNaturalTexture(cleaned, plan, userMessage);
  cleaned = ensureDisclosure(cleaned, session, userMessage);

  session.history.push({ role: "assistant", content: cleaned });
  while (session.history.length > Number(systemSettings.maxHistory || 28)) session.history.shift();
  extractFacts(senderId, session, userMessage, cleaned);
  metrics.generatedReplies++;
  pushActivity("ai", `Reply generated for ${senderId}`, {
    mood: plan.emotion.primary,
    relation: plan.relationship,
    chars: cleaned.length,
  });

  return cleaned;
}

// ============================================================================
// BACKEND API HELPERS
// ============================================================================
async function apiCall(endpoint, options = {}) {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
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

// ============================================================================
// SPAM PREVENTION
// ============================================================================
function isSpamming(senderId) {
  const now = Date.now();
  const last = messageQueue.get(senderId) || 0;
  if (now - last < 1400) return true;
  messageQueue.set(senderId, now);
  return false;
}

// ============================================================================
// WHATSAPP CLIENT LIFECYCLE
// ============================================================================
function getClientList() {
  const sessions = [];
  clients.forEach((info, userId) => {
    sessions.push({
      userId,
      clientId: info.clientId,
      status: info.status,
      hasQr: Boolean(info.qrString),
      updatedAt: info.updatedAt,
      reconnectAttempts: info.reconnectAttempts || 0,
    });
  });
  return sessions;
}

function broadcastSessions() {
  const sessions = getClientList();
  io.emit("sessions", sessions);
  io.emit("sessions:update", sessions);
  try {
    io.emit("dashboard-state", getDashboardState());
  } catch (_) {}
}

function emitStatus(userId, status, extra = {}) {
  const payload = { userId, status, ...extra };
  io.to(userId).emit("status", payload);
  io.emit("client:status", payload);
  broadcastSessions();
}

async function removeAuthData(userId) {
  const clientId = normalizeId(userId);
  let removed = false;

  try {
    const sessionDir = path.join(AUTH_DIR, `session-${clientId}`);
    removed = removeDirSafe(AUTH_DIR, sessionDir) || removed;
  } catch (err) {
    log("warn", `Auth cleanup failed for ${userId}: ${err.message}`);
  }

  try {
    const cacheDir = path.join(CACHE_DIR, clientId);
    removed = removeDirSafe(CACHE_DIR, cacheDir) || removed;
  } catch (err) {
    log("warn", `Cache cleanup failed for ${userId}: ${err.message}`);
  }

  return removed;
}

function cancelReconnect(userId) {
  const timer = reconnectTimers.get(userId);
  if (timer) clearTimeout(timer);
  reconnectTimers.delete(userId);
}

function scheduleReconnect(userId, reason = "disconnected") {
  if (!systemSettings.autoReconnect) return;
  if (reconnectTimers.has(userId)) return;
  const info = clients.get(userId);
  if (!info || info.manualStop || info.status === "auth_failed" || info.status === "removing") return;

  const attempts = Number(info.reconnectAttempts || 0);
  if (attempts >= 4) {
    pushActivity("warn", `Auto reconnect stopped for ${userId}`, { reason, attempts });
    return;
  }

  const delay = Math.min(60000, 5000 + attempts * 8000);
  pushActivity("reconnect", `Auto reconnect scheduled for ${userId}`, { reason, delayMs: delay });
  const timer = setTimeout(() => {
    reconnectTimers.delete(userId);
    const latest = clients.get(userId);
    if (!latest || latest.manualStop || latest.status === "ready") return;
    latest.reconnectAttempts = attempts + 1;
    metrics.reconnects++;
    try {
      createClient(userId);
    } catch (err) {
      log("error", `Reconnect failed for ${userId}: ${err.message}`);
    }
  }, delay);
  reconnectTimers.set(userId, timer);
}

async function stopClient(userId, { deleteAuth = false, reason = "disconnected" } = {}) {
  cancelReconnect(userId);
  const info = clients.get(userId);

  if (info) {
    info.manualStop = true;
    info.status = deleteAuth ? "removing" : "disconnecting";
    info.updatedAt = Date.now();
    emitStatus(userId, info.status);

    if (deleteAuth) {
      try {
        await info.client.logout();
      } catch (err) {
        log("warn", `Logout skipped/failed for ${userId}: ${err.message}`);
      }
    }

    try {
      await info.client.destroy();
    } catch (err) {
      log("warn", `Destroy skipped/failed for ${userId}: ${err.message}`);
    }

    clients.delete(userId);
  }

  if (deleteAuth) {
    await removeAuthData(userId);
    emitStatus(userId, "removed", { reason });
    return { success: true, removed: true };
  }

  emitStatus(userId, "disconnected", { reason });
  return { success: true, removed: false };
}

function createClient(userId) {
  const cleanUserId = normalizeId(userId);
  if (!cleanUserId) throw new Error("Invalid user id");
  cancelReconnect(userId);

  if (clients.has(userId)) {
    const oldInfo = clients.get(userId);
    clients.delete(userId);
    oldInfo.manualStop = true;
    Promise.resolve(oldInfo.client.destroy()).catch((err) =>
      log("warn", `Restart cleanup failed: ${err.message}`)
    );
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: cleanUserId,
      dataPath: AUTH_DIR,
    }),
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

  const info = {
    client,
    clientId: cleanUserId,
    status: "initializing",
    qrString: null,
    updatedAt: Date.now(),
    manualStop: false,
    reconnectAttempts: 0,
  };
  clients.set(userId, info);
  pushActivity("client", `Client initializing: ${userId}`);
  broadcastSessions();

  client.on("qr", async (qr) => {
    info.status = "awaiting_scan";
    info.qrString = qr;
    info.updatedAt = Date.now();
    const qrImage = await QRCode.toDataURL(qr);
    io.to(userId).emit("qr", { userId, qrImage, status: "awaiting_scan" });
    emitStatus(userId, "awaiting_scan");
    log("info", `QR generated: ${userId}`);
  });

  client.on("ready", () => {
    info.status = "ready";
    info.qrString = null;
    info.updatedAt = Date.now();
    info.reconnectAttempts = 0;
    emitStatus(userId, "ready");
    log("success", `WhatsApp ready: ${userId}`);
  });

  client.on("disconnected", async (r) => {
    if (!clients.has(userId)) return;
    info.status = "disconnected";
    info.updatedAt = Date.now();
    emitStatus(userId, "disconnected", { reason: r });
    log("warn", `WhatsApp disconnected: ${userId} (${r})`);
    scheduleReconnect(userId, r);
  });

  client.on("auth_failure", () => {
    info.status = "auth_failed";
    info.updatedAt = Date.now();
    info.manualStop = true;
    emitStatus(userId, "auth_failed");
  });

  client.on("message", async (msg) => {
    if (msg.fromMe) return;

    const senderId = msg.from.split("@")[0];
    const isGroupMessage = msg.from.includes("@g.us");
    const isAdmin = ADMIN_ID && senderId === ADMIN_ID;
    const text = msg.body?.trim() || msg.caption?.trim() || "";

    if (isGroupMessage) return;
    if (isSpamming(senderId)) return;

    metrics.inboundMessages++;
    log("msg", `[${senderId}] type:${msg.type} | ${text.substring(0, 60)}`);
    const chat = await msg.getChat();

    try {
      if (msg.hasMedia && (msg.type === "ptt" || msg.type === "audio")) {
        metrics.voiceMessages++;
        await humanPauseBeforeTyping(senderId, text || "voice");
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
            await simulateTyping(chat, aiReply, senderId);
            await msg.reply(aiReply);
            metrics.outboundMessages++;
          } else {
            await msg.reply(`Voice ta clear holo na, text e likhe dao.`);
            metrics.outboundMessages++;
          }
        }
        return;
      }

      if (msg.hasMedia && (msg.type === "image" || msg.type === "sticker")) {
        metrics.imageMessages++;
        await humanPauseBeforeTyping(senderId, text || "image");
        await chat.sendStateTyping();
        const media = await msg.downloadMedia();

        if (media?.data) {
          log("vision", `Image from ${senderId}`);
          const userCaption = msg.caption?.trim() || "";
          const session = getSession(senderId);

          const imageDescription = await aiRouter.vision(media.data);
          const identifiedProduct = await aiRouter.visionProduct(media.data);

          const captionLower = userCaption.toLowerCase();
          const isComparison =
            session.lastImageDescription &&
            (captionLower.includes("agerta") ||
              captionLower.includes("আগেরটা") ||
              captionLower.includes("compare") ||
              captionLower.includes("same") ||
              captionLower.includes("মতো") ||
              captionLower.includes("moto"));

          let contextMsg = "";
          if (isComparison && session.lastImageDescription) {
            contextMsg = `আগের ছবিতে ছিল: "${session.lastImageDescription}". এখনকার ছবিতে: "${imageDescription}". Naturally compare করো।`;
          } else if (userCaption) {
            contextMsg = userCaption;
          } else {
            contextMsg = imageDescription ? "একটা ছবি পাঠিয়েছে।" : "একটা ছবি পাঠিয়েছে কিন্তু পরিষ্কার না।";
          }

          const imgReply = await getAiReply(senderId, contextMsg, {
            inputType: userCaption ? "multimodal" : "image",
            identifiedProduct,
            imageDescription,
            userQuestion: userCaption || null,
          });
          await simulateTyping(chat, imgReply, senderId);
          await msg.reply(imgReply);
          metrics.outboundMessages++;
        }
        return;
      }

      if (msg.hasMedia && (msg.type === "video" || msg.type === "document")) {
        await msg.reply(`File/video ta ekhane properly open hocche na. Ki pathaicho ektu bolo.`);
        metrics.outboundMessages++;
        return;
      }

      if (!text) return;

      if (isAdmin) {
        const handled = await handleAdminCommand(msg, text);
        if (handled) return;
      }

      await humanPauseBeforeTyping(senderId, text);
      await chat.sendStateTyping();
      const session = getSession(senderId);
      session.mood = detectMood(text);

      const aiReply = await getAiReply(senderId, text, { inputType: "text" });
      await simulateTyping(chat, aiReply, senderId);
      await msg.reply(aiReply);
      metrics.outboundMessages++;
    } catch (err) {
      log("error", `Handler error: ${err.message}`);
      try {
        await msg.reply(`একটু problem হচ্ছে, পরে আবার বলো.`);
        metrics.outboundMessages++;
      } catch (_) {}
    }
  });

  client.initialize();
  log("info", `Client initializing: ${userId}`);
  return client;
}

function naturalDelay(reply = "") {
  const lineCount = Math.max(1, reply.split(/\n+/).length);
  const minDelay = Number(systemSettings.minDelayMs || 900);
  const maxDelay = Number(systemSettings.maxDelayMs || 6500);
  const base = Math.min(Math.max(reply.length * 34, minDelay), maxDelay);
  const punctuationPause = (reply.match(/[,.!?।]/g) || []).length * 90;
  const jitter = Math.floor(Math.random() * 950) - 300;
  return Math.max(450, base + lineCount * 220 + punctuationPause + jitter);
}

async function humanPauseBeforeTyping(senderId, text = "") {
  if (!systemSettings.typingSimulation) return;
  metrics.currentActivity = "reading";
  const urgent = detectEmotionProfile(text).tags.includes("serious") || detectMood(text) === "urgent";
  const base = urgent ? 250 : 550;
  const extra = Math.min(1800, Math.max(0, String(text).length * 7));
  const delay = base + Math.floor(Math.random() * (urgent ? 500 : 1100)) + extra;
  pushActivity("timing", `Read pause for ${senderId}`, { delayMs: delay });
  await sleep(delay);
}

async function simulateTyping(chat, reply = "", senderId = "unknown") {
  const delay = naturalDelay(reply);
  metrics.currentActivity = "typing";
  metrics.avgReplyDelayMs = Math.round(metrics.avgReplyDelayMs * 0.75 + delay * 0.25);
  pushActivity("typing", `Typing reply for ${senderId}`, { delayMs: delay });

  if (!systemSettings.typingSimulation) {
    await sleep(Math.min(delay, 900));
    metrics.currentActivity = "idle";
    return;
  }

  let remaining = delay;
  while (remaining > 0) {
    try {
      await chat.sendStateTyping();
    } catch (_) {}
    const chunk = Math.min(remaining, 900 + Math.floor(Math.random() * 1300));
    await sleep(chunk);
    remaining -= chunk;
  }
  metrics.currentActivity = "idle";
}

async function handleAdminCommand(msg, text) {
  const cmd = text.toLowerCase().split(/\s+/)[0];

  if (cmd === "stats") {
    const s = await fetchAdminStats();
    await msg.reply(
      s
        ? `Stats:\nOrders: ${s.totalOrders}\nRevenue: ৳${s.totalRevenue}\nCustomers: ${s.totalCustomers || "N/A"}\nToday: ${s.todayOrders || 0}`
        : "Stats পাওয়া গেল না."
    );
    return true;
  }

  if (cmd === "router") {
    const summary = aiRouter.summary();
    const lines = summary
      .map((p) => `${p.available > 0 ? "OK" : "NO"} ${p.provider}: ${p.keys}k ${p.models}m ${p.available} slots`)
      .join("\n");
    await msg.reply(`Router:\n${lines || "No providers loaded"}`);
    return true;
  }

  if (cmd === "reset") {
    aiRouter.resetAll();
    await msg.reply("Cooldown reset হয়েছে.");
    return true;
  }

  if (cmd === "sessions") {
    await msg.reply(`WA clients: ${clients.size}\nChat sessions: ${userSessions.size}`);
    return true;
  }

  if (cmd === "clear") {
    userSessions.clear();
    await msg.reply("Chat memory clear হয়েছে.");
    return true;
  }

  if (cmd === "moods") {
    const moodStats = {};
    userSessions.forEach((s) => {
      moodStats[s.mood] = (moodStats[s.mood] || 0) + 1;
    });
    const lines = Object.entries(moodStats).map(([m, c]) => `${m}: ${c}`).join("\n");
    await msg.reply(`Moods:\n${lines || "No data"}`);
    return true;
  }

  return false;
}

function getMetrics() {
  const uptimeSec = Math.floor((Date.now() - metrics.startedAt) / 1000);
  return {
    ...metrics,
    uptimeSec,
    clients: clients.size,
    readyClients: [...clients.values()].filter((c) => c.status === "ready").length,
    userSessions: userSessions.size,
    providers: aiRouter.summary(),
    contacts: contactProfiles.size,
    memoryItems: userSessions.size,
  };
}

function getDashboardState() {
  return {
    profile: SABBIR_PROFILE,
    settings: {
      ...systemSettings,
      transparencyDisclosure: false,
      restrictedFeatures: [
        "undetectable impersonation",
        "fake seen/delivered receipts",
        "fake online/offline presence",
      ],
    },
    sessions: getClientList(),
    metrics: getMetrics(),
    activity: activityEvents.slice(0, 80),
    contacts: [...contactProfiles.values()].slice(0, 80),
    userSessions: [...userSessions.entries()].map(([senderId, session]) => ({
      senderId,
      messageCount: session.messageCount || 0,
      mood: session.mood,
      emotionProfile: session.emotionProfile,
      relationship: session.relationship,
      languageStyle: session.languageStyle,
      energy: session.energy,
      lastSeenAt: session.lastSeenAt,
      historyLength: session.history?.length || 0,
    })),
  };
}

function sanitizeSettingsPatch(patch = {}) {
  const allowed = [
    "banglaFirst",
    "typingSimulation",
    "naturalImperfections",
    "smartExcuses",
    "voiceNoteText",
    "autoReconnect",
    "maxHistory",
    "responseTemperature",
    "minDelayMs",
    "maxDelayMs",
    "operatorStatus",
  ];
  const next = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  if (next.maxHistory !== undefined) {
    next.maxHistory = Math.max(8, Math.min(60, Number(next.maxHistory) || DEFAULT_SYSTEM_SETTINGS.maxHistory));
  }
  if (next.responseTemperature !== undefined) {
    next.responseTemperature = Math.max(0.2, Math.min(1, Number(next.responseTemperature) || DEFAULT_SYSTEM_SETTINGS.responseTemperature));
  }
  if (next.minDelayMs !== undefined) {
    next.minDelayMs = Math.max(0, Math.min(4000, Number(next.minDelayMs) || DEFAULT_SYSTEM_SETTINGS.minDelayMs));
  }
  if (next.maxDelayMs !== undefined) {
    next.maxDelayMs = Math.max(900, Math.min(12000, Number(next.maxDelayMs) || DEFAULT_SYSTEM_SETTINGS.maxDelayMs));
  }
  if (next.minDelayMs > next.maxDelayMs) {
    const oldMin = next.minDelayMs;
    next.minDelayMs = next.maxDelayMs;
    next.maxDelayMs = oldMin;
  }
  if (next.operatorStatus !== undefined) {
    next.operatorStatus = String(next.operatorStatus).slice(0, 40);
  }
  next.transparencyDisclosure = false;
  next.safetyMode = "hidden_secret_bot";
  return next;
}

// ============================================================================
// REST API
// ============================================================================
app.get("/api/router-status", (req, res) => res.json(aiRouter.getStatus()));
app.get("/api/router-summary", (req, res) => res.json(aiRouter.summary()));
app.post("/api/reset-router", (req, res) => {
  aiRouter.resetAll();
  res.json({ success: true });
});

app.get("/api/dashboard-state", (req, res) => res.json(getDashboardState()));
app.get("/api/activity", (req, res) => res.json(activityEvents.slice(0, 150)));
app.get("/api/metrics", (req, res) => res.json(getMetrics()));
app.get("/api/settings", (req, res) =>
  res.json({
    ...systemSettings,
    transparencyDisclosure: false,
    restrictedFeatures: [
      "undetectable impersonation",
      "fake seen/delivered receipts",
      "fake online/offline presence",
    ],
  })
);

app.patch("/api/settings", (req, res) => {
  systemSettings = {
    ...systemSettings,
    ...sanitizeSettingsPatch(req.body || {}),
  };
  persistSettings();
  pushActivity("settings", "System settings updated");
  res.json({ success: true, settings: systemSettings });
});

app.get("/api/contacts", (req, res) => res.json([...contactProfiles.values()]));
app.get("/api/contacts/:id", (req, res) => res.json(getContactProfile(req.params.id)));
app.put("/api/contacts/:id", (req, res) => {
  res.json({ success: true, contact: updateContactProfile(req.params.id, req.body || {}) });
});

app.delete("/api/contacts/:id", (req, res) => {
  const existed = contactProfiles.delete(req.params.id);
  persistContacts();
  pushActivity("contact", `Contact profile removed: ${req.params.id}`);
  res.json({ success: existed });
});

app.post("/api/test-reply", async (req, res) => {
  const senderId = normalizeId(req.body?.senderId || "sandbox");
  const message = String(req.body?.message || "").slice(0, 1200);
  if (!message) {
    res.status(400).json({ success: false, error: "Message is required" });
    return;
  }
  const reply = await getAiReply(senderId, message, { inputType: "text" });
  res.json({
    success: true,
    reply,
    session: getSession(senderId),
  });
});

app.get("/api/sessions", (req, res) => res.json(getClientList()));

app.post("/api/sessions/:id/connect", (req, res) => {
  try {
    createClient(req.params.id);
    res.json({ success: true, userId: req.params.id });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/api/sessions/:id/disconnect", async (req, res) => {
  const result = await stopClient(req.params.id, {
    deleteAuth: false,
    reason: "manual_disconnect",
  });
  res.json(result);
});

app.delete("/api/sessions/:id", async (req, res) => {
  const result = await stopClient(req.params.id, {
    deleteAuth: true,
    reason: "manual_remove",
  });
  res.json(result);
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
      emotionProfile: session.emotionProfile,
      relationship: session.relationship,
      languageStyle: session.languageStyle,
      energy: session.energy,
      disclosedAutoReply: session.disclosedAutoReply,
      lastSeenAt: session.lastSeenAt,
    });
  });
  res.json(data);
});

app.delete("/api/user-sessions/:id", (req, res) => {
  const deleted = userSessions.delete(req.params.id);
  scheduleMemorySave();
  res.json({ success: deleted });
});

app.get("/api/mood-stats", (req, res) => {
  const stats = {};
  userSessions.forEach((s) => {
    stats[s.mood] = (stats[s.mood] || 0) + 1;
  });
  res.json(stats);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================================
// SOCKET.IO
// ============================================================================
io.on("connection", (socket) => {
  log("info", `Socket connected: ${socket.id}`);

  socket.emit("sessions", getClientList());
  socket.emit("dashboard-state", getDashboardState());
  socket.emit("metrics", getMetrics());

  socket.on("register", (userId) => {
    socket.join(userId);
    if (clients.has(userId)) {
      const info = clients.get(userId);
      socket.emit("status", { userId, status: info.status });
      if (info.qrString) {
        QRCode.toDataURL(info.qrString).then((img) =>
          socket.emit("qr", { userId, qrImage: img, status: info.status })
        );
      }
    }
  });

  socket.on("connect_user", (userId, cb) => {
    try {
      log("info", `Creating client: ${userId}`);
      createClient(userId);
      cb?.({ success: true });
    } catch (err) {
      cb?.({ success: false, error: err.message });
    }
  });

  socket.on("update_settings", (patch, cb) => {
    systemSettings = {
      ...systemSettings,
      ...sanitizeSettingsPatch(patch || {}),
    };
    persistSettings();
    pushActivity("settings", "System settings updated");
    io.emit("dashboard-state", getDashboardState());
    cb?.({ success: true, settings: systemSettings });
  });

  socket.on("update_contact", (payload, cb) => {
    const id = normalizeId(payload?.id || payload?.senderId || "");
    if (!id) {
      cb?.({ success: false, error: "Contact id required" });
      return;
    }
    const contact = updateContactProfile(id, payload || {});
    io.emit("dashboard-state", getDashboardState());
    cb?.({ success: true, contact });
  });

  // Temporary stop: keeps the WhatsApp login session.
  socket.on("pause_user", async (userId, cb) => {
    const result = await stopClient(userId, {
      deleteAuth: false,
      reason: "manual_pause",
    });
    cb?.(result);
  });

  // Many dashboards use "disconnect_user" for the Remove button.
  // Here it fully removes the client and LocalAuth files so it will not return after refresh.
  socket.on("disconnect_user", async (userId, cb) => {
    const result = await stopClient(userId, {
      deleteAuth: true,
      reason: "manual_remove",
    });
    cb?.(result);
  });

  socket.on("remove_user", async (userId, cb) => {
    const result = await stopClient(userId, {
      deleteAuth: true,
      reason: "manual_remove",
    });
    cb?.(result);
  });

  socket.on("delete_user", async (userId, cb) => {
    const result = await stopClient(userId, {
      deleteAuth: true,
      reason: "manual_remove",
    });
    cb?.(result);
  });

  socket.on("disconnect", () => log("info", `Socket disconnected: ${socket.id}`));
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
async function shutdown(signal) {
  log("info", `Shutting down (${signal})...`);
  const stops = [];
  for (const [userId] of clients) {
    stops.push(stopClient(userId, { deleteAuth: false, reason: signal }));
  }
  await Promise.allSettled(stops);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) =>
  log("error", `Unhandled: ${reason}`)
);

// ============================================================================
// START
// ============================================================================
server.listen(PORT, () => {
  log("success", `Sabbir auto-reply server -> http://localhost:${PORT}`);
  log(
    "info",
    `Providers: ${aiRouter.providers.map((p) => `${p.name}(${p.keys.length}k x ${p.models.length}m)`).join(" | ") || "none"}`
  );
  log("info", `Voice Whisper: ${WHISPER_API_KEY ? "enabled" : "no key"}`);
  log("info", `Profile: ${SABBIR_PROFILE.name}, ${SABBIR_PROFILE.location}, ${SABBIR_PROFILE.study}`);
});
