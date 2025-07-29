const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const KEYWORD = "TEST_WA_BOT"; // 🔁 Part of group names (case-sensitive!)
const MESSAGE = "📢 Hello everyone! This is a test message.";

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: false,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS path
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on("qr", qr => {
    qrcode.generate(qr, { small: true });
    console.log("🔐 Scan the QR code above to log in.");
});

client.on("ready", async () => {
    console.log("✅ WhatsApp client is ready");

    const chats = await client.getChats();
    const matchingGroups = chats.filter(chat =>
        chat.isGroup && chat.name.includes(KEYWORD)
    );

    if (matchingGroups.length === 0) {
        console.log(`❌ No group chats found with keyword: "${KEYWORD}"`);
        process.exit(0);
    }

    console.log(`📦 Found ${matchingGroups.length} groups with "${KEYWORD}"`);
    for (const group of matchingGroups) {
        console.log(`📨 Sending to: "${group.name}"`);
        await group.sendMessage(MESSAGE);
        console.log(`✅ Sent to: "${group.name}"`);
    }

    setTimeout(() => {
        console.log("👋 Done. Exiting...");
        client.destroy();
        process.exit(0);
    }, 5000);
});

client.initialize();
