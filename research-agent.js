import 'dotenv/config';
import fs from 'fs';
import { apps } from './apps-data.js';
import { groundedResearchCall, extractJsonArray, sleep } from './gemini-client.js';
import { initComposioSession, getSessionMetadata } from './composio-session.js';

const RESULTS_PATH = './results.json';
const BATCH_SIZE = 10; // 100 apps / 10 per call = 10 calls total
const DELAY_BETWEEN_BATCHES_MS = 6000;

function buildBatchPrompt(batch) {
    const appList = batch
        .map((a) => `- id ${a.id}: "${a.name}" (${a.hint}), category: ${a.category}`)
        .join('\n');

    return `You are researching developer-facing apps to assess whether each could
become an AI-agent toolkit. For EACH app below, search for its official
developer/API documentation and determine the facts.

Apps to research:
${appList}

Respond with ONLY a single JSON array (no other text), containing exactly
one object per app above, in this order, each with exactly these fields:

{
  "id": <the app's id number, must match input>,
  "oneLiner": "one sentence describing what the product does",
  "authMethods": ["OAuth2" | "API Key" | "Basic" | "Token" | "Other", ...],
  "selfServe": true or false,
  "gateType": "free self-serve" | "free tier + paid upgrade" | "paid plan required" | "partner/contact-sales gated" | "admin approval required",
  "apiSurface": "brief description: REST/GraphQL, roughly how broad",
  "mcpExists": true or false,
  "verdict": "ready today" | "possible with workaround" | "blocked",
  "blocker": "the main blocker if not ready today, else null",
  "evidenceUrl": "the specific docs URL you found this on",
  "confidence": "high" | "medium" | "low"
}

Search for each app individually — do not guess from memory alone. If you
are not confident about a field for a given app, set its confidence to
"low" or "medium" rather than guessing high. Return exactly ${batch.length}
objects, one per app, in the same order as the input list.`;
}

async function loadExistingResults() {
    if (fs.existsSync(RESULTS_PATH)) {
        try {
            return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
        } catch {
            return [];
        }
    }
    return [];
}

function saveResults(results) {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function main() {
    console.log('Starting batched research pipeline...\n');
    await initComposioSession();
    console.log('Composio session metadata:', getSessionMetadata(), '\n');

    let results = await loadExistingResults();
    const doneIds = new Set(results.map((r) => r.id));
    const remaining = apps.filter((a) => !doneIds.has(a.id));

    console.log(`${results.length}/${apps.length} apps already done. ${remaining.length} remaining.\n`);

    if (remaining.length === 0) {
        console.log('All apps already researched. Run `npm run verify` next.');
        return;
    }

    const batches = chunk(remaining, BATCH_SIZE);
    console.log(`Processing in ${batches.length} batch(es) of up to ${BATCH_SIZE} apps each.\n`);

    for (const [batchIndex, batch] of batches.entries()) {
        const names = batch.map((a) => a.name).join(', ');
        console.log(`Batch ${batchIndex + 1}/${batches.length}: ${names}`);

        try {
            const { json: batchResults, rawText } = await groundedResearchCall(buildBatchPrompt(batch));
            const arr = Array.isArray(batchResults) ? batchResults : extractJsonArray(rawText || '');

            if (!arr) {
                console.log('   ⚠️  Could not parse batch response as JSON array. Logging apps as errors for manual review.');
                for (const app of batch) {
                    results.push({
                        id: app.id,
                        name: app.name,
                        hint: app.hint,
                        category: app.category,
                        error: 'Batch JSON parse failed',
                        rawTextSample: (rawText || '').slice(0, 300),
                        researchedAt: new Date().toISOString(),
                    });
                }
            } else {
                const byId = new Map(arr.map((r) => [r.id, r]));
                for (const app of batch) {
                    const r = byId.get(app.id);
                    if (r) {
                        results.push({
                            id: app.id,
                            name: app.name,
                            hint: app.hint,
                            category: app.category,
                            ...r,
                            researchedAt: new Date().toISOString(),
                        });
                        console.log(`   ✅ [${app.id}] ${app.name}: ${r.verdict ?? 'unknown verdict'}`);
                    } else {
                        results.push({
                            id: app.id,
                            name: app.name,
                            hint: app.hint,
                            category: app.category,
                            error: 'Missing from batch response',
                            researchedAt: new Date().toISOString(),
                        });
                        console.log(`   ⚠️  [${app.id}] ${app.name}: missing from response`);
                    }
                }
            }
        } catch (err) {
            if (err.isDailyQuota) {
                console.log('\n🛑 Hit the daily free-tier quota. This is a hard daily cap, not a bug — retrying won\'t help.');
                console.log(`   Progress saved: ${results.length}/${apps.length} apps done.`);
                console.log('   Quota resets at midnight Pacific Time (~12:30 PM IST). Re-run `npm run research` after that — it will resume from here.');
                saveResults(results);
                return;
            }
            console.log(`   ❌ Batch failed: ${err.message}`);
            for (const app of batch) {
                results.push({
                    id: app.id,
                    name: app.name,
                    hint: app.hint,
                    category: app.category,
                    error: err.message,
                    researchedAt: new Date().toISOString(),
                });
            }
        }

        saveResults(results);
        await sleep(DELAY_BETWEEN_BATCHES_MS);
    }

    console.log(`\nDone. ${results.length}/${apps.length} apps processed. Results saved to ${RESULTS_PATH}`);
    const failed = results.filter((r) => r.error);
    if (failed.length) {
        console.log(`⚠️  ${failed.length} apps need attention:`, failed.map((f) => f.name).join(', '));
    }
}

main();