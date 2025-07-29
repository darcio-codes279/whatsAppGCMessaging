const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const GROUP_NAME = "TEST_WA_BOT"; // ✅ Replace with exact group name
const MESSAGE = "This is message is from my computer";
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: false,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on("qr", qr => {
    qrcode.generate(qr, { small: true });
    console.log("Scan the QR code above to log in.");
});

client.on("ready", async () => {
    console.log("✅ Client is ready");

    const chats = await client.getChats();
    console.log(`📦 Found ${chats.length} chats`);

    const group = chats.find(chat => {
        if (chat.isGroup) {
            console.log(`🧪 Checking group: "${chat.name}"`);
        }
        return chat.isGroup && chat.name === GROUP_NAME;
    });

    if (!group) {
        console.error(`❌ Group "${GROUP_NAME}" not found`);
        process.exit(1);
    }

    console.log(`📨 Sending message to group: "${group.name}"`);
    await group.sendMessage(MESSAGE);
    console.log(`✅ Sent message: "${MESSAGE}"`);

    setTimeout(() => {
        client.destroy();
        process.exit(0);
    }, 3000);
});

client.initialize();
