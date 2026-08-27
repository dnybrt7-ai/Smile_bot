const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('لطفاً BOT_TOKEN را ست کنید.');
  process.exit(1);
}

fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)
  .then((r) => r.json())
  .then((data) => console.log(JSON.stringify(data, null, 2)))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
