const token = process.env.BOT_TOKEN;
const url = process.env.WEBHOOK_URL;
const secret = process.env.WEBHOOK_SECRET;

if (!token || !url) {
  console.error('لطفاً BOT_TOKEN و WEBHOOK_URL را به عنوان متغیر محیطی ست کنید.');
  process.exit(1);
}

const params = new URLSearchParams({ url, allowed_updates: JSON.stringify(['message', 'callback_query']) });
if (secret) params.set('secret_token', secret);

fetch(`https://api.telegram.org/bot${token}/setWebhook?${params.toString()}`)
  .then((r) => r.json())
  .then((data) => console.log(JSON.stringify(data, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
