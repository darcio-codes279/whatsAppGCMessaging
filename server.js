const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
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
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            headless: true, // Set to false for debugging
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('QR Code received. Please scan with WhatsApp.');
        qrcode.generate(qr, { small: true });
        console.log('Scan the QR code above to log in');
    });

    client.on('ready', () => {
        console.log('✅ WhatsApp Client is ready');
        isClientReady = true;
    });

    client.on('disconnected', (reason) => {
        console.log('❌ Client was logged out:', reason);
        isClientReady = false;
    });

    client.initialize();
};

// Initialize client on startup
initializeClient();

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

// Send immediate message
app.post('/api/messages/send', async (req, res) => {
    try {
        const { groupName, message } = req.body;

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



        console.log('Admin check bypassed for testing')


        // Send the message
        await group.sendMessage(message);

        res.json({
            success: true,
            message: 'Message sent successfully',
            groupName,
            sentAt: new Date().toISOString()
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
app.post('/api/messages/schedule', async (req, res) => {
    try {
        const { groupName, message, cronTime, description, endDate, maxOccurrences } = req.body;

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

        // Validate end date if provided
        let endDateTime = null;
        if (endDate) {
            endDateTime = new Date(endDate);
            if (isNaN(endDateTime.getTime())) {
                return res.status(400).json({
                    error: 'Invalid endDate format. Use ISO string format (e.g., "2024-12-31T23:59:59.000Z")'
                });
            }
            if (endDateTime <= new Date()) {
                return res.status(400).json({
                    error: 'endDate must be in the future'
                });
            }
        }

        // Validate maxOccurrences if provided
        if (maxOccurrences !== undefined && (typeof maxOccurrences !== 'number' || maxOccurrences <= 0)) {
            return res.status(400).json({
                error: 'maxOccurrences must be a positive number'
            });
        }

        // Find the group
        const group = await findGroupByName(client, groupName);
        if (!group) {
            return res.status(404).json({
                error: `Group "${groupName}" not found`
            });
        }

        const currentUser = client.info.wid._serialized;
        console.log(`Logged in as: ${currentUser}`);

        // Load existing schedule data
        const scheduleData = loadScheduleData();

        // Create new scheduled task
        const newTask = {
            id: Date.now().toString(),
            groupName,
            message,
            cron: cronTime,
            description: description || '',
            endDate: endDateTime ? endDateTime.toISOString() : null,
            maxOccurrences: maxOccurrences || null,
            currentOccurrences: 0,
            createdAt: new Date().toISOString(),
            createdBy: currentUser
        };

        // Add to schedule data
        scheduleData.push(newTask);
        saveScheduleData(scheduleData);

        // Schedule the cron job with limits check
        cron.schedule(cronTime, async () => {
            try {
                // Load current schedule data to get updated occurrence count
                const currentScheduleData = loadScheduleData();
                const currentTask = currentScheduleData.find(task => task.id === newTask.id);

                if (!currentTask) {
                    console.log(`⚠️ Scheduled task ${newTask.id} not found, stopping execution`);
                    return;
                }

                // Check if the schedule has expired by end date
                if (endDateTime && new Date() > endDateTime) {
                    console.log(`⏰ Scheduled message for "${groupName}" has expired (end date reached) and will be removed`);
                    const filteredData = currentScheduleData.filter(task => task.id !== newTask.id);
                    saveScheduleData(filteredData);
                    return;
                }

                // Check if max occurrences reached
                if (maxOccurrences && currentTask.currentOccurrences >= maxOccurrences) {
                    console.log(`🔢 Scheduled message for "${groupName}" has reached max occurrences (${maxOccurrences}) and will be removed`);
                    const filteredData = currentScheduleData.filter(task => task.id !== newTask.id);
                    saveScheduleData(filteredData);
                    return;
                }

                const group = await findGroupByName(client, groupName);
                if (group) {
                    await group.sendMessage(message);
                    console.log(`✅ Scheduled message sent to "${groupName}" at ${new Date().toLocaleString()} (occurrence ${currentTask.currentOccurrences + 1}${maxOccurrences ? `/${maxOccurrences}` : ''})`);

                    // Update occurrence count
                    currentTask.currentOccurrences += 1;
                    saveScheduleData(currentScheduleData);
                }
            } catch (error) {
                console.error(`Error sending scheduled message to "${groupName}":`, error.message);
            }
        });

        res.json({
            success: true,
            message: 'Message scheduled successfully',
            task: newTask
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