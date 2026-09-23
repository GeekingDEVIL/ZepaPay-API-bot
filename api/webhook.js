const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PROXY = process.env.ZEPA_PROXY_URL;
const TG = `https://api.telegram.org/bot${TOKEN}`;

// Survives across warm invocations; lost on cold start — user re-sends key
const sessions = new Map();
const conversations = new Map();

// ── Telegram helpers ─────────────────────────────────────────────────────────

async function send(chatId, text) {
  const chunks = [];
  while (text.length > 0) {
    chunks.push(text.slice(0, 4000));
    text = text.slice(4000);
  }
  for (const chunk of chunks) {
    await fetch(`${TG}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "HTML" }),
    });
  }
}

// ── ZepaPay proxy ────────────────────────────────────────────────────────────

async function api(method, path, apiKey, body) {
  const [pathPart, qs] = path.split("?");
  const query = {};
  if (qs) {
    for (const pair of qs.split("&")) {
      const [k, v] = pair.split("=");
      query[decodeURIComponent(k)] = decodeURIComponent(v);
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(PROXY, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: method.toUpperCase(), path: pathPart, query, body: body || null, apiKey }),
      signal: controller.signal,
    });
    const envelope = await res.json();
    return envelope.body || envelope;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Formatters ───────────────────────────────────────────────────────────────

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
      if (typeof v === "object" && v !== null) return `${indent}<b>${k}:</b>\n${fmt(v, depth + 1)}`;
      return `${indent}<b>${k}:</b> <code>${v}</code>`;
    })
    .join("\n");
}

function parseJson(t) {
  try { return JSON.parse(t); } catch { return null; }
}

function sess(chatId) { return sessions.get(chatId); }

async function needsAuth(chatId) {
  if (!sess(chatId)) {
    await send(chatId, "⚠️ Not connected. Send /start and paste your API key first.");
    return true;
  }
  return false;
}

// ── Reusable pickers ─────────────────────────────────────────────────────────

const pickers = {
  customers: async (s) => {
    const data = await api("GET", `/projects/${s.projectId}/customers?limit=20`, s.apiKey);
    if (!data.success || !data.data.customers?.length) return null;
    return data.data.customers.map(c => ({ label: `${c.name} — ${c.email}`, value: c.id }));
  },
  currencies: async (s) => {
    const data = await api("GET", `/currencies?limit=50`, s.apiKey);
    if (!data.success || !data.data.currencies?.length) return null;
    const seen = new Set();
    const deduped = [];
    for (const c of data.data.currencies) {
      const key = `${c.symbol}-${c.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tag = c.type === "crypto" ? "🪙" : "💵";
      deduped.push({ label: `${tag} ${c.symbol} — ${c.name}`, value: c.id, _type: c.type });
    }
    return deduped;
  },
  networks: async (s) => {
    const data = await api("GET", `/networks?limit=50`, s.apiKey);
    if (!data.success || !data.data.networks?.length) return null;
    return data.data.networks.map(n => ({ label: `${n.code || n.name} — ${n.name}`, value: n.id }));
  },
  beneficiaries: async (s) => {
    const data = await api("GET", `/projects/${s.projectId}/beneficiaries?limit=20`, s.apiKey);
    if (!data.success || !data.data.beneficiaries?.length) return null;
    return data.data.beneficiaries.map(b => ({
      label: `${b.nickname || b.businessName || b.firstName || "—"} (${b.type})`,
      value: b.id,
    }));
  },
  bankAccounts: async (s) => {
    const data = await api("GET", `/projects/${s.projectId}/bank-accounts`, s.apiKey);
    if (!data.success) return null;
    const list = data.data.bankAccounts || data.data["bank-accounts"] || (Array.isArray(data.data) ? data.data : []);
    if (!list.length) return null;
    return list.map(b => ({
      label: `${b.alias || b.bankName || b.id} — ${b.currencyCode || ""}`,
      value: b.id,
    }));
  },
  benBanks: async (s, data) => {
    const benId = data.beneficiaryId;
    if (!benId || benId === "skip") return null;
    const res = await api("GET", `/projects/${s.projectId}/beneficiaries/${benId}/bank-accounts`, s.apiKey);
    if (!res.success) return null;
    const list = res.data.bankAccounts || res.data["bank-accounts"] || (Array.isArray(res.data) ? res.data : []);
    if (!list.length) return null;
    return list.map(b => ({
      label: `${b.alias || b.bankName || b.id} — ${b.currencyCode || ""}`,
      value: b.id,
    }));
  },
  settlements: async (s) => {
    const data = await api("GET", `/projects/${s.projectId}/settlements?limit=20`, s.apiKey);
    if (!data.success || !data.data.settlements?.length) return null;
    return data.data.settlements.map(x => ({
      label: `${x.status} — ${x.amountFormatted || x.amount || x.id}`,
      value: x.id,
    }));
  },
  payouts: async (s) => {
    const data = await api("GET", `/projects/${s.projectId}/payouts?limit=20`, s.apiKey);
    if (!data.success || !data.data.payouts?.length) return null;
    return data.data.payouts.map(p => ({
      label: `${p.status} — ${p.amountFormatted || p.amount || p.id}`,
      value: p.id,
    }));
  },
  paymentLinks: async (s) => {
    const data = await api("GET", `/projects/${s.projectId}/payment-links?limit=20`, s.apiKey);
    if (!data.success) return null;
    const list = data.data.paymentLinks || data.data["payment-links"] || [];
    if (!list.length) return null;
    return list.map(p => ({
      label: `${p.status || "—"} — ${p.amount || "no amount"} ${p.id.slice(0, 8)}`,
      value: p.id,
    }));
  },
  depositRequests: async (s) => {
    const data = await api("GET", `/projects/${s.projectId}/deposit-requests?limit=20`, s.apiKey);
    if (!data.success) return null;
    const list = data.data.depositRequests || data.data["deposit-requests"] || [];
    if (!list.length) return null;
    return list.map(d => ({
      label: `${d.stage || "—"} — ${d.expectedDepositAmount || d.id.slice(0, 8)}`,
      value: d.id,
    }));
  },
  emailTypes: async (s) => {
    const data = await api("GET", `/projects/${s.projectId}/emails/types`, s.apiKey);
    if (!data.success) return null;
    const list = data.data.emailTypes || data.data["email-types"] || (Array.isArray(data.data) ? data.data : []);
    if (!list.length) return null;
    return list.map(e => ({
      label: e.name || e.slug || e,
      value: e.slug || e.id || e,
    }));
  },
  countries: async (s) => {
    const data = await api("GET", "/bank-fields/countries", s.apiKey);
    if (!data.success) return null;
    const list = data.data.countries || (Array.isArray(data.data) ? data.data : []);
    if (!list.length) return null;
    return list.map(c => ({
      label: typeof c === "string" ? c : `${c.code} — ${c.name || c.code}`,
      value: typeof c === "string" ? c : c.code,
    }));
  },
  docType: async () => [
    { label: "Invoice", value: "invoice" },
    { label: "Deposit Slip", value: "deposit_slip" },
    { label: "Skip (default)", value: "skip" },
  ],
  yesNo: async () => [
    { label: "No (default)", value: "skip" },
    { label: "Yes", value: "true" },
  ],
  benType: async () => [
    { label: "Individual (B2C)", value: "b2c" },
    { label: "Business (B2B)", value: "b2b" },
  ],
};

// ── Conversation flow engine ─────────────────────────────────────────────────

async function showStepPrompt(chatId, step, data) {
  const s = sess(chatId);
  if (step.picker && s) {
    try {
      await send(chatId, "⏳ Loading options...");
      const choices = await step.picker(s, data);
      if (choices && choices.length > 0) {
        const convo = conversations.get(chatId);
        if (convo) convo._choices = choices;
        const list = choices.map((c, i) => `  <b>${i + 1}.</b> ${c.label}`).join("\n");
        const header = typeof step.prompt === "function" ? step.prompt(data) : step.prompt;
        await send(chatId, `${header}\n\n${list}\n\n<i>Reply with a number, or type a value directly.</i>`);
        return;
      }
    } catch (e) {
      console.error("Picker error:", e.message);
    }
  }
  const prompt = typeof step.prompt === "function" ? step.prompt(data) : step.prompt;
  await send(chatId, prompt);
}

async function startConvo(chatId, steps) {
  conversations.set(chatId, { steps, current: 0, data: {}, _choices: null });
  await showStepPrompt(chatId, steps[0], {});
}

async function handleConvo(chatId, text) {
  const convo = conversations.get(chatId);
  if (!convo) return false;

  const step = convo.steps[convo.current];

  // Resolve picker selection by number
  let value = text;
  let pickedChoice = null;
  if (convo._choices && /^\d+$/.test(text.trim())) {
    const idx = parseInt(text.trim()) - 1;
    if (idx >= 0 && idx < convo._choices.length) {
      pickedChoice = convo._choices[idx];
      value = pickedChoice.value;
      // Store extra metadata from choice (e.g. currency type)
      if (pickedChoice._type) convo.data._isCrypto = pickedChoice._type === "crypto";
    }
  }
  convo._choices = null;

  if (step.validate) {
    const err = step.validate(value);
    if (err) { await send(chatId, `⚠️ ${err}`); return true; }
  }
  convo.data[step.key] = step.transform ? step.transform(value) : value;
  convo.current++;

  // Skip steps whose condition returns false
  while (convo.current < convo.steps.length) {
    const next = convo.steps[convo.current];
    if (next.skipIf && next.skipIf(convo.data)) {
      convo.current++;
      continue;
    }
    await showStepPrompt(chatId, next, convo.data);
    return true;
  }

  conversations.delete(chatId);
  const s = sess(chatId);
  if (!s) { await send(chatId, "⚠️ Session expired. /start again."); return true; }

  try {
    await send(chatId, "⏳ Sending request...");
    const lastStep = convo.steps[convo.steps.length - 1];
    const cleanData = Object.fromEntries(Object.entries(convo.data).filter(([k]) => !k.startsWith("_")));
    const result = await lastStep.execute(s, convo.data);
    if (!result.success) {
      let errMsg = `❌ <b>${result.error?.code || "ERROR"}</b>\n${result.error?.userMessage || result.error?.message || "Unknown error"}`;
      const extra = { ...result.error };
      delete extra.code; delete extra.userMessage; delete extra.message;
      if (Object.keys(extra).length > 0) errMsg += `\n\n<b>Details:</b>\n<code>${JSON.stringify(extra, null, 2).slice(0, 2000)}</code>`;
      errMsg += `\n\n<b>Sent:</b>\n<code>${JSON.stringify(cleanData, null, 2).slice(0, 1500)}</code>`;
      await send(chatId, errMsg);
    } else {
      await send(chatId, `✅ <b>Success</b>\n\n${fmt(result.data)}`);
    }
  } catch (e) {
    await send(chatId, `❌ ${e.message}`);
  }
  return true;
}

// ── Command router ───────────────────────────────────────────────────────────

async function handle(chatId, text) {
  if (!text) return;

  // Key capture
  if (text.startsWith("sbk_")) {
    await send(chatId, "⏳ Validating key...");
    try {
      const data = await api("GET", "/developer/me", text);
      if (!data.success) {
        return await send(chatId, `❌ <b>${data.error?.code}</b>\n${data.error?.userMessage || data.error?.message || "Invalid key"}`);
      }
      sessions.set(chatId, { apiKey: text, projectId: data.data.projectId });
      const scopes = (data.data.scopes || []).join(", ");
      return await send(chatId, `✅ <b>Connected!</b>\n\n<b>Project:</b> <code>${data.data.projectId}</code>\n<b>Key ID:</b> <code>${data.data.keyId}</code>\n<b>Scopes:</b> ${scopes}\n\nType /help to see all commands.`);
    } catch (e) {
      return await send(chatId, `❌ Connection failed: ${e.message}`);
    }
  }

  // Cancel conversation
  if (text === "/cancel") {
    conversations.delete(chatId);
    return await send(chatId, "🚫 Cancelled.");
  }

  // Active conversation
  if (!text.startsWith("/")) {
    const handled = await handleConvo(chatId, text);
    if (handled) return;
    return;
  }

  const [cmd, ...args] = text.split(/\s+/);
  const arg = args.join(" ");
  const s = sess(chatId);

  switch (cmd) {
    // ── Session ──────────────────────────────────────────────────────────────
    case "/start":
    case "/setkey":
      sessions.delete(chatId);
      conversations.delete(chatId);
      return send(chatId, `🔑 <b>ZepaPay API Tester</b>\n\nSend me your project API key to get started.\nFormat: <code>sbk_xxxxxxxx</code>\n\nYou can get your key from the ZepaPay dashboard under <b>Project → API Keys</b>.\nYour key is stored only in memory for this session.`);

    case "/logout":
      sessions.delete(chatId);
      conversations.delete(chatId);
      return send(chatId, "🔓 Session cleared. Send /start to reconnect.");

    case "/help": {
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
        await send(chatId, section);
      }
      return;
    }

    case "/me":
      if (await needsAuth(chatId)) return;
      try {
        const data = await api("GET", "/developer/me", s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🔑 <b>Key Info</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Reference ────────────────────────────────────────────────────────────
    case "/currencies": {
      if (await needsAuth(chatId)) return;
      const limit = args[0] || 20, offset = args[1] || 0;
      try {
        const data = await api("GET", `/currencies?limit=${limit}&offset=${offset}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        const list = data.data.currencies || [];
        if (!list.length) return send(chatId, "No currencies found.");
        let t = `💱 <b>Currencies</b> (${data.data.total} total)\n\n`;
        list.forEach(c => { t += `<b>${c.symbol}</b> — ${c.name} (${c.type})\n  ID: <code>${c.id}</code> | decimals: ${c.decimals}\n\n`; });
        return send(chatId, t);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }
    }

    case "/currency":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /currency &lt;id&gt;");
      try {
        const data = await api("GET", `/currencies/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `💱 <b>Currency</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/networks": {
      if (await needsAuth(chatId)) return;
      const limit = args[0] || 20, offset = args[1] || 0;
      try {
        const data = await api("GET", `/networks?limit=${limit}&offset=${offset}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        const list = data.data.networks || [];
        if (!list.length) return send(chatId, "No networks found.");
        let t = `🌐 <b>Networks</b> (${data.data.total} total)\n\n`;
        list.forEach(n => { t += `<b>${n.code || n.name}</b> — ${n.name}\n  ID: <code>${n.id}</code>\n\n`; });
        return send(chatId, t);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }
    }

    case "/network":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /network &lt;id&gt;");
      try {
        const data = await api("GET", `/networks/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🌐 <b>Network</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/countries":
      if (await needsAuth(chatId)) return;
      try {
        const data = await api("GET", "/bank-fields/countries", s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🏦 <b>Bank-Field Countries</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/bankfields":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /bankfields &lt;country_code&gt;");
      try {
        const data = await api("GET", `/bank-fields/countries/${arg.toUpperCase()}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🏦 <b>Bank Fields</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/iban":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /iban &lt;iban_string&gt;");
      try {
        const data = await api("POST", "/bank-fields/iban", s.apiKey, { iban: arg });
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🏦 <b>IBAN Validation</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Balances ─────────────────────────────────────────────────────────────
    case "/balances":
      if (await needsAuth(chatId)) return;
      try {
        const data = await api("GET", `/projects/${s.projectId}/balances`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `💰 <b>Balances</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Exchange ─────────────────────────────────────────────────────────────
    case "/quote_exchange":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "fromCurrencyId", prompt: "💱 <b>From currency:</b>", picker: pickers.currencies },
        { key: "toCurrencyId", prompt: "💱 <b>To currency:</b>", picker: pickers.currencies },
        { key: "amount", prompt: "💰 Enter <b>amount</b> (e.g. 100.50):",
          execute: (s, d) => api("POST", `/projects/${s.projectId}/exchange/quote`, s.apiKey,
            { projectId: s.projectId, fromCurrencyId: d.fromCurrencyId, toCurrencyId: d.toCurrencyId, amount: d.amount }) },
      ]);

    case "/execute_exchange":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "fromCurrencyId", prompt: "⚠️ <b>This moves real funds!</b>\n\n💱 <b>From currency:</b>", picker: pickers.currencies },
        { key: "toCurrencyId", prompt: "💱 <b>To currency:</b>", picker: pickers.currencies },
        { key: "amount", prompt: "💰 Enter <b>amount</b>:" },
        { key: "idempotencyKey", prompt: "🔑 Enter <b>idempotencyKey</b> (or 'auto'):",
          execute: (s, d) => api("POST", `/projects/${s.projectId}/exchange`, s.apiKey,
            { projectId: s.projectId, fromCurrencyId: d.fromCurrencyId, toCurrencyId: d.toCurrencyId, amount: d.amount,
              ...(d.idempotencyKey !== "auto" && { idempotencyKey: d.idempotencyKey }) }) },
      ]);

    // ── Settlements ──────────────────────────────────────────────────────────
    case "/quote_settlement":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "bankAccountId", prompt: "🏦 <b>Select bank account:</b>", picker: pickers.bankAccounts },
        { key: "amount", prompt: "💰 Enter <b>amount</b> (net):\n<i>Prefix with 'gross:' for grossAmount</i>",
          execute: (s, d) => {
            const body = { bankAccountId: d.bankAccountId };
            if (d.amount.startsWith("gross:")) body.grossAmount = d.amount.slice(6); else body.amount = d.amount;
            return api("POST", `/projects/${s.projectId}/settlements/quote`, s.apiKey, body);
          } },
      ]);

    case "/create_settlement":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "bankAccountId", prompt: "⚠️ <b>Moves real funds!</b>\n\n🏦 <b>Select bank account:</b>", picker: pickers.bankAccounts },
        { key: "amount", prompt: "💰 Enter <b>amount</b> (net):\n<i>Prefix 'gross:' for grossAmount</i>" },
        { key: "remarks", prompt: "📝 Enter <b>remarks</b> (or 'skip'):" },
        { key: "idempotencyKey", prompt: "🔑 Enter <b>idempotencyKey</b> (or 'auto'):",
          execute: (s, d) => {
            const body = { projectId: s.projectId, bankAccountId: d.bankAccountId };
            if (d.amount.startsWith("gross:")) body.grossAmount = d.amount.slice(6); else body.amount = d.amount;
            if (d.remarks !== "skip") body.remarks = d.remarks;
            if (d.idempotencyKey !== "auto") body.idempotencyKey = d.idempotencyKey;
            return api("POST", `/projects/${s.projectId}/settlements`, s.apiKey, body);
          } },
      ]);

    case "/settlements": {
      if (await needsAuth(chatId)) return;
      const limit = args[0] || 20, offset = args[1] || 0;
      try {
        const data = await api("GET", `/projects/${s.projectId}/settlements?limit=${limit}&offset=${offset}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        const list = data.data.settlements || [];
        if (!list.length) return send(chatId, "No settlements found.");
        let t = `📋 <b>Settlements</b> (${data.data.total} total)\n\n`;
        list.forEach(x => { t += `<b>${x.id}</b>\n  Status: ${x.status} | Amount: ${x.amountFormatted || x.amount}\n\n`; });
        return send(chatId, t);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }
    }

    case "/settlement":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /settlement &lt;id&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/settlements/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `📋 <b>Settlement</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/edit_settlement":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "id", prompt: "📋 <b>Select settlement to edit:</b>", picker: pickers.settlements },
        { key: "body", prompt: "Send fields as JSON:\n<code>{\"remarks\": \"...\"}</code>",
          validate: t => parseJson(t) ? null : "Invalid JSON", transform: t => parseJson(t),
          execute: (s, d) => api("PUT", `/projects/${s.projectId}/settlements/${d.id}`, s.apiKey, d.body) },
      ]);

    case "/cancel_settlement":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /cancel_settlement &lt;id&gt;");
      try {
        const data = await api("DELETE", `/projects/${s.projectId}/settlements/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `✅ <b>Settlement cancelled</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Customers ────────────────────────────────────────────────────────────
    case "/create_customer":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "name", prompt: "Enter customer <b>name</b>:" },
        { key: "email", prompt: "Enter customer <b>email</b>:" },
        { key: "description", prompt: "Enter <b>description</b> (or 'skip'):",
          execute: (s, d) => {
            const body = { projectId: s.projectId, name: d.name, email: d.email };
            if (d.description !== "skip") body.description = d.description;
            return api("POST", `/projects/${s.projectId}/customers`, s.apiKey, body);
          } },
      ]);

    case "/customers": {
      if (await needsAuth(chatId)) return;
      const limit = args[0] || 20, offset = args[1] || 0;
      try {
        const data = await api("GET", `/projects/${s.projectId}/customers?limit=${limit}&offset=${offset}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        const list = data.data.customers || [];
        if (!list.length) return send(chatId, "No customers found.");
        let t = `👥 <b>Customers</b> (${data.data.total} total)\n\n`;
        list.forEach(c => { t += `<b>${c.name}</b> (${c.email})\n  ID: <code>${c.id}</code>\n\n`; });
        return send(chatId, t);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }
    }

    // ── Beneficiaries ────────────────────────────────────────────────────────
    case "/create_beneficiary":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "type", prompt: "👤 <b>Beneficiary type:</b>", picker: pickers.benType },
        { key: "nickname", prompt: "📝 Enter a <b>nickname</b> for this beneficiary:" },
        { key: "extra", prompt: d => d.type === "b2b" ? "🏢 Enter <b>business name</b>:" : "👤 Enter <b>first name</b> and <b>last name</b>:",
          execute: (s, d) => {
            const body = { projectId: s.projectId, type: d.type, nickname: d.nickname };
            if (d.type === "b2b") { body.businessName = d.extra; }
            else { const [f, ...r] = d.extra.split(" "); body.firstName = f; body.lastName = r.join(" ") || f; }
            return api("POST", `/projects/${s.projectId}/beneficiaries`, s.apiKey, body);
          } },
      ]);

    case "/beneficiaries": {
      if (await needsAuth(chatId)) return;
      const limit = args[0] || 20, offset = args[1] || 0;
      try {
        const data = await api("GET", `/projects/${s.projectId}/beneficiaries?limit=${limit}&offset=${offset}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        const list = data.data.beneficiaries || [];
        if (!list.length) return send(chatId, "No beneficiaries found.");
        let t = `👤 <b>Beneficiaries</b> (${data.data.total} total)\n\n`;
        list.forEach(b => { t += `<b>${b.nickname || b.businessName || b.firstName}</b> (${b.type})\n  ID: <code>${b.id}</code>\n\n`; });
        return send(chatId, t);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }
    }

    case "/beneficiary":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /beneficiary &lt;id&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/beneficiaries/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `👤 <b>Beneficiary</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/attach_bank":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "beneficiaryId", prompt: "👤 <b>Select beneficiary:</b>", picker: pickers.beneficiaries },
        { key: "alias", prompt: "📝 Enter an <b>alias</b> for this bank account:" },
        { key: "currencyCode", prompt: "💱 Enter <b>currency code</b> (e.g. inr_fiat, usd_fiat):" },
        { key: "country", prompt: "🌍 <b>Select country:</b>", picker: pickers.countries },
        { key: "accountNumber", prompt: "🔢 Enter <b>account number</b> (or IBAN):" },
        { key: "railFields", prompt: "🔧 Enter <b>railFields</b> as JSON or 'skip':",
          transform: t => t === "skip" ? null : parseJson(t),
          execute: (s, d) => {
            const body = { alias: d.alias, currencyCode: d.currencyCode, country: d.country, accountNumber: d.accountNumber };
            if (d.railFields) body.railFields = d.railFields;
            return api("POST", `/projects/${s.projectId}/beneficiaries/${d.beneficiaryId}/bank-accounts`, s.apiKey, body);
          } },
      ]);

    case "/ben_banks":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /ben_banks &lt;beneficiaryId&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/beneficiaries/${arg}/bank-accounts`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🏦 <b>Bank Accounts</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/ben_bank":
      if (await needsAuth(chatId)) return;
      if (args.length < 2) return send(chatId, "Usage: /ben_bank &lt;beneficiaryId&gt; &lt;bankId&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/beneficiaries/${args[0]}/bank-accounts/${args[1]}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🏦 <b>Bank Account</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/attach_crypto":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "beneficiaryId", prompt: "👤 <b>Select beneficiary:</b>", picker: pickers.beneficiaries },
        { key: "networkCode", prompt: "🌐 <b>Select network:</b>",
          picker: async (s) => {
            const list = await pickers.networks(s);
            if (!list) return null;
            return list.map(n => ({ label: n.label, value: n.label.split(" — ")[0] }));
          } },
        { key: "address", prompt: "🔗 Enter <b>wallet address</b>:" },
        { key: "alias", prompt: "📝 Enter <b>alias</b> (or 'skip'):",
          execute: (s, d) => {
            const body = { networkCode: d.networkCode, address: d.address };
            if (d.alias !== "skip") body.alias = d.alias;
            return api("POST", `/projects/${s.projectId}/beneficiaries/${d.beneficiaryId}/wallets`, s.apiKey, body);
          } },
      ]);

    case "/ben_wallets":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /ben_wallets &lt;beneficiaryId&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/beneficiaries/${arg}/wallets`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🔗 <b>Crypto Addresses</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/ben_wallet":
      if (await needsAuth(chatId)) return;
      if (args.length < 2) return send(chatId, "Usage: /ben_wallet &lt;beneficiaryId&gt; &lt;walletId&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/beneficiaries/${args[0]}/wallets/${args[1]}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🔗 <b>Crypto Address</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Bank Accounts ────────────────────────────────────────────────────────
    case "/bank_accounts":
      if (await needsAuth(chatId)) return;
      try {
        const data = await api("GET", `/projects/${s.projectId}/bank-accounts`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🏦 <b>Project Bank Accounts</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/company_accounts":
      if (await needsAuth(chatId)) return;
      try {
        const data = await api("GET", `/projects/${s.projectId}/bank-accounts/company`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🏦 <b>Company Accounts</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Payouts ──────────────────────────────────────────────────────────────
    case "/quote_payout":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "bankAccountId", prompt: "🏦 <b>Select bank account:</b>", picker: pickers.bankAccounts },
        { key: "amount", prompt: "💰 Enter <b>amount</b> (net):\n<i>Prefix 'gross:' for grossAmount</i>",
          execute: (s, d) => {
            const body = { bankAccountId: d.bankAccountId };
            if (d.amount.startsWith("gross:")) body.grossAmount = d.amount.slice(6); else body.amount = d.amount;
            return api("POST", `/projects/${s.projectId}/payouts/quote`, s.apiKey, body);
          } },
      ]);

    case "/create_payout":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "beneficiaryId", prompt: "⚠️ <b>Moves real funds!</b>\n\n👤 <b>Select beneficiary:</b>", picker: pickers.beneficiaries },
        { key: "bankAccountId", prompt: "🏦 <b>Select beneficiary's bank account:</b>", picker: pickers.benBanks },
        { key: "amount", prompt: "💰 Enter <b>amount</b> (net):" },
        { key: "idempotencyKey", prompt: "🔑 Enter <b>idempotencyKey</b> (required):" },
        { key: "remarks", prompt: "📝 Enter <b>remarks</b> (or 'skip'):",
          execute: (s, d) => {
            const body = { projectId: s.projectId, beneficiaryId: d.beneficiaryId, bankAccountId: d.bankAccountId,
              amount: d.amount, idempotencyKey: d.idempotencyKey };
            if (d.remarks !== "skip") body.remarks = d.remarks;
            return api("POST", `/projects/${s.projectId}/payouts`, s.apiKey, body);
          } },
      ]);

    case "/payouts": {
      if (await needsAuth(chatId)) return;
      const limit = args[0] || 20, offset = args[1] || 0;
      try {
        const data = await api("GET", `/projects/${s.projectId}/payouts?limit=${limit}&offset=${offset}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        const list = data.data.payouts || [];
        if (!list.length) return send(chatId, "No payouts found.");
        let t = `💸 <b>Payouts</b> (${data.data.total} total)\n\n`;
        list.forEach(p => { t += `<b>${p.id}</b>\n  Status: ${p.status} | Amount: ${p.amountFormatted || p.amount}\n\n`; });
        return send(chatId, t);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }
    }

    case "/payout":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /payout &lt;id&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/payouts/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `💸 <b>Payout</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/edit_payout":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "id", prompt: "💸 <b>Select payout to edit:</b>", picker: pickers.payouts },
        { key: "body", prompt: "Send fields as JSON:", validate: t => parseJson(t) ? null : "Invalid JSON",
          transform: t => parseJson(t),
          execute: (s, d) => api("PUT", `/projects/${s.projectId}/payouts/${d.id}`, s.apiKey, d.body) },
      ]);

    case "/cancel_payout":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /cancel_payout &lt;id&gt;");
      try {
        const data = await api("DELETE", `/projects/${s.projectId}/payouts/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `✅ <b>Payout cancelled</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Transactions ─────────────────────────────────────────────────────────
    case "/transactions": {
      if (await needsAuth(chatId)) return;
      const limit = args[0] || 20, offset = args[1] || 0;
      try {
        const data = await api("GET", `/projects/${s.projectId}/transactions?limit=${limit}&offset=${offset}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        const list = data.data.transactions || [];
        if (!list.length) return send(chatId, "No transactions found.");
        let t = `📑 <b>Transactions</b> (${data.data.total} total)\n\n`;
        list.forEach(x => { t += `<b>${x.id}</b>\n  Type: ${x.type || "—"} | Amount: ${x.amountFormatted || x.amount || "—"}\n\n`; });
        return send(chatId, t);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }
    }

    case "/tx_summary":
      if (await needsAuth(chatId)) return;
      try {
        const data = await api("GET", `/projects/${s.projectId}/transactions/summary`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `📊 <b>Transaction Summary</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Payment Links ────────────────────────────────────────────────────────
    case "/create_pl":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "customerId",
          prompt: "👤 <b>Select a customer</b> (or 'skip'):",
          picker: async (s) => {
            const data = await api("GET", `/projects/${s.projectId}/customers?limit=20`, s.apiKey);
            if (!data.success || !data.data.customers?.length) return null;
            return data.data.customers.map(c => ({ label: `${c.name} — ${c.email}`, value: c.id }));
          } },
        { key: "amount", prompt: "💰 Enter <b>amount</b> (e.g. 100.00, or 'skip'):" },
        { key: "currencyId",
          prompt: "💱 <b>Select currency</b> (or 'skip' for default):",
          picker: async (s) => {
            const data = await api("GET", `/currencies?limit=50`, s.apiKey);
            if (!data.success || !data.data.currencies?.length) return null;
            const seen = new Set();
            const deduped = [];
            for (const c of data.data.currencies) {
              const key = `${c.symbol}-${c.type}`;
              if (seen.has(key)) continue;
              seen.add(key);
              const tag = c.type === "crypto" ? "🪙" : "💵";
              deduped.push({ label: `${tag} ${c.symbol} — ${c.name}`, value: c.id, _type: c.type });
            }
            return deduped;
          },
        },
        { key: "documentType",
          prompt: "📄 <b>Document type:</b>",
          picker: pickers.docType },
        { key: "networkId",
          prompt: "🌐 <b>Blockchain network:</b>",
          skipIf: (data) => {
            // Skip network selection for fiat currencies
            const cid = data.currencyId;
            return !cid || cid === "skip" || !data._isCrypto;
          },
          picker: async (s) => {
            const data = await api("GET", `/networks?limit=50`, s.apiKey);
            if (!data.success || !data.data.networks?.length) return null;
            return [
              ...data.data.networks.map(n => ({ label: `${n.code || n.name} — ${n.name}`, value: n.id })),
              { label: "Skip", value: "skip" },
            ];
          } },
        { key: "autoConvert",
          prompt: "🔄 <b>Auto-convert deposit to requested currency?</b>",
          skipIf: (data) => !data._isCrypto,
          picker: pickers.yesNo,
          execute: (s, d) => {
            const body = {};
            if (d.customerId !== "skip") body.customerId = d.customerId;
            if (d.amount !== "skip") body.amount = parseFloat(d.amount);
            if (d.currencyId !== "skip") body.currencyId = d.currencyId;
            if (d.documentType !== "skip") body.documentType = d.documentType;
            if (d.networkId !== "skip") body.networkId = d.networkId;
            if (d.autoConvert === "true") body.autoConvert = true;
            return api("POST", `/projects/${s.projectId}/payment-links`, s.apiKey, body);
          } },
      ]);

    case "/payment_links": {
      if (await needsAuth(chatId)) return;
      const limit = args[0] || 20, offset = args[1] || 0;
      try {
        const data = await api("GET", `/projects/${s.projectId}/payment-links?limit=${limit}&offset=${offset}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        const list = data.data.paymentLinks || data.data["payment-links"] || [];
        if (!list.length) return send(chatId, "No payment links found.");
        let t = `🔗 <b>Payment Links</b> (${data.data.total} total)\n\n`;
        list.forEach(p => { t += `<b>${p.id}</b>\n  Status: ${p.status || "—"} | Amount: ${p.amount || "—"}\n\n`; });
        return send(chatId, t);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }
    }

    case "/payment_link":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /payment_link &lt;id&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/payment-links/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🔗 <b>Payment Link</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/edit_pl":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "id", prompt: "🔗 <b>Select payment link to edit:</b>", picker: pickers.paymentLinks },
        { key: "body", prompt: "Send fields as JSON:", validate: t => parseJson(t) ? null : "Invalid JSON",
          transform: t => parseJson(t),
          execute: (s, d) => api("PUT", `/projects/${s.projectId}/payment-links/${d.id}`, s.apiKey, d.body) },
      ]);

    case "/cancel_pl":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /cancel_pl &lt;id&gt;");
      try {
        const data = await api("DELETE", `/projects/${s.projectId}/payment-links/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `✅ <b>Payment link cancelled</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/signal_pl":
      if (await needsAuth(chatId)) return;
      if (args.length < 2) return send(chatId, "Usage: /signal_pl &lt;linkId&gt; &lt;txHash&gt;");
      try {
        const data = await api("POST", `/projects/${s.projectId}/payment-links/${args[0]}/expected`, s.apiKey,
          { declaredTransactionHash: args[1] });
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `✅ <b>Signal sent</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/pl_invoice":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /pl_invoice &lt;linkId&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/payment-links/${arg}/invoice`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `📄 <b>Invoice</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/resend_pl_invoice":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /resend_pl_invoice &lt;linkId&gt;");
      try {
        const data = await api("POST", `/projects/${s.projectId}/payment-links/${arg}/invoice/resend`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `✅ <b>Invoice resent</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/deposits_review":
      if (await needsAuth(chatId)) return;
      try {
        const data = await api("GET", `/projects/${s.projectId}/payment-links/deposits-under-review`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `🔍 <b>Deposits Under Review</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Deposit Requests ─────────────────────────────────────────────────────
    case "/create_dr":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "beneficiaryId", prompt: "👤 <b>Select beneficiary:</b>", picker: pickers.beneficiaries },
        { key: "bankAccountId", prompt: "🏦 <b>Select beneficiary's bank account:</b>", picker: pickers.benBanks },
        { key: "currencyId", prompt: "💱 <b>Select currency:</b>", picker: pickers.currencies },
        { key: "amount", prompt: "💰 Enter <b>amount</b> (or 'skip'):" },
        { key: "documentType", prompt: "📄 <b>Document type:</b>", picker: pickers.docType,
          execute: (s, d) => {
            const body = { beneficiaryId: d.beneficiaryId, bankAccountId: d.bankAccountId, currencyId: d.currencyId };
            if (d.amount !== "skip") body.amount = parseFloat(d.amount);
            if (d.documentType !== "skip") body.documentType = d.documentType;
            return api("POST", `/projects/${s.projectId}/deposit-requests`, s.apiKey, body);
          } },
      ]);

    case "/deposit_requests": {
      if (await needsAuth(chatId)) return;
      const limit = args[0] || 20, offset = args[1] || 0;
      try {
        const data = await api("GET", `/projects/${s.projectId}/deposit-requests?limit=${limit}&offset=${offset}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        const list = data.data.depositRequests || data.data["deposit-requests"] || [];
        if (!list.length) return send(chatId, "No deposit requests found.");
        let t = `📥 <b>Deposit Requests</b> (${data.data.total} total)\n\n`;
        list.forEach(d => { t += `<b>${d.id}</b>\n  Stage: ${d.stage || "—"} | Amount: ${d.expectedDepositAmount || "—"}\n\n`; });
        return send(chatId, t);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }
    }

    case "/deposit_request":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /deposit_request &lt;id&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/deposit-requests/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `📥 <b>Deposit Request</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/edit_dr":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "id", prompt: "📥 <b>Select deposit request to edit:</b>", picker: pickers.depositRequests },
        { key: "body", prompt: "Send fields as JSON:", validate: t => parseJson(t) ? null : "Invalid JSON",
          transform: t => parseJson(t),
          execute: (s, d) => api("PUT", `/projects/${s.projectId}/deposit-requests/${d.id}`, s.apiKey, d.body) },
      ]);

    case "/cancel_dr":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /cancel_dr &lt;id&gt;");
      try {
        const data = await api("DELETE", `/projects/${s.projectId}/deposit-requests/${arg}`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `✅ <b>Deposit request cancelled</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/signal_dr":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /signal_dr &lt;depositRequestId&gt;");
      return await startConvo(chatId, [
        { key: "body", prompt: "Send signal body as JSON or 'empty':",
          transform: t => t === "empty" ? {} : parseJson(t) || {},
          execute: (s, d) => api("POST", `/projects/${s.projectId}/deposit-requests/${arg}/expected`, s.apiKey, d.body) },
      ]);

    case "/dr_collections":
      if (await needsAuth(chatId)) return;
      if (!arg) return send(chatId, "Usage: /dr_collections &lt;id&gt;");
      try {
        const data = await api("GET", `/projects/${s.projectId}/deposit-requests/${arg}/collections`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `📥 <b>Collections</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    // ── Emails ───────────────────────────────────────────────────────────────
    case "/email_types":
      if (await needsAuth(chatId)) return;
      try {
        const data = await api("GET", `/projects/${s.projectId}/emails/types`, s.apiKey);
        if (!data.success) return send(chatId, `❌ ${data.error?.code}: ${data.error?.userMessage}`);
        return send(chatId, `📧 <b>Email Types</b>\n\n${fmt(data.data)}`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    case "/send_email":
      if (await needsAuth(chatId)) return;
      return await startConvo(chatId, [
        { key: "emailType", prompt: "📧 <b>Select email type:</b>", picker: pickers.emailTypes },
        { key: "resourceId", prompt: "🔗 Enter <b>resource ID</b> (the entity this email is about):" },
        { key: "to", prompt: "📨 Enter <b>recipient emails</b> (comma separated, or 'skip'):",
          execute: (s, d) => {
            const body = { emailType: d.emailType, resourceId: d.resourceId };
            if (d.to !== "skip") body.to = d.to.split(",").map(e => e.trim());
            return api("POST", `/projects/${s.projectId}/emails/dispatch`, s.apiKey, body);
          } },
      ]);

    // ── Raw ──────────────────────────────────────────────────────────────────
    case "/raw":
      if (await needsAuth(chatId)) return;
      if (args.length < 2) return send(chatId, "Usage: /raw &lt;METHOD&gt; &lt;path&gt; [json_body]");
      try {
        let path = args[1].replace("{projectId}", s.projectId).replace("{id}", s.projectId);
        if (!path.startsWith("/")) path = "/" + path;
        const bodyText = args.slice(2).join(" ");
        const body = bodyText ? parseJson(bodyText) : undefined;
        if (bodyText && !body) return send(chatId, "⚠️ Invalid JSON body.");
        const data = await api(args[0], path, s.apiKey, body);
        return send(chatId, `🔧 <b>Raw Response</b>\n\n<code>${JSON.stringify(data, null, 2).slice(0, 3800)}</code>`);
      } catch (e) { return send(chatId, `❌ ${e.message}`); }

    default:
      return send(chatId, "Unknown command. Type /help for the full list.");
  }
}

// ── Vercel handler ───────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("OK");

  try {
    const { message } = req.body || {};
    if (message?.text && message?.chat?.id) {
      await handle(message.chat.id, message.text.trim());
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }

  res.status(200).send("OK");
};
