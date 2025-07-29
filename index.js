const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const cron = require("node-cron");
const scheduleData = require("./schedule.json");
const { findGroupByName } = require("./utils");

// Initialize WhatsApp Client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: false, // show browser for debugging
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// QR Code Handler
client.on("qr", qr => {
    qrcode.generate(qr, { small: true });
    console.log("Scan the QR code above to log in");
});

// On Ready
client.on("ready", async () => {
    console.log("WhatsApp Client is ready ✅");

    // Get the current logged-in user's ID
    const currentUser = client.info.wid._serialized;
    console.log(`Logged in as: ${currentUser}`);

    for (const task of scheduleData) {
        const { groupName, message, cron: cronTime } = task;

        cron.schedule(cronTime, async () => {
            const group = await findGroupByName(client, groupName);

            if (!group) {
                console.log(`❌ Group "${groupName}" not found`);
                return;
            }

            if (userId) {
                const isAdmin = await isUserAdmin(client, group, currentUser);
                if (!isAdmin) {
                    console.log(`❌ User is not an admin of "${groupName}".
                        Message cannot be sent`);
                    return;
                }
            }

            try {
                await group.sendMessage(message);
                console.log(`✅ Message sent to "${groupName}" at ${new Date().toLocaleString()}`);
            } catch (err) {
                console.error(`Error sending to "${groupName}":`, err.message);
            }
        });

        console.log(`📅 Scheduled message to "${groupName}" => "${message}" [${cronTime}]`);
    }
});

client.initialize();
