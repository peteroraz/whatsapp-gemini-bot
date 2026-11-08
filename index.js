const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize the client with sandbox disabled (crucial for DigitalOcean deployment)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

let chatBuffer = [];

// Generates the QR code in your terminal to link the WhatsApp number
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Scan the QR code above with the WhatsApp app on the bot\'s phone.');
});

client.on('ready', () => {
    console.log('Bot is successfully connected and listening.');
});

client.on('message', async msg => {
    const chat = await msg.getChat();
    
    // Ensure the bot only operates inside groups
    if (chat.isGroup) {
        // 1. Passively read and store the chat in the buffer
        const sender = msg.author || msg.from;
        chatBuffer.push(`${sender}: ${msg.body}`);
        
        // Keep the buffer strictly to the last 200 messages to avoid overloading Gemini
        if (chatBuffer.length > 200) chatBuffer.shift();

        // 2. Drop its own chat if the trigger phrase is used
        if (msg.body === '!summarize') {
            // Acknowledge the command so the group knows it is working
            await chat.sendMessage('Processing the latest messages, please wait...');

            try {
                const prompt = `Extract any action items, financial approvals, and event announcements from this raw chat log:\n\n${chatBuffer.join('\n')}`;
                
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: prompt
                });

                // Reply to the group with the formatted Gemini extraction
                await chat.sendMessage(response.text);
                
                // Clear the buffer after a successful summary
                chatBuffer = []; 
            } catch (error) {
                await chat.sendMessage('An error occurred while contacting Google AI Studio.');
            }
        }
    }
});

client.initialize();