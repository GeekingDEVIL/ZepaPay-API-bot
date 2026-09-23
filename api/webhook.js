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

// ── Conversation flow engine ─────────────────────────────────────────────────

function startConvo(chatId, steps) {
  conversations.set(chatId, { steps, current: 0, data: {} });
  const step = steps[0];
  send(chatId, step.prompt);
}

async function handleConvo(chatId, text) {
  const convo = conversations.get(chatId);
  if (!convo) return false;

  const step = convo.steps[convo.current];
  if (step.validate) {
    const err = step.validate(text);
    if (err) { send(chatId, `⚠️ ${err}`); return true; }
  }
  convo.data[step.key] = step.transform ? step.transform(text) : text;
  convo.current++;

  if (convo.current < convo.steps.length) {
    const next = convo.steps[convo.current];
    const prompt = typeof next.prompt === "function" ? next.prompt(convo.data) : next.prompt;
    send(chatId, prompt);
    return true;
  }

  conversations.delete(chatId);
  const s = sess(chatId);
  if (!s) { send(chatId, "⚠️ Session expired. /start again."); return true; }

  try {
    send(chatId, "⏳ Sending request...");
    const lastStep = convo.steps[convo.steps.length - 1];
    const result = await lastStep.execute(s, convo.data);
    if (!result.success) {
      send(chatId, `❌ <b>${result.error?.code}</b>\n${result.error?.userMessage || result.error?.message}`);
    } else {
      send(chatId, `✅ <b>Success</b>\n\n${fmt(result.data)}`);
    }
  } catch (e) {
    send(chatId, `❌ ${e.message}`);
  }
  return true;
}

// ── Command router ───────────────────────────────────────────────────────────

async function handle(chatId, text) {
  if (!text) return;

  // Key capture
  if (text.startsWith("sbk_")) {
    send(chatId, "⏳ Validating key...");
    try {
      const data = await api("GET", "/developer/me", text);
      if (!data.success) {
        return send(chatId, `❌ <b>${data.error?.code}</b>\n${data.error?.userMessage || data.error?.message || "Invalid key"}`);
      }
      sessions.set(chatId, { apiKey: text, projectId: data.data.projectId });
      const scopes = (data.data.scopes || []).join(", ");
      return send(chatId, `✅ <b>Connected!</b>\n\n<b>Project:</b> <code>${data.data.projectId}</code>\n<b>Key ID:</b> <code>${data.data.keyId}</code>\n<b>Scopes:</b> ${scopes}\n\nType /help to see all commands.`);
    } catch (e) {
      return send(chatId, `❌ Connection failed: ${e.message}`);
    }
  }

  // Cancel conversation
  if (text === "/cancel") {
    conversations.delete(chatId);
    return send(chatId, "🚫 Cancelled.");
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

    case "/help":
      return send(chatId, `📖 <b>ZepaPay Bot Commands</b>

<b>── Session ──</b>
/start — Connect with API key
/setkey — Change API key
/logout — Clear session
/me — Identify current key

<b>── Reference ──</b>
/currencies [limit] [offset] — List currencies
/currency &lt;id&gt; — Get a currency
/networks [limit] [offset] — List networks
/network &lt;id&gt; — Get a network
/countries — List bank-field countries
/bankfields &lt;country_code&gt; — Country bank fields
/iban &lt;iban_string&gt; — Validate IBAN

<b>── Balances ──</b>
/balances — Project balances

<b>── Exchange ──</b>
/quote_exchange — Quote (interactive)
/execute_exchange — Execute (interactive)

<b>── Settlements ──</b>
/quote_settlement — Quote (interactive)
/create_settlement — Create (interactive)
/settlements [limit] [offset] — List
/settlement &lt;id&gt; — Get one
/edit_settlement — Edit (interactive)
/cancel_settlement &lt;id&gt; — Cancel

<b>── Customers ──</b>
/create_customer — Create (interactive)
/customers [limit] [offset] — List

<b>── Beneficiaries ──</b>
/create_beneficiary — Create (interactive)
/beneficiaries [limit] [offset] — List
/beneficiary &lt;id&gt; — Get one
/attach_bank — Attach bank (interactive)
/ben_banks &lt;beneficiaryId&gt; — List bank accounts
/ben_bank &lt;beneficiaryId&gt; &lt;bankId&gt;
/attach_crypto — Attach crypto (interactive)
/ben_wallets &lt;beneficiaryId&gt; — List crypto
/ben_wallet &lt;beneficiaryId&gt; &lt;walletId&gt;

<b>── Bank Accounts ──</b>
/bank_accounts — Project's own
/company_accounts — Company deposit accounts

<b>── Payouts ──</b>
/quote_payout — Quote (interactive)
/create_payout — Create (interactive)
/payouts [limit] [offset] — List
/payout &lt;id&gt; — Get one
/edit_payout — Edit (interactive)
/cancel_payout &lt;id&gt; — Cancel

<b>── Transactions ──</b>
/transactions [limit] [offset] — List
/tx_summary — Summary

<b>── Payment Links ──</b>
/create_pl — Create (interactive)
/payment_links [limit] [offset] — List
/payment_link &lt;id&gt; — Get one
/edit_pl — Edit (interactive)
/cancel_pl &lt;id&gt; — Cancel
/signal_pl &lt;linkId&gt; &lt;txHash&gt; — Signal deposit
/pl_invoice &lt;linkId&gt; — Invoice
/resend_pl_invoice &lt;linkId&gt; — Resend
/deposits_review — Under review

<b>── Deposit Requests ──</b>
/create_dr — Create (interactive)
/deposit_requests [limit] [offset] — List
/deposit_request &lt;id&gt; — Get one
/edit_dr — Edit (interactive)
/cancel_dr &lt;id&gt; — Cancel
/signal_dr — Signal (interactive)
/dr_collections &lt;id&gt; — Collections

<b>── Emails ──</b>
/email_types — List types
/send_email — Dispatch (interactive)

<b>── Power User ──</b>
/raw &lt;METHOD&gt; &lt;path&gt; [json_body]

<i>/cancel — abort any interactive flow</i>`);

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
      return startConvo(chatId, [
        { key: "fromCurrencyId", prompt: "Enter <b>fromCurrencyId</b> (UUID):\n\n<i>Use /currencies to find IDs</i>" },
        { key: "toCurrencyId", prompt: "Enter <b>toCurrencyId</b> (UUID):" },
        { key: "amount", prompt: "Enter <b>amount</b> (human-readable, e.g. 100.50):",
          execute: (s, d) => api("POST", `/projects/${s.projectId}/exchange/quote`, s.apiKey,
            { projectId: s.projectId, fromCurrencyId: d.fromCurrencyId, toCurrencyId: d.toCurrencyId, amount: d.amount }) },
      ]);

    case "/execute_exchange":
      if (await needsAuth(chatId)) return;
      return startConvo(chatId, [
        { key: "fromCurrencyId", prompt: "⚠️ <b>This moves real funds!</b>\n\nEnter <b>fromCurrencyId</b>:" },
        { key: "toCurrencyId", prompt: "Enter <b>toCurrencyId</b>:" },
        { key: "amount", prompt: "Enter <b>amount</b> (human-readable):" },
        { key: "idempotencyKey", prompt: "Enter <b>idempotencyKey</b> (or 'auto'):",
          execute: (s, d) => api("POST", `/projects/${s.projectId}/exchange`, s.apiKey,
            { projectId: s.projectId, fromCurrencyId: d.fromCurrencyId, toCurrencyId: d.toCurrencyId, amount: d.amount,
              ...(d.idempotencyKey !== "auto" && { idempotencyKey: d.idempotencyKey }) }) },
      ]);

    // ── Settlements ──────────────────────────────────────────────────────────
    case "/quote_settlement":
      if (await needsAuth(chatId)) return;
      return startConvo(chatId, [
        { key: "bankAccountId", prompt: "Enter <b>bankAccountId</b> (UUID):" },
        { key: "amount", prompt: "Enter <b>amount</b> (net):\n<i>Prefix with 'gross:' for grossAmount</i>",
          execute: (s, d) => {
            const body = { bankAccountId: d.bankAccountId };
            if (d.amount.startsWith("gross:")) body.grossAmount = d.amount.slice(6); else body.amount = d.amount;
            return api("POST", `/projects/${s.projectId}/settlements/quote`, s.apiKey, body);
          } },
      ]);

    case "/create_settlement":
      if (await needsAuth(chatId)) return;
      return startConvo(chatId, [
        { key: "bankAccountId", prompt: "⚠️ <b>Moves real funds!</b>\n\nEnter <b>bankAccountId</b>:" },
        { key: "amount", prompt: "Enter <b>amount</b> (net):\n<i>Prefix 'gross:' for grossAmount</i>" },
        { key: "remarks", prompt: "Enter <b>remarks</b> (or 'skip'):" },
        { key: "idempotencyKey", prompt: "Enter <b>idempotencyKey</b> (or 'auto'):",
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
      return startConvo(chatId, [
        { key: "id", prompt: "Enter <b>settlement ID</b>:" },
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
      return startConvo(chatId, [
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
      return startConvo(chatId, [
        { key: "type", prompt: "Enter <b>type</b>: <code>b2c</code> or <code>b2b</code>:" },
        { key: "nickname", prompt: "Enter <b>nickname</b>:" },
        { key: "extra", prompt: d => d.type === "b2b" ? "Enter <b>businessName</b>:" : "Enter <b>firstName lastName</b>:",
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
      return startConvo(chatId, [
        { key: "beneficiaryId", prompt: "Enter <b>beneficiaryId</b>:" },
        { key: "alias", prompt: "Enter <b>alias</b>:" },
        { key: "currencyCode", prompt: "Enter <b>currencyCode</b> (e.g. inr_fiat):" },
        { key: "country", prompt: "Enter <b>country</b> (e.g. IN):" },
        { key: "accountNumber", prompt: "Enter <b>accountNumber</b> (or IBAN):" },
        { key: "railFields", prompt: "Enter <b>railFields</b> as JSON or 'skip':",
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
      return startConvo(chatId, [
        { key: "beneficiaryId", prompt: "Enter <b>beneficiaryId</b>:" },
        { key: "networkCode", prompt: "Enter <b>networkCode</b> (e.g. ETH, BASE, TRX):" },
        { key: "address", prompt: "Enter <b>wallet address</b>:" },
        { key: "alias", prompt: "Enter <b>alias</b> (or 'skip'):",
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
      return startConvo(chatId, [
        { key: "bankAccountId", prompt: "Enter <b>bankAccountId</b>:" },
        { key: "amount", prompt: "Enter <b>amount</b> (net):\n<i>Prefix 'gross:' for grossAmount</i>",
          execute: (s, d) => {
            const body = { bankAccountId: d.bankAccountId };
            if (d.amount.startsWith("gross:")) body.grossAmount = d.amount.slice(6); else body.amount = d.amount;
            return api("POST", `/projects/${s.projectId}/payouts/quote`, s.apiKey, body);
          } },
      ]);

    case "/create_payout":
      if (await needsAuth(chatId)) return;
      return startConvo(chatId, [
        { key: "beneficiaryId", prompt: "⚠️ <b>Moves real funds!</b>\n\nEnter <b>beneficiaryId</b>:" },
        { key: "bankAccountId", prompt: "Enter <b>bankAccountId</b>:" },
        { key: "amount", prompt: "Enter <b>amount</b> (net):" },
        { key: "idempotencyKey", prompt: "Enter <b>idempotencyKey</b> (required):" },
        { key: "remarks", prompt: "Enter <b>remarks</b> (or 'skip'):",
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
      return startConvo(chatId, [
        { key: "id", prompt: "Enter <b>payout ID</b>:" },
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
      return startConvo(chatId, [
        { key: "customerId", prompt: "Enter <b>customerId</b> (or 'skip'):" },
        { key: "amount", prompt: "Enter <b>amount</b> (or 'skip'):" },
        { key: "currencyId", prompt: "Enter <b>currencyId</b> (or 'skip' for USD):" },
        { key: "documentType", prompt: "<b>documentType</b>: <code>invoice</code> or <code>deposit_slip</code> (or 'skip'):",
          execute: (s, d) => {
            const body = {};
            if (d.customerId !== "skip") body.customerId = d.customerId;
            if (d.amount !== "skip") body.amount = d.amount;
            if (d.currencyId !== "skip") body.currencyId = d.currencyId;
            if (d.documentType !== "skip") body.documentType = d.documentType;
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
      return startConvo(chatId, [
        { key: "id", prompt: "Enter <b>payment link ID</b>:" },
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
      return startConvo(chatId, [
        { key: "beneficiaryId", prompt: "Enter <b>beneficiaryId</b>:" },
        { key: "bankAccountId", prompt: "Enter <b>bankAccountId</b>:" },
        { key: "currencyId", prompt: "Enter <b>currencyId</b>:" },
        { key: "amount", prompt: "Enter <b>amount</b> (or 'skip'):" },
        { key: "documentType", prompt: "<b>documentType</b>: <code>invoice</code> / <code>deposit_slip</code> (or 'skip'):",
          execute: (s, d) => {
            const body = { beneficiaryId: d.beneficiaryId, bankAccountId: d.bankAccountId, currencyId: d.currencyId };
            if (d.amount !== "skip") body.amount = d.amount;
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
      return startConvo(chatId, [
        { key: "id", prompt: "Enter <b>deposit request ID</b>:" },
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
      return startConvo(chatId, [
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
      return startConvo(chatId, [
        { key: "emailType", prompt: "Enter <b>emailType</b> slug:" },
        { key: "resourceId", prompt: "Enter <b>resourceId</b> (UUID):" },
        { key: "to", prompt: "Enter <b>to</b> emails (comma separated, or 'skip'):",
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
