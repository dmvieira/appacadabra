#!/usr/bin/env node
// Usage: npm run vision:check "<question>"
// Busca GEMINI_API_KEY via Firebase Secrets automaticamente (ou env var como fallback)
// Requires: firebase CLI logado, adb on PATH

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

const question = process.argv[2];
if (!question) {
    console.error('Usage: npm run vision:check "<question>"');
    process.exit(1);
}

let apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    try {
        apiKey = execSync('firebase functions:secrets:access GEMINI_API_KEY', { encoding: 'utf-8' }).trim();
    } catch (e) {
        console.error('Não foi possível obter GEMINI_API_KEY. Execute: firebase login');
        process.exit(1);
    }
}

const tmpPath = path.join(require('os').tmpdir(), 'appacadabra_screen.png');

try {
    execSync('adb shell screencap -p /sdcard/appacadabra_screen.png', { stdio: 'pipe' });
    execSync(`adb pull /sdcard/appacadabra_screen.png "${tmpPath}"`, { stdio: 'pipe' });
} catch (e) {
    console.error('adb screencap falhou — device conectado e app aberto?');
    process.exit(1);
}

const imageData = fs.readFileSync(tmpPath).toString('base64');
const client = new GoogleGenAI({ apiKey });

(async () => {
    const response = await client.models.generateContent({
        model: 'models/gemini-3-flash-preview',
        contents: [{
            parts: [
                { inlineData: { mimeType: 'image/png', data: imageData } },
                { text: `This is a screenshot of the Appacadabra Android app. ${question} Answer YES or NO, then explain briefly.` }
            ]
        }]
    });
    console.log('\n--- Vision Check Result ---');
    console.log(response.text);
    fs.unlinkSync(tmpPath);
})();
