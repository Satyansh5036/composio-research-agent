import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { Composio } from '@composio/core';

const { GEMINI_API_KEY, COMPOSIO_API_KEY } = process.env;

async function testGemini() {
    if (!GEMINI_API_KEY) {
        console.log('❌ GEMINI_API_KEY missing from .env');
        return false;
    }
    try {
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: 'Reply with exactly one word: "connected"',
        });
        console.log('✅ Gemini connected. Response:', response.text.trim());
        return true;
    } catch (err) {
        console.log('❌ Gemini call failed:', err.message);
        return false;
    }
}

async function testGeminiSearch() {
    try {
        const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: 'What auth method does the Stripe API use? One sentence, cite the source.',
            config: { tools: [{ googleSearch: {} }] },
        });
        console.log('✅ Gemini + Google Search grounding works. Sample answer:');
        console.log('   ', response.text.trim().slice(0, 200));
        return true;
    } catch (err) {
        console.log('❌ Gemini search grounding failed:', err.message);
        return false;
    }
}

async function testComposio() {
    if (!COMPOSIO_API_KEY) {
        console.log('❌ COMPOSIO_API_KEY missing from .env');
        return false;
    }
    try {
        const composio = new Composio({ apiKey: COMPOSIO_API_KEY });
        // authConfigs.list is a lightweight, confirmed-stable auth check
        const configs = await composio.authConfigs.list({ limit: 3 });
        console.log('✅ Composio connected. Auth configs found:', configs?.items?.length ?? 0);
        return true;
    } catch (err) {
        console.log('❌ Composio call failed:', err.message);
        return false;
    }
}

async function main() {
    console.log('Testing connections...\n');
    const geminiOk = await testGemini();
    const searchOk = geminiOk ? await testGeminiSearch() : false;
    const composioOk = await testComposio();

    console.log('\n--- Summary ---');
    console.log('Gemini API:', geminiOk ? 'OK' : 'FAILED');
    console.log('Gemini + Search grounding:', searchOk ? 'OK' : 'FAILED');
    console.log('Composio API:', composioOk ? 'OK' : 'FAILED');

    if (geminiOk && searchOk) {
        console.log('\nYou can build the research pipeline on Gemini + Search grounding alone.');
        console.log('Composio is optional plumbing on top — good for the "used Composio SDK" story, not required for the research itself.');
    }
}

main();