const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { findGroupByName, isUserAdmin } = require('./utils');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// WhatsApp Client Setup
let client = null;
let isClientReady = false;

const initializeClient = () => {
    try {
        client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                timeout: 120000, // Increase to 2 minutes
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-ipc-flooding-protection'
                ]
            }
        });
    } catch (error) {
        console.error('❌ Error creating WhatsApp client:', error);
        return;
    }

    client.on('qr', (qr) => {
        console.log('QR Code received. Please scan with WhatsApp.');
        // In production, you might want to send this QR to frontend
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Client is ready');
        isClientReady = true;
    });

    client.on('disconnected', (reason) => {
        console.log('❌ Client was logged out:', reason);
        isClientReady = false;

        // Attempt to reconnect after a delay
        console.log('🔄 Attempting to reconnect in 5 seconds...');
        setTimeout(() => {
            initializeClient();
        }, 5000);
    });

    client.on('auth_failure', (msg) => {
        console.error('❌ Authentication failed:', msg);
        isClientReady = false;
    });

    client.on('change_state', (state) => {
        console.log('🔄 WhatsApp state changed:', state);
    });

    client.on('loading_screen', (percent, message) => {
        console.log('📱 Loading screen:', percent, message);
    });

    console.log('🚀 Initializing WhatsApp client...');
    client.initialize().catch(err => {
        console.error('❌ Failed to initialize WhatsApp client:', err);
        isClientReady = false;
    });
};

// Initialize client on startup with fallback
try {
    console.log('🔄 Attempting to initialize WhatsApp client...');
    initializeClient();

    // Set a timeout to mark server as ready even if WhatsApp fails
    setTimeout(() => {
        if (!isClientReady) {
            console.log('⚠️  WhatsApp client not ready, but server will continue running');
            console.log('💡 You can try to reconnect via /api/whatsapp/reconnect endpoint');
        }
    }, 60000); // 1 minute timeout
} catch (error) {
    console.error('❌ Failed to start WhatsApp client:', error);
    console.log('🚀 Server will continue running without WhatsApp functionality');
}

// Helper function to load schedule data
const loadScheduleData = () => {
    try {
        const data = fs.readFileSync('./schedule.json', 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
};

// Helper function to save schedule data
const saveScheduleData = (data) => {
    fs.writeFileSync('./schedule.json', JSON.stringify(data, null, 2));
};

const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) => {
        const ext = path.extname(file.originalname);
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
        cb(null, uniqueName);
    }
});

const upload = multer({ storage });

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsappReady: isClientReady,
        timestamp: new Date().toISOString()
    });
});

// Get WhatsApp connection status
app.get('/api/whatsapp/status', (req, res) => {
    res.json({
        isReady: isClientReady,
        clientInfo: isClientReady ? client.info : null
    });
});

// Manual reconnect endpoint
app.post('/api/whatsapp/reconnect', (req, res) => {
    try {
        if (isClientReady) {
            return res.json({
                success: true,
                message: 'WhatsApp client is already connected'
            });
        }

        console.log('🔄 Manual reconnection attempt initiated...');
        initializeClient();

        res.json({
            success: true,
            message: 'Reconnection attempt started. Check status in a few moments.'
        });
    } catch (error) {
        console.error('❌ Manual reconnection failed:', error);
        res.status(500).json({
            error: 'Failed to initiate reconnection',
            details: error.message
        });
    }
});

// Send immediate message
app.post('/api/messages/send', upload.array('images', 5), async (req, res) => {
    try {
        const { groupName, message } = req.body;
        const images = req.files || [];

        // Validation
        if (!groupName || !message) {
            return res.status(400).json({
                error: 'groupName and message are required'
            });
        }

        if (!isClientReady) {
            return res.status(503).json({
                error: 'WhatsApp client is not ready. Please try again later.'
            });
        }

        // Find the group
        const group = await findGroupByName(client, groupName);
        if (!group) {
            return res.status(404).json({
                error: `Group "${groupName}" not found`
            });
        }

        // Check if current user is admin
        const currentUser = client.info.wid._serialized;
        const isAdmin = await isUserAdmin(client, group, currentUser);

        if (!isAdmin) {
            return res.status(403).json({
                error: `You are not an admin in "${groupName}". Only admins can send messages.`
            });
        }

        // Send the message
        try {
            if (images.length > 0) {
                // Send text message first if provided
                if (message.trim()) {
                    await group.sendMessage(message);
                }

                // Send each image
                for (const image of images) {
                    const media = MessageMedia.fromFilePath(image.path);
                    await group.sendMessage(media);

                    // Clean up uploaded file
                    fs.unlinkSync(image.path);
                }
            } else {
                // Send text-only message
                await group.sendMessage(message);
            }
        } catch (sendError) {
            // Clean up any remaining uploaded files
            images.forEach(image => {
                if (fs.existsSync(image.path)) {
                    fs.unlinkSync(image.path);
                }
            });

            // Check if it's a session disconnection error
            if (sendError.message.includes('Session closed') || sendError.message.includes('Protocol error')) {
                isClientReady = false;
                throw new Error('WhatsApp session disconnected. Please wait for reconnection and try again.');
            }
            throw sendError;
        }

        res.json({
            success: true,
            message: `Message sent successfully${images.length > 0 ? ` with ${images.length} image(s)` : ''}`,
            groupName,
            sentAt: new Date().toISOString(),
            imageCount: images.length
        });

    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            error: 'Failed to send message',
            details: error.message
        });
    }
});

// Schedule a message
app.post('/api/messages/schedule', upload.array('images', 5), async (req, res) => {
    try {
        const { groupName, message, cronTime, description } = req.body;
        const images = req.files || [];

        // Validation
        if (!groupName || !message || !cronTime) {
            return res.status(400).json({
                error: 'groupName, message, and cronTime are required'
            });
        }

        if (!isClientReady) {
            return res.status(503).json({
                error: 'WhatsApp client is not ready. Please try again later.'
            });
        }

        // Validate cron expression
        if (!cron.validate(cronTime)) {
            return res.status(400).json({
                error: 'Invalid cron expression'
            });
        }

        // Find the group
        const group = await findGroupByName(client, groupName);
        if (!group) {
            return res.status(404).json({
                error: `Group "${groupName}" not found`
            });
        }

        // Check if current user is admin
        const currentUser = client.info.wid._serialized;
        const isAdmin = await isUserAdmin(client, group, currentUser);

        if (!isAdmin) {
            return res.status(403).json({
                error: `You are not an admin in "${groupName}". Only admins can schedule messages.`
            });
        }

        // Load existing schedule data
        const scheduleData = loadScheduleData();

        // Store image paths for scheduled messages
        const imagePaths = images.map(image => {
            const scheduledImagePath = path.join('./uploads/scheduled', `${Date.now()}-${image.originalname}`);
            // Create scheduled directory if it doesn't exist
            const scheduledDir = path.dirname(scheduledImagePath);
            if (!fs.existsSync(scheduledDir)) {
                fs.mkdirSync(scheduledDir, { recursive: true });
            }
            // Move file to scheduled directory
            fs.renameSync(image.path, scheduledImagePath);
            return scheduledImagePath;
        });

        // Create new scheduled task
        const newTask = {
            id: Date.now().toString(),
            groupName,
            message,
            cron: cronTime,
            description: description || '',
            createdAt: new Date().toISOString(),
            createdBy: currentUser,
            imagePaths: imagePaths
        };

        // Add to schedule data
        scheduleData.push(newTask);
        saveScheduleData(scheduleData);

        // Schedule the cron job
        cron.schedule(cronTime, async () => {
            try {
                const group = await findGroupByName(client, groupName);
                if (group) {
                    const isAdmin = await isUserAdmin(client, group, currentUser);
                    if (isAdmin) {
                        // Send text message first if provided
                        if (message.trim()) {
                            await group.sendMessage(message);
                        }

                        // Send images if any
                        if (imagePaths && imagePaths.length > 0) {
                            for (const imagePath of imagePaths) {
                                if (fs.existsSync(imagePath)) {
                                    const media = MessageMedia.fromFilePath(imagePath);
                                    await group.sendMessage(media);
                                    // Clean up the scheduled image file
                                    fs.unlinkSync(imagePath);
                                }
                            }
                        }

                        console.log(`✅ Scheduled message sent to "${groupName}" at ${new Date().toLocaleString()}${imagePaths?.length ? ` with ${imagePaths.length} image(s)` : ''}`);
                    } else {
                        console.log(`❌ User no longer admin in "${groupName}". Scheduled message not sent.`);
                        // Clean up images if user is no longer admin
                        if (imagePaths && imagePaths.length > 0) {
                            imagePaths.forEach(imagePath => {
                                if (fs.existsSync(imagePath)) {
                                    fs.unlinkSync(imagePath);
                                }
                            });
                        }
                    }
                }
            } catch (error) {
                console.error(`Error sending scheduled message to "${groupName}":`, error.message);
                // Clean up images on error
                if (imagePaths && imagePaths.length > 0) {
                    imagePaths.forEach(imagePath => {
                        if (fs.existsSync(imagePath)) {
                            fs.unlinkSync(imagePath);
                        }
                    });
                }
            }
        });

        res.json({
            success: true,
            message: `Message scheduled successfully${images.length > 0 ? ` with ${images.length} image(s)` : ''}`,
            task: newTask,
            imageCount: images.length
        });

    } catch (error) {
        console.error('Error scheduling message:', error);
        res.status(500).json({
            error: 'Failed to schedule message',
            details: error.message
        });
    }
});

// Get all scheduled messages
app.get('/api/messages/scheduled', (req, res) => {
    try {
        const scheduleData = loadScheduleData();
        res.json({
            success: true,
            scheduledMessages: scheduleData
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch scheduled messages',
            details: error.message
        });
    }
});

// Delete a scheduled message
app.delete('/api/messages/scheduled/:id', (req, res) => {
    try {
        const { id } = req.params;
        const scheduleData = loadScheduleData();

        const filteredData = scheduleData.filter(task => task.id !== id);

        if (filteredData.length === scheduleData.length) {
            return res.status(404).json({
                error: 'Scheduled message not found'
            });
        }

        saveScheduleData(filteredData);

        res.json({
            success: true,
            message: 'Scheduled message deleted successfully'
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to delete scheduled message',
            details: error.message
        });
    }
});

// Get available groups
app.get('/api/groups', async (req, res) => {
    try {
        if (!isClientReady) {
            return res.status(503).json({
                error: 'WhatsApp client is not ready'
            });
        }

        const chats = await client.getChats();
        const groups = chats
            .filter(chat => chat.isGroup)
            .map(group => ({
                id: group.id._serialized,
                name: group.name,
                participantCount: group.participants ? group.participants.length : 0
            }));

        res.json({
            success: true,
            groups
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch groups',
            details: error.message
        });
    }
});

// Promote bot to admin in all groups where user is admin
app.post('/api/groups/promote-bot', async (req, res) => {
    try {
        if (!isClientReady) {
            return res.status(503).json({
                error: 'WhatsApp client is not ready'
            });
        }

        const currentUser = client.info.wid._serialized;
        const chats = await client.getChats();
        const groups = chats.filter(chat => chat.isGroup);

        const results = [];
        const botId = client.info.wid._serialized;

        for (const group of groups) {
            try {
                // Check if current user is admin in this group
                const isAdmin = await isUserAdmin(client, group, currentUser);

                if (isAdmin) {
                    // Get participants to check if bot is already admin
                    const participants = await group.getParticipants();
                    const botParticipant = participants.find(p => p.id._serialized === botId);

                    if (botParticipant && (botParticipant.isAdmin || botParticipant.isSuperAdmin)) {
                        results.push({
                            groupName: group.name,
                            status: 'already_admin',
                            message: 'Bot is already an admin'
                        });
                    } else if (botParticipant) {
                        // Promote bot to admin
                        await group.promoteParticipants([botId]);
                        results.push({
                            groupName: group.name,
                            status: 'promoted',
                            message: 'Bot promoted to admin successfully'
                        });
                    } else {
                        results.push({
                            groupName: group.name,
                            status: 'not_member',
                            message: 'Bot is not a member of this group'
                        });
                    }
                } else {
                    results.push({
                        groupName: group.name,
                        status: 'no_permission',
                        message: 'You are not an admin in this group'
                    });
                }
            } catch (error) {
                results.push({
                    groupName: group.name,
                    status: 'error',
                    message: `Failed to promote: ${error.message}`
                });
            }
        }

        const promoted = results.filter(r => r.status === 'promoted').length;
        const alreadyAdmin = results.filter(r => r.status === 'already_admin').length;

        res.json({
            success: true,
            message: `Promotion complete: ${promoted} groups promoted, ${alreadyAdmin} already admin`,
            results,
            summary: {
                promoted,
                alreadyAdmin,
                total: results.length
            }
        });

    } catch (error) {
        console.error('Error promoting bot to admin:', error);
        res.status(500).json({
            error: 'Failed to promote bot to admin',
            details: error.message
        });
    }
});

// Add file upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    res.json({
        message: 'File uploaded successfully',
        filename: req.file.filename,
        path: req.file.path
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        error: 'Internal server error',
        details: error.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 API Server running on port ${PORT}`);
    console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;