require("dotenv").config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const URL = process.argv[2];

if (!URL) {
  console.error("Usage: node scripts/set-webhook.js <vercel-url>");
  console.error("Example: node scripts/set-webhook.js https://zepapay-bot.vercel.app");
  process.exit(1);
}

const webhook = `${URL.replace(/\/$/, "")}/api/webhook`;

fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: webhook }),
})
  .then((r) => r.json())
  .then((data) => {
    console.log("Webhook set:", JSON.stringify(data, null, 2));
    console.log("\nWebhook URL:", webhook);
  })
  .catch((e) => console.error("Error:", e.message));
