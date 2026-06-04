// ==================== IMPORTS ====================
const { default: makeWASocket, useSingleFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const Pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

// ==================== CONFIG ====================
const { state, saveState } = useSingleFileAuthState('./auth_info.json');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Prefix for commands
const PREFIX = process.env.PREFIX || '.';

// ==================== PLUGINS LOADER ====================
const commands = new Map();

function loadPlugins() {
    const pluginsPath = path.join(__dirname, 'plugins');
    if (!fs.existsSync(pluginsPath)) {
        console.log('⚠️ Plugins folder not found!');
        return;
    }

    const pluginFiles = fs.readdirSync(pluginsPath).filter(file => file.endsWith('.js'));
    
    for (const file of pluginFiles) {
        try {
            const plugin = require(`./plugins/${file}`);
            if (plugin.cmd && plugin.pattern) {
                commands.set(plugin.pattern, plugin);
                console.log(`✅ Loaded: ${plugin.pattern} (${plugin.category || 'general'})`);
            } else if (plugin.name || plugin.pattern) {
                const pattern = plugin.pattern || plugin.name;
                commands.set(pattern, plugin);
                console.log(`✅ Loaded: ${pattern}`);
            }
        } catch (err) {
            console.log(`❌ Failed to load ${file}:`, err.message);
        }
    }
    console.log(`\n📦 Total ${commands.size} commands loaded!\n`);
}

// ==================== WHATSAPP CONNECTION ====================
let sock;
let pairingCodeRequest = null;

async function connectToWhatsApp() {
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: !process.env.PAIRING_MODE,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        logger: Pino({ level: 'silent' }),
        getPairingCode: process.env.PAIRING_MODE === 'true' || true,
        version: [2, 3000, 1015901307],
    });

    // Save auth on updates
    sock.ev.on('creds.update', saveState);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, pairingCode, qr } = update;
        
        if (pairingCode && !process.env.PAIRING_DONE) {
            console.log(`\n🔐 PAIRING CODE: ${pairingCode}\n`);
            if (global.pairingCodeCallback) {
                global.pairingCodeCallback(pairingCode);
            }
        }

        if (qr && !process.env.PAIRING_MODE) {
            console.log(`\n📱 SCAN QR CODE:\n${qr}\n`);
        }

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.log('❌ Session logged out! Delete auth_info.json and restart.');
                process.exit(1);
            } else {
                console.log('🔄 Reconnecting in 5 seconds...');
                setTimeout(() => connectToWhatsApp(), 5000);
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Bot Connected Successfully!');
            console.log(`📱 Bot is ready! Use ${PREFIX}help for commands.\n`);
        }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message) return;
        
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     '';
        
        // Ignore empty messages
        if (!text) return;
        
        // Check if message starts with prefix
        if (!text.startsWith(PREFIX)) return;
        
        // Extract command and args
        const cmdBody = text.slice(PREFIX.length).trim();
        const commandName = cmdBody.split(' ')[0].toLowerCase();
        const args = cmdBody.slice(commandName.length).trim();
        
        // Find command
        let command = commands.get(commandName);
        if (!command) {
            // Check for aliases
            for (const [name, cmd] of commands) {
                if (cmd.aliases && cmd.aliases.includes(commandName)) {
                    command = cmd;
                    break;
                }
            }
        }
        
        if (command) {
            try {
                // Check group permissions
                let isBotAdmins = false;
                let isAdmins = false;
                
                if (isGroup) {
                    const groupMetadata = await sock.groupMetadata(from);
                    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    const senderId = msg.key.participant || msg.key.remoteJid;
                    
                    isBotAdmins = groupMetadata.participants.some(p => p.id === botId && p.admin);
                    isAdmins = groupMetadata.participants.some(p => p.id === senderId && p.admin);
                }
                
                // Execute command
                await command.cmd(sock, msg, args, {
                    from,
                    isGroup,
                    isBotAdmins,
                    isAdmins,
                    reply: (text) => sock.sendMessage(from, { text }),
                    sender: msg.key.participant || msg.key.remoteJid,
                    pushName: msg.pushName,
                    args
                });
            } catch (err) {
                console.error('Command error:', err);
                await sock.sendMessage(from, { text: '❌ Command execution failed!' });
            }
        }
    });
    
    return sock;
}

// ==================== WEBSITE ROUTES (Pairing System) ====================

// Home page - Pairing form
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp Bot Pairing</title>
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    background: linear-gradient(135deg, #075E54, #128C7E);
                    min-height: 100vh;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    padding: 20px;
                }
                .container {
                    background: white;
                    border-radius: 30px;
                    padding: 40px 30px;
                    max-width: 450px;
                    width: 100%;
                    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                    text-align: center;
                }
                h1 {
                    color: #075E54;
                    margin-bottom: 10px;
                    font-size: 28px;
                }
                .sub {
                    color: #666;
                    margin-bottom: 30px;
                    font-size: 14px;
                }
                input {
                    width: 100%;
                    padding: 15px;
                    margin: 10px 0;
                    border: 2px solid #ddd;
                    border-radius: 50px;
                    font-size: 16px;
                    outline: none;
                    transition: all 0.3s;
                }
                input:focus {
                    border-color: #25D366;
                }
                button {
                    width: 100%;
                    padding: 15px;
                    background: #25D366;
                    color: white;
                    border: none;
                    border-radius: 50px;
                    font-size: 18px;
                    font-weight: bold;
                    cursor: pointer;
                    margin-top: 10px;
                    transition: transform 0.2s;
                }
                button:hover {
                    transform: scale(1.02);
                    background: #128C7E;
                }
                .code-box {
                    margin-top: 25px;
                    padding: 20px;
                    background: #f0f0f0;
                    border-radius: 15px;
                    display: none;
                }
                .code-box.show {
                    display: block;
                    animation: fadeIn 0.5s;
                }
                .code {
                    font-size: 32px;
                    font-weight: bold;
                    letter-spacing: 5px;
                    color: #075E54;
                    background: white;
                    padding: 15px;
                    border-radius: 10px;
                    margin: 10px 0;
                    font-family: monospace;
                }
                .error {
                    color: #e74c3c;
                    margin-top: 10px;
                }
                .loading {
                    display: inline-block;
                    width: 20px;
                    height: 20px;
                    border: 3px solid #f3f3f3;
                    border-top: 3px solid #25D366;
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    margin-left: 10px;
                    vertical-align: middle;
                }
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(-10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .footer {
                    margin-top: 20px;
                    font-size: 12px;
                    color: #999;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🤖 WhatsApp Bot</h1>
                <div class="sub">Enter your number to get pairing code</div>
                <input type="text" id="number" placeholder="+92XXXXXXXXXX" autocomplete="off">
                <button onclick="getPairingCode()">Get Code</button>
                <div id="result" class="code-box"></div>
                <div class="footer">⚠️ Use country code without spaces or symbols</div>
            </div>

            <script>
                async function getPairingCode() {
                    const number = document.getElementById('number').value;
                    const resultDiv = document.getElementById('result');
                    
                    if (!number) {
                        resultDiv.innerHTML = '<div class="error">❌ Please enter your number!</div>';
                        resultDiv.classList.add('show');
                        return;
                    }
                    
                    resultDiv.innerHTML = '<div>Getting code... <span class="loading"></span></div>';
                    resultDiv.classList.add('show');
                    
                    try {
                        const response = await fetch('/request-code', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ number: number })
                        });
                        
                        const data = await response.json();
                        
                        if (data.success) {
                            resultDiv.innerHTML = \`
                                <div style="color: #27ae60;">✅ Code Sent!</div>
                                <div class="code">\${data.code || 'Check WhatsApp'}</div>
                                <div style="font-size: 14px; margin-top: 10px;">Enter this code in WhatsApp Linked Devices</div>
                            \`;
                        } else {
                            resultDiv.innerHTML = \`<div class="error">❌ \${data.message}</div>\`;
                        }
                    } catch (error) {
                        resultDiv.innerHTML = '<div class="error">❌ Failed to get code. Is bot running?</div>';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// API endpoint for pairing code request
app.post('/request-code', async (req, res) => {
    const { number } = req.body;
    
    if (!number) {
        return res.json({ success: false, message: 'Number is required!' });
    }
    
    // Clean number
    let cleanNumber = number.replace(/[^0-9+]/g, '');
    if (!cleanNumber.startsWith('+')) {
        cleanNumber = '+' + cleanNumber;
    }
    
    try {
        if (!sock) {
            return res.json({ success: false, message: 'Bot is not connected yet!' });
        }
        
        // Request pairing code
        let codeReceived = null;
        
        const codePromise = new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 30000);
            
            const handler = (code) => {
                clearTimeout(timeout);
                resolve(code);
            };
            
            global.pairingCodeCallback = handler;
            
            // Listen for pairing code event
            sock.ev.on('connection.update', async (update) => {
                if (update.pairingCode) {
                    handler(update.pairingCode);
                }
            });
        });
        
        // Request the code
        await sock.requestPairingCode(cleanNumber);
        
        const code = await codePromise;
        
        if (code) {
            return res.json({ success: true, code: code, message: 'Code sent successfully!' });
        } else {
            return res.json({ success: false, message: 'Timeout! Please try again.' });
        }
    } catch (error) {
        console.error('Pairing error:', error);
        return res.json({ success: false, message: error.message || 'Failed to get pairing code' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        botConnected: sock ? true : false,
        commands: commands.size,
        timestamp: new Date().toISOString()
    });
});

// ==================== START SERVER & BOT ====================
async function start() {
    // Load all plugins
    loadPlugins();
    
    // Start Express server
    app.listen(PORT, () => {
        console.log(`\n🌐 Website running on: http://localhost:${PORT}`);
        console.log(`📱 Open this URL to get pairing code!\n`);
    });
    
    // Connect to WhatsApp
    await connectToWhatsApp();
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n⚠️ Shutting down...');
    if (sock) await sock.logout();
    process.exit(0);
});

// Start everything
start().catch(console.error);
