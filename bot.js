require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const PROXY = process.env.ZEPA_PROXY_URL;

// Per-chat session: { apiKey, projectId }
const sessions = new Map();

// ── helpers ──────────────────────────────────────────────────────────────────

function s(chatId) {
  return sessions.get(chatId);
}

async function api(method, path, apiKey, body) {
  const [pathPart, queryString] = path.split("?");
  const query = {};
  if (queryString) {
    for (const pair of queryString.split("&")) {
      const [k, v] = pair.split("=");
      query[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: method.toUpperCase(),
        path: pathPart,
        query,
        body: body || null,
        apiKey,
      }),
      signal: controller.signal,
    });
    const envelope = await res.json();
    return envelope.body || envelope;
  } finally {
    clearTimeout(timeout);
  }
}

function fmt(obj, depth = 0) {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return String(obj);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj.map((item, i) => `  ${i + 1}. ${fmt(item, depth + 1)}`).join("\n");
  }
  const indent = "  ".repeat(depth);
  return Object.entries(obj)
    .map(([k, v]) => {
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        return `${indent}<b>${k}:</b>\n${fmt(v, depth + 1)}`;
      }
      if (Array.isArray(v)) {
        return `${indent}<b>${k}:</b>\n${fmt(v, depth + 1)}`;
      }
      return `${indent}<b>${k}:</b> <code>${v}</code>`;
    })
    .join("\n");
}

function reply(chatId, text) {
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, 4000));
    text = text.slice(4000);
  }
  return Promise.all(
    chunks.map((c) => bot.sendMessage(chatId, c, { parse_mode: "HTML" }))
  );
}

function needsAuth(chatId) {
  const sess = s(chatId);
  if (!sess) {
    reply(chatId, "⚠️ Not connected. Send /start and paste your API key first.");
    return true;
  }
  return false;
}

function parseArgs(text) {
  if (!text) return [];
  return text.split(/\s+/).filter(Boolean);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  sessions.delete(chatId);
  reply(
    chatId,
    `🔑 <b>ZepaPay API Tester</b>\n\nSend me your project API key to get started.\nFormat: <code>sbk_xxxxxxxx</code>\n\nYou can get your key from the ZepaPay dashboard under <b>Project → API Keys</b>.\nYour key is stored only in memory for this session.`
  );
});

// ── /setkey ──────────────────────────────────────────────────────────────────

bot.onText(/\/setkey/, (msg) => {
  const chatId = msg.chat.id;
  sessions.delete(chatId);
  reply(chatId, "🔑 Send me your new API key (<code>sbk_...</code>).");
});

// ── /logout ──────────────────────────────────────────────────────────────────

bot.onText(/\/logout/, (msg) => {
  const chatId = msg.chat.id;
  sessions.delete(chatId);
  reply(chatId, "🔓 Session cleared. Send /start to reconnect.");
});

// ── key capture (any message starting with sbk_) ─────────────────────────────

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text.startsWith("sbk_")) return;
  if (text.startsWith("/")) return;

  reply(chatId, "⏳ Validating key...");
  try {
    const data = await api("GET", "/developer/me", text);
    if (!data.success) {
      reply(chatId, `❌ <b>${data.error?.code}</b>\n${data.error?.userMessage || data.error?.message || "Invalid key"}`);
      return;
    }
    sessions.set(chatId, { apiKey: text, projectId: data.data.projectId });
    const scopes = (data.data.scopes || []).join(", ");
    reply(
      chatId,
      `✅ <b>Connected!</b>\n\n<b>Project:</b> <code>${data.data.projectId}</code>\n<b>Key ID:</b> <code>${data.data.keyId}</code>\n<b>Scopes:</b> ${scopes}\n\nType /help to see all commands.`
    );
  } catch (e) {
    reply(chatId, `❌ Connection failed: ${e.message}`);
  }
});

// ── /help ────────────────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  const sections = [
    `🔑 <b>ZepaPay API Tester</b>\n\n<i>Test every ZepaPay endpoint right from Telegram.\nCommands marked ⚡ are interactive — the bot will walk you through each field.</i>`,

    `🔐 <b>SESSION</b>\n` +
    `/start · /setkey — Connect with API key\n` +
    `/me — Current key info\n` +
    `/logout — Clear session`,

    `📚 <b>REFERENCE DATA</b>\n` +
    `/currencies — List all currencies\n` +
    `/currency <code>&lt;id&gt;</code> — Currency details\n` +
    `/networks — List all networks\n` +
    `/network <code>&lt;id&gt;</code> — Network details\n` +
    `/countries — Bank-field countries\n` +
    `/bankfields <code>&lt;CC&gt;</code> — Fields for country\n` +
    `/iban <code>&lt;iban&gt;</code> — Validate IBAN`,

    `💰 <b>BALANCES &amp; EXCHANGE</b>\n` +
    `/balances — All project balances\n` +
    `/quote_exchange ⚡ — Get exchange quote\n` +
    `/execute_exchange ⚡ — Execute exchange`,

    `🏦 <b>SETTLEMENTS</b>\n` +
    `/quote_settlement ⚡ — Get quote\n` +
    `/create_settlement ⚡ — Create new\n` +
    `/settlements — List all\n` +
    `/settlement <code>&lt;id&gt;</code> — Get details\n` +
    `/edit_settlement ⚡ — Modify\n` +
    `/cancel_settlement <code>&lt;id&gt;</code> — Cancel`,

    `👥 <b>CUSTOMERS</b>\n` +
    `/create_customer ⚡ — Create new\n` +
    `/customers — List all`,

    `👤 <b>BENEFICIARIES</b>\n` +
    `/create_beneficiary ⚡ — Create new\n` +
    `/beneficiaries — List all\n` +
    `/beneficiary <code>&lt;id&gt;</code> — Get details\n` +
    `/attach_bank ⚡ — Add bank account\n` +
    `/ben_banks <code>&lt;id&gt;</code> — List banks\n` +
    `/ben_bank <code>&lt;benId&gt; &lt;bankId&gt;</code> — Bank details\n` +
    `/attach_crypto ⚡ — Add wallet\n` +
    `/ben_wallets <code>&lt;id&gt;</code> — List wallets\n` +
    `/ben_wallet <code>&lt;benId&gt; &lt;walletId&gt;</code> — Wallet details`,

    `🏛 <b>BANK ACCOUNTS</b>\n` +
    `/bank_accounts — Project bank accounts\n` +
    `/company_accounts — Company deposit accounts`,

    `💸 <b>PAYOUTS</b>\n` +
    `/quote_payout ⚡ — Get quote\n` +
    `/create_payout ⚡ — Create new\n` +
    `/payouts — List all\n` +
    `/payout <code>&lt;id&gt;</code> — Get details\n` +
    `/edit_payout ⚡ — Modify\n` +
    `/cancel_payout <code>&lt;id&gt;</code> — Cancel`,

    `📑 <b>TRANSACTIONS</b>\n` +
    `/transactions — List all\n` +
    `/tx_summary — Volume summary`,

    `🔗 <b>PAYMENT LINKS</b>\n` +
    `/create_pl ⚡ — Create new\n` +
    `/payment_links — List all\n` +
    `/payment_link <code>&lt;id&gt;</code> — Get details\n` +
    `/edit_pl ⚡ — Modify\n` +
    `/cancel_pl <code>&lt;id&gt;</code> — Cancel\n` +
    `/signal_pl <code>&lt;id&gt; &lt;txHash&gt;</code> — Signal deposit\n` +
    `/pl_invoice <code>&lt;id&gt;</code> — Get invoice\n` +
    `/resend_pl_invoice <code>&lt;id&gt;</code> — Resend invoice\n` +
    `/deposits_review — Under review`,

    `📥 <b>DEPOSIT REQUESTS</b>\n` +
    `/create_dr ⚡ — Create new\n` +
    `/deposit_requests — List all\n` +
    `/deposit_request <code>&lt;id&gt;</code> — Get details\n` +
    `/edit_dr ⚡ — Modify\n` +
    `/cancel_dr <code>&lt;id&gt;</code> — Cancel\n` +
    `/signal_dr ⚡ — Signal deposit\n` +
    `/dr_collections <code>&lt;id&gt;</code> — Collections`,

    `📧 <b>EMAILS</b>\n` +
    `/email_types — Available types\n` +
    `/send_email ⚡ — Send email`,

    `🔧 <b>POWER USER</b>\n` +
    `/raw <code>&lt;METHOD&gt; &lt;path&gt; [json]</code> — Raw API call\n\n` +
    `<i>💡 Tip: Most list commands accept</i> <code>limit offset</code>\n` +
    `<i>🚫 /cancel — Abort any interactive flow</i>`,
  ];
  for (const section of sections) {
    await reply(chatId, section);
  }
});

// ── /me ──────────────────────────────────────────────────────────────────────

bot.onText(/\/me$/, async (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", "/developer/me", sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🔑 <b>Key Info</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Reference endpoints ──────────────────────────────────────────────────────

bot.onText(/\/currencies(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const args = parseArgs(match[1]);
  const limit = args[0] || 20;
  const offset = args[1] || 0;
  try {
    const data = await api("GET", `/currencies?limit=${limit}&offset=${offset}`, s(chatId).apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    const list = data.data.currencies || [];
    if (list.length === 0) return reply(chatId, "No currencies found.");
    let text = `💱 <b>Currencies</b> (${data.data.total} total)\n\n`;
    list.forEach((c) => {
      text += `<b>${c.symbol}</b> — ${c.name} (${c.type})\n  ID: <code>${c.id}</code> | decimals: ${c.decimals}\n\n`;
    });
    reply(chatId, text);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/currency\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  try {
    const data = await api("GET", `/currencies/${match[1].trim()}`, s(chatId).apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `💱 <b>Currency</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/networks(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const args = parseArgs(match?.[1]);
  const limit = args[0] || 20;
  const offset = args[1] || 0;
  try {
    const data = await api("GET", `/networks?limit=${limit}&offset=${offset}`, s(chatId).apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    const list = data.data.networks || [];
    if (list.length === 0) return reply(chatId, "No networks found.");
    let text = `🌐 <b>Networks</b> (${data.data.total} total)\n\n`;
    list.forEach((n) => {
      text += `<b>${n.code || n.name}</b> — ${n.name}\n  ID: <code>${n.id}</code>\n\n`;
    });
    reply(chatId, text);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/network\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  try {
    const data = await api("GET", `/networks/${match[1].trim()}`, s(chatId).apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🌐 <b>Network</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/countries/, async (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  try {
    const data = await api("GET", "/bank-fields/countries", s(chatId).apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🏦 <b>Bank-Field Countries</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/bankfields\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  try {
    const data = await api("GET", `/bank-fields/countries/${match[1].trim().toUpperCase()}`, s(chatId).apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🏦 <b>Bank Fields</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/iban\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  try {
    const data = await api("POST", "/bank-fields/iban", s(chatId).apiKey, { iban: match[1].trim() });
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🏦 <b>IBAN Validation</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Balances ─────────────────────────────────────────────────────────────────

bot.onText(/\/balances/, async (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/balances`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `💰 <b>Balances</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Interactive conversation state ───────────────────────────────────────────

const conversations = new Map();

function startConvo(chatId, flow, steps) {
  conversations.set(chatId, { flow, steps, current: 0, data: {} });
  const step = steps[0];
  reply(chatId, step.prompt);
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (text.startsWith("/") || text.startsWith("sbk_")) return;

  const convo = conversations.get(chatId);
  if (!convo) return;

  const step = convo.steps[convo.current];
  if (step.validate) {
    const err = step.validate(text);
    if (err) return reply(chatId, `⚠️ ${err}`);
  }

  convo.data[step.key] = step.transform ? step.transform(text) : text;
  convo.current++;

  if (convo.current < convo.steps.length) {
    const next = convo.steps[convo.current];
    const prompt = typeof next.prompt === "function" ? next.prompt(convo.data) : next.prompt;
    return reply(chatId, prompt);
  }

  conversations.delete(chatId);
  const sess = s(chatId);
  if (!sess) return reply(chatId, "⚠️ Session expired. /start again.");

  try {
    reply(chatId, "⏳ Sending request...");
    const result = await convo.steps[convo.steps.length - 1].execute(sess, convo.data);
    if (!result.success) {
      return reply(chatId, `❌ <b>${result.error?.code}</b>\n${result.error?.userMessage || result.error?.message}`);
    }
    reply(chatId, `✅ <b>Success</b>\n\n${fmt(result.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Exchange ─────────────────────────────────────────────────────────────────

bot.onText(/\/quote_exchange/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "quote_exchange", [
    { key: "fromCurrencyId", prompt: "Enter <b>fromCurrencyId</b> (UUID):\n\n<i>Use /currencies to find IDs</i>" },
    { key: "toCurrencyId", prompt: "Enter <b>toCurrencyId</b> (UUID):" },
    {
      key: "amount",
      prompt: "Enter <b>amount</b> (human-readable, e.g. 100.50):",
      execute: (sess, d) =>
        api("POST", `/projects/${sess.projectId}/exchange/quote`, sess.apiKey, {
          projectId: sess.projectId,
          fromCurrencyId: d.fromCurrencyId,
          toCurrencyId: d.toCurrencyId,
          amount: d.amount,
        }),
    },
  ]);
});

bot.onText(/\/execute_exchange/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "execute_exchange", [
    { key: "fromCurrencyId", prompt: "⚠️ <b>This moves real funds!</b>\n\nEnter <b>fromCurrencyId</b> (UUID):" },
    { key: "toCurrencyId", prompt: "Enter <b>toCurrencyId</b> (UUID):" },
    { key: "amount", prompt: "Enter <b>amount</b> (human-readable):" },
    {
      key: "idempotencyKey",
      prompt: "Enter <b>idempotencyKey</b> (or 'auto' to skip):",
      execute: (sess, d) =>
        api("POST", `/projects/${sess.projectId}/exchange`, sess.apiKey, {
          projectId: sess.projectId,
          fromCurrencyId: d.fromCurrencyId,
          toCurrencyId: d.toCurrencyId,
          amount: d.amount,
          ...(d.idempotencyKey !== "auto" && { idempotencyKey: d.idempotencyKey }),
        }),
    },
  ]);
});

// ── Settlements ──────────────────────────────────────────────────────────────

bot.onText(/\/quote_settlement/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "quote_settlement", [
    { key: "bankAccountId", prompt: "Enter <b>bankAccountId</b> (UUID):\n\n<i>Use /bank_accounts to find IDs</i>" },
    {
      key: "amount",
      prompt: "Enter <b>amount</b> (net desired, human-readable):\n<i>Or prefix with 'gross:' for grossAmount</i>",
      execute: (sess, d) => {
        const body = { bankAccountId: d.bankAccountId };
        if (d.amount.startsWith("gross:")) body.grossAmount = d.amount.slice(6);
        else body.amount = d.amount;
        return api("POST", `/projects/${sess.projectId}/settlements/quote`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/create_settlement/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "create_settlement", [
    { key: "bankAccountId", prompt: "⚠️ <b>This moves real funds!</b>\n\nEnter <b>bankAccountId</b> (UUID):" },
    { key: "amount", prompt: "Enter <b>amount</b> (net, human-readable):\n<i>Or prefix with 'gross:' for grossAmount</i>" },
    { key: "remarks", prompt: "Enter <b>remarks</b> (or 'skip'):" },
    {
      key: "idempotencyKey",
      prompt: "Enter <b>idempotencyKey</b> (or 'auto'):",
      execute: (sess, d) => {
        const body = { projectId: sess.projectId, bankAccountId: d.bankAccountId };
        if (d.amount.startsWith("gross:")) body.grossAmount = d.amount.slice(6);
        else body.amount = d.amount;
        if (d.remarks !== "skip") body.remarks = d.remarks;
        if (d.idempotencyKey !== "auto") body.idempotencyKey = d.idempotencyKey;
        return api("POST", `/projects/${sess.projectId}/settlements`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/settlements(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  const args = parseArgs(match?.[1]);
  const limit = args[0] || 20;
  const offset = args[1] || 0;
  try {
    const data = await api("GET", `/projects/${sess.projectId}/settlements?limit=${limit}&offset=${offset}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    const list = data.data.settlements || [];
    if (list.length === 0) return reply(chatId, "No settlements found.");
    let text = `📋 <b>Settlements</b> (${data.data.total} total)\n\n`;
    list.forEach((s) => {
      text += `<b>${s.id}</b>\n  Status: ${s.status} | Amount: ${s.amountFormatted || s.amount}\n\n`;
    });
    reply(chatId, text);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/settlement\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/settlements/${match[1].trim()}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `📋 <b>Settlement</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/edit_settlement/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "edit_settlement", [
    { key: "settlementId", prompt: "Enter <b>settlement ID</b> to edit:" },
    {
      key: "body",
      prompt: "Send the fields to update as JSON:\n<code>{\"remarks\": \"new remark\"}</code>",
      validate: (t) => (parseJson(t) ? null : "Invalid JSON"),
      transform: (t) => parseJson(t),
      execute: (sess, d) =>
        api("PUT", `/projects/${sess.projectId}/settlements/${d.settlementId}`, sess.apiKey, d.body),
    },
  ]);
});

bot.onText(/\/cancel_settlement\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("DELETE", `/projects/${sess.projectId}/settlements/${match[1].trim()}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `✅ <b>Settlement cancelled</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Customers ────────────────────────────────────────────────────────────────

bot.onText(/\/create_customer/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "create_customer", [
    { key: "name", prompt: "Enter customer <b>name</b>:" },
    { key: "email", prompt: "Enter customer <b>email</b>:" },
    {
      key: "description",
      prompt: "Enter <b>description</b> (or 'skip'):",
      execute: (sess, d) => {
        const body = { projectId: sess.projectId, name: d.name, email: d.email };
        if (d.description !== "skip") body.description = d.description;
        return api("POST", `/projects/${sess.projectId}/customers`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/customers(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  const args = parseArgs(match?.[1]);
  const limit = args[0] || 20;
  const offset = args[1] || 0;
  try {
    const data = await api("GET", `/projects/${sess.projectId}/customers?limit=${limit}&offset=${offset}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    const list = data.data.customers || [];
    if (list.length === 0) return reply(chatId, "No customers found.");
    let text = `👥 <b>Customers</b> (${data.data.total} total)\n\n`;
    list.forEach((c) => {
      text += `<b>${c.name}</b> (${c.email})\n  ID: <code>${c.id}</code>\n\n`;
    });
    reply(chatId, text);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Beneficiaries ────────────────────────────────────────────────────────────

bot.onText(/\/create_beneficiary/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "create_beneficiary", [
    { key: "type", prompt: "Enter <b>type</b>: <code>b2c</code> (individual) or <code>b2b</code> (business):" },
    { key: "nickname", prompt: "Enter <b>nickname</b>:" },
    {
      key: "extra",
      prompt: (d) =>
        d.type === "b2b"
          ? "Enter <b>businessName</b>:"
          : "Enter <b>firstName lastName</b> (space separated):",
      execute: (sess, d) => {
        const body = { projectId: sess.projectId, type: d.type, nickname: d.nickname };
        if (d.type === "b2b") {
          body.businessName = d.extra;
        } else {
          const [first, ...rest] = d.extra.split(" ");
          body.firstName = first;
          body.lastName = rest.join(" ") || first;
        }
        return api("POST", `/projects/${sess.projectId}/beneficiaries`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/beneficiaries(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  const args = parseArgs(match?.[1]);
  const limit = args[0] || 20;
  const offset = args[1] || 0;
  try {
    const data = await api("GET", `/projects/${sess.projectId}/beneficiaries?limit=${limit}&offset=${offset}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    const list = data.data.beneficiaries || [];
    if (list.length === 0) return reply(chatId, "No beneficiaries found.");
    let text = `👤 <b>Beneficiaries</b> (${data.data.total} total)\n\n`;
    list.forEach((b) => {
      text += `<b>${b.nickname || b.businessName || b.firstName}</b> (${b.type})\n  ID: <code>${b.id}</code> | Status: ${b.status}\n\n`;
    });
    reply(chatId, text);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/beneficiary\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/beneficiaries/${match[1].trim()}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `👤 <b>Beneficiary</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/attach_bank/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "attach_bank", [
    { key: "beneficiaryId", prompt: "Enter <b>beneficiaryId</b> (UUID):" },
    { key: "alias", prompt: "Enter <b>alias</b> (label for this account):" },
    { key: "currencyCode", prompt: "Enter <b>currencyCode</b> (e.g. inr_fiat):\n<i>Use /currencies to find codes</i>" },
    { key: "country", prompt: "Enter <b>country</b> (ISO 3166-1 alpha-2, e.g. IN):" },
    { key: "accountNumber", prompt: "Enter <b>accountNumber</b> (or IBAN):" },
    {
      key: "railFields",
      prompt: "Enter <b>railFields</b> as JSON (e.g. <code>{\"ifsc\":\"HDFC0001234\"}</code>):\n<i>Or 'skip' if none needed</i>",
      transform: (t) => (t === "skip" ? null : parseJson(t)),
      execute: (sess, d) => {
        const body = {
          alias: d.alias,
          currencyCode: d.currencyCode,
          country: d.country,
          accountNumber: d.accountNumber,
        };
        if (d.railFields) body.railFields = d.railFields;
        return api("POST", `/projects/${sess.projectId}/beneficiaries/${d.beneficiaryId}/bank-accounts`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/ben_banks\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/beneficiaries/${match[1].trim()}/bank-accounts`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🏦 <b>Bank Accounts</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/ben_bank\s+(\S+)\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/beneficiaries/${match[1]}/bank-accounts/${match[2]}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🏦 <b>Bank Account</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/attach_crypto/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "attach_crypto", [
    { key: "beneficiaryId", prompt: "Enter <b>beneficiaryId</b> (UUID):" },
    { key: "networkCode", prompt: "Enter <b>networkCode</b> (e.g. ETH, BASE, TRX):\n<i>Use /networks to find codes</i>" },
    { key: "address", prompt: "Enter the <b>wallet address</b>:" },
    {
      key: "alias",
      prompt: "Enter <b>alias</b> (or 'skip'):",
      execute: (sess, d) => {
        const body = { networkCode: d.networkCode, address: d.address };
        if (d.alias !== "skip") body.alias = d.alias;
        return api("POST", `/projects/${sess.projectId}/beneficiaries/${d.beneficiaryId}/wallets`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/ben_wallets\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/beneficiaries/${match[1].trim()}/wallets`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🔗 <b>Crypto Addresses</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/ben_wallet\s+(\S+)\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/beneficiaries/${match[1]}/wallets/${match[2]}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🔗 <b>Crypto Address</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Bank Accounts ────────────────────────────────────────────────────────────

bot.onText(/\/bank_accounts/, async (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/bank-accounts`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🏦 <b>Project Bank Accounts</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/company_accounts/, async (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/bank-accounts/company`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🏦 <b>Company Accounts</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Payouts ──────────────────────────────────────────────────────────────────

bot.onText(/\/quote_payout/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "quote_payout", [
    { key: "bankAccountId", prompt: "Enter <b>bankAccountId</b> (UUID):" },
    {
      key: "amount",
      prompt: "Enter <b>amount</b> (net desired):\n<i>Or prefix with 'gross:' for grossAmount</i>",
      execute: (sess, d) => {
        const body = { bankAccountId: d.bankAccountId };
        if (d.amount.startsWith("gross:")) body.grossAmount = d.amount.slice(6);
        else body.amount = d.amount;
        return api("POST", `/projects/${sess.projectId}/payouts/quote`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/create_payout/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "create_payout", [
    { key: "beneficiaryId", prompt: "⚠️ <b>This moves real funds!</b>\n\nEnter <b>beneficiaryId</b> (UUID):" },
    { key: "bankAccountId", prompt: "Enter <b>bankAccountId</b> (UUID):" },
    { key: "amount", prompt: "Enter <b>amount</b> (net, human-readable):" },
    { key: "idempotencyKey", prompt: "Enter <b>idempotencyKey</b> (required, unique string):" },
    {
      key: "remarks",
      prompt: "Enter <b>remarks</b> (or 'skip'):",
      execute: (sess, d) => {
        const body = {
          projectId: sess.projectId,
          beneficiaryId: d.beneficiaryId,
          bankAccountId: d.bankAccountId,
          amount: d.amount,
          idempotencyKey: d.idempotencyKey,
        };
        if (d.remarks !== "skip") body.remarks = d.remarks;
        return api("POST", `/projects/${sess.projectId}/payouts`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/payouts(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  const args = parseArgs(match?.[1]);
  const limit = args[0] || 20;
  const offset = args[1] || 0;
  try {
    const data = await api("GET", `/projects/${sess.projectId}/payouts?limit=${limit}&offset=${offset}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    const list = data.data.payouts || [];
    if (list.length === 0) return reply(chatId, "No payouts found.");
    let text = `💸 <b>Payouts</b> (${data.data.total} total)\n\n`;
    list.forEach((p) => {
      text += `<b>${p.id}</b>\n  Status: ${p.status} | Amount: ${p.amountFormatted || p.amount}\n\n`;
    });
    reply(chatId, text);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/payout\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/payouts/${match[1].trim()}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `💸 <b>Payout</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/edit_payout/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "edit_payout", [
    { key: "payoutId", prompt: "Enter <b>payout ID</b> to edit:" },
    {
      key: "body",
      prompt: "Send the fields to update as JSON:\n<code>{\"remarks\": \"updated\"}</code>",
      validate: (t) => (parseJson(t) ? null : "Invalid JSON"),
      transform: (t) => parseJson(t),
      execute: (sess, d) =>
        api("PUT", `/projects/${sess.projectId}/payouts/${d.payoutId}`, sess.apiKey, d.body),
    },
  ]);
});

bot.onText(/\/cancel_payout\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("DELETE", `/projects/${sess.projectId}/payouts/${match[1].trim()}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `✅ <b>Payout cancelled</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Transactions ─────────────────────────────────────────────────────────────

bot.onText(/\/transactions(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  const args = parseArgs(match?.[1]);
  const limit = args[0] || 20;
  const offset = args[1] || 0;
  try {
    const data = await api("GET", `/projects/${sess.projectId}/transactions?limit=${limit}&offset=${offset}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    const list = data.data.transactions || [];
    if (list.length === 0) return reply(chatId, "No transactions found.");
    let text = `📑 <b>Transactions</b> (${data.data.total} total)\n\n`;
    list.forEach((t) => {
      text += `<b>${t.id}</b>\n  Type: ${t.type || "—"} | Amount: ${t.amountFormatted || t.amount || "—"}\n\n`;
    });
    reply(chatId, text);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/tx_summary/, async (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/transactions/summary`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `📊 <b>Transaction Summary</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Payment Links ────────────────────────────────────────────────────────────

bot.onText(/\/create_pl/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "create_pl", [
    { key: "customerId", prompt: "Enter <b>customerId</b> (UUID, or 'skip'):" },
    { key: "amount", prompt: "Enter <b>amount</b> (or 'skip' for self-provision):" },
    { key: "currencyId", prompt: "Enter <b>currencyId</b> (UUID, or 'skip' for USD):" },
    {
      key: "documentType",
      prompt: "Enter <b>documentType</b>: <code>invoice</code> or <code>deposit_slip</code> (or 'skip' for default):",
      execute: (sess, d) => {
        const body = {};
        if (d.customerId !== "skip") body.customerId = d.customerId;
        if (d.amount !== "skip") body.amount = d.amount;
        if (d.currencyId !== "skip") body.currencyId = d.currencyId;
        if (d.documentType !== "skip") body.documentType = d.documentType;
        return api("POST", `/projects/${sess.projectId}/payment-links`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/payment_links(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  const args = parseArgs(match?.[1]);
  const limit = args[0] || 20;
  const offset = args[1] || 0;
  try {
    const data = await api("GET", `/projects/${sess.projectId}/payment-links?limit=${limit}&offset=${offset}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    const list = data.data.paymentLinks || data.data["payment-links"] || [];
    if (list.length === 0) return reply(chatId, "No payment links found.");
    let text = `🔗 <b>Payment Links</b> (${data.data.total} total)\n\n`;
    list.forEach((p) => {
      text += `<b>${p.id}</b>\n  Status: ${p.status || "—"} | Amount: ${p.amount || "—"}\n  URL: ${p.url || "—"}\n\n`;
    });
    reply(chatId, text);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/payment_link\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/payment-links/${match[1].trim()}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🔗 <b>Payment Link</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/edit_pl/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "edit_pl", [
    { key: "linkId", prompt: "Enter <b>payment link ID</b> to edit:" },
    {
      key: "body",
      prompt: "Send the fields to update as JSON:\n<code>{\"amount\": \"200\"}</code>",
      validate: (t) => (parseJson(t) ? null : "Invalid JSON"),
      transform: (t) => parseJson(t),
      execute: (sess, d) =>
        api("PUT", `/projects/${sess.projectId}/payment-links/${d.linkId}`, sess.apiKey, d.body),
    },
  ]);
});

bot.onText(/\/cancel_pl\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("DELETE", `/projects/${sess.projectId}/payment-links/${match[1].trim()}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `✅ <b>Payment link cancelled</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/signal_pl\s+(\S+)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const body = { declaredTransactionHash: match[2].trim() };
    const data = await api("POST", `/projects/${sess.projectId}/payment-links/${match[1]}/expected`, sess.apiKey, body);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `✅ <b>Signal sent</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/pl_invoice\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/payment-links/${match[1].trim()}/invoice`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `📄 <b>Invoice</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/resend_pl_invoice\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("POST", `/projects/${sess.projectId}/payment-links/${match[1].trim()}/invoice/resend`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `✅ <b>Invoice resent</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/deposits_review/, async (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/payment-links/deposits-under-review`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `🔍 <b>Deposits Under Review</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Deposit Requests ─────────────────────────────────────────────────────────

bot.onText(/\/create_dr/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "create_dr", [
    { key: "beneficiaryId", prompt: "Enter <b>beneficiaryId</b> (UUID):" },
    { key: "bankAccountId", prompt: "Enter <b>bankAccountId</b> (UUID):" },
    { key: "currencyId", prompt: "Enter <b>currencyId</b> (UUID):" },
    { key: "amount", prompt: "Enter <b>amount</b> (or 'skip' if using lineItems):" },
    {
      key: "documentType",
      prompt: "Enter <b>documentType</b>: <code>invoice</code> or <code>deposit_slip</code> (or 'skip'):",
      execute: (sess, d) => {
        const body = {
          beneficiaryId: d.beneficiaryId,
          bankAccountId: d.bankAccountId,
          currencyId: d.currencyId,
        };
        if (d.amount !== "skip") body.amount = d.amount;
        if (d.documentType !== "skip") body.documentType = d.documentType;
        return api("POST", `/projects/${sess.projectId}/deposit-requests`, sess.apiKey, body);
      },
    },
  ]);
});

bot.onText(/\/deposit_requests(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  const args = parseArgs(match?.[1]);
  const limit = args[0] || 20;
  const offset = args[1] || 0;
  try {
    const data = await api("GET", `/projects/${sess.projectId}/deposit-requests?limit=${limit}&offset=${offset}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    const list = data.data.depositRequests || data.data["deposit-requests"] || [];
    if (list.length === 0) return reply(chatId, "No deposit requests found.");
    let text = `📥 <b>Deposit Requests</b> (${data.data.total} total)\n\n`;
    list.forEach((d) => {
      text += `<b>${d.id}</b>\n  Stage: ${d.stage || "—"} | Amount: ${d.expectedDepositAmount || "—"}\n\n`;
    });
    reply(chatId, text);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/deposit_request\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/deposit-requests/${match[1].trim()}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `📥 <b>Deposit Request</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/edit_dr/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "edit_dr", [
    { key: "drId", prompt: "Enter <b>deposit request ID</b> to edit:" },
    {
      key: "body",
      prompt: "Send the fields to update as JSON:",
      validate: (t) => (parseJson(t) ? null : "Invalid JSON"),
      transform: (t) => parseJson(t),
      execute: (sess, d) =>
        api("PUT", `/projects/${sess.projectId}/deposit-requests/${d.drId}`, sess.apiKey, d.body),
    },
  ]);
});

bot.onText(/\/cancel_dr\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("DELETE", `/projects/${sess.projectId}/deposit-requests/${match[1].trim()}`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `✅ <b>Deposit request cancelled</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/signal_dr\s+(.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const drId = match[1].trim();
  startConvo(chatId, "signal_dr", [
    {
      key: "body",
      prompt: "Send signal body as JSON (e.g. <code>{\"declaredHandles\": [\"handle\"]}</code>)\nor 'empty' for no body:",
      transform: (t) => (t === "empty" ? {} : parseJson(t) || {}),
      execute: (sess, d) =>
        api("POST", `/projects/${sess.projectId}/deposit-requests/${drId}/expected`, sess.apiKey, d.body),
    },
  ]);
});

bot.onText(/\/dr_collections\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/deposit-requests/${match[1].trim()}/collections`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `📥 <b>Collections</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Emails ───────────────────────────────────────────────────────────────────

bot.onText(/\/email_types/, async (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  try {
    const data = await api("GET", `/projects/${sess.projectId}/emails/types`, sess.apiKey);
    if (!data.success) return reply(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
    reply(chatId, `📧 <b>Email Types</b>\n\n${fmt(data.data)}`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

bot.onText(/\/send_email/, (msg) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  startConvo(chatId, "send_email", [
    { key: "emailType", prompt: "Enter <b>emailType</b> slug:\n<i>Use /email_types to see options</i>" },
    { key: "resourceId", prompt: "Enter <b>resourceId</b> (UUID of the record):" },
    {
      key: "to",
      prompt: "Enter <b>to</b> email addresses (comma separated, or 'skip'):",
      execute: (sess, d) => {
        const body = { emailType: d.emailType, resourceId: d.resourceId };
        if (d.to !== "skip") body.to = d.to.split(",").map((e) => e.trim());
        return api("POST", `/projects/${sess.projectId}/emails/dispatch`, sess.apiKey, body);
      },
    },
  ]);
});

// ── Raw API call (power-user) ────────────────────────────────────────────────

bot.onText(/\/raw\s+(\S+)\s+(\S+)(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (needsAuth(chatId)) return;
  const sess = s(chatId);
  const method = match[1].toUpperCase();
  let path = match[2];
  const bodyText = match[3];

  path = path.replace("{projectId}", sess.projectId).replace("{id}", sess.projectId);
  if (!path.startsWith("/")) path = "/" + path;

  try {
    const body = bodyText ? parseJson(bodyText) : undefined;
    if (bodyText && !body) return reply(chatId, "⚠️ Invalid JSON body.");
    const data = await api(method, path, sess.apiKey, body);
    reply(chatId, `🔧 <b>Raw Response</b>\n\n<code>${JSON.stringify(data, null, 2).slice(0, 3800)}</code>`);
  } catch (e) {
    reply(chatId, `❌ ${e.message}`);
  }
});

// ── Cancel conversation ──────────────────────────────────────────────────────

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (conversations.has(chatId)) {
    conversations.delete(chatId);
    reply(chatId, "🚫 Cancelled. Ready for a new command.");
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────

console.log("🤖 ZepaPay Telegram Bot is running...");
console.log("Open your bot in Telegram and send /start");
