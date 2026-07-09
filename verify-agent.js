import 'dotenv/config';
import fs from 'fs';
import { apps, categories } from './apps-data.js';
import { groundedResearchCall, extractJsonArray, sleep } from './gemini-client.js';

const RESULTS_PATH = './results.json';
const VERIFICATION_PATH = './verification.json';
const HAND_CHECK_TEMPLATE_PATH = './hand-check-template.md';
const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES_MS = 6000;

function pickStratifiedSample(n = 2) {
    const sample = [];
    for (const cat of categories) {
        const inCat = apps.filter((a) => a.category === cat);
        const shuffled = [...inCat].sort(() => Math.random() - 0.5);
        sample.push(...shuffled.slice(0, n));
    }
    return sample;
}

function buildBatchVerifyPrompt(batch, resultsById) {
    const claims = batch
        .map((app) => {
            const a = resultsById.get(app.id);
            return `- id ${app.id}: "${app.name}" (${app.hint}). Claim: authMethods=${JSON.stringify(a.authMethods)}, selfServe=${a.selfServe}, gateType="${a.gateType}", mcpExists=${a.mcpExists}, verdict="${a.verdict}"`;
        })
        .join('\n');

    return `Independently verify these claims by searching each app's official
developer docs yourself — do not assume any claim below is correct.

${claims}

Respond with ONLY a JSON array, one object per app above, in the same order:
{
  "id": <matching id>,
  "agreesWithClaim": true or false,
  "yourAuthMethods": ["..."],
  "yourSelfServe": true or false,
  "yourGateType": "...",
  "yourMcpExists": true or false,
  "yourVerdict": "ready today" | "possible with workaround" | "blocked",
  "discrepancyNotes": "brief note on what differs, or null if it matches",
  "evidenceUrl": "the docs URL you checked"
}`;
}

function fieldsMatch(agentA, agentB) {
    const setEq = (a, b) => {
        const sa = new Set((a || []).map((x) => String(x).toLowerCase()));
        const sb = new Set((b || []).map((x) => String(x).toLowerCase()));
        if (sa.size !== sb.size) return false;
        for (const v of sa) if (!sb.has(v)) return false;
        return true;
    };
    return {
        authMethods: setEq(agentA.authMethods, agentB.yourAuthMethods),
        selfServe: agentA.selfServe === agentB.yourSelfServe,
        mcpExists: agentA.mcpExists === agentB.yourMcpExists,
        verdict: agentA.verdict === agentB.yourVerdict,
    };
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function main() {
    if (!fs.existsSync(RESULTS_PATH)) {
        console.log('❌ results.json not found — run `npm run research` first.');
        return;
    }
    const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
    const resultsById = new Map(results.map((r) => [r.id, r]));

    const fullSample = pickStratifiedSample(2); // 2 per category = 20 apps
    const sample = fullSample.filter((app) => {
        const r = resultsById.get(app.id);
        return r && !r.error;
    });

    if (sample.length < fullSample.length) {
        console.log(`Note: ${fullSample.length - sample.length} sampled apps have no valid first-pass result yet, skipping those.`);
    }
    console.log(`Verifying ${sample.length} apps in batches of ${BATCH_SIZE}...\n`);

    const verification = [];
    const batches = chunk(sample, BATCH_SIZE);

    for (const [i, batch] of batches.entries()) {
        console.log(`Verification batch ${i + 1}/${batches.length}: ${batch.map((a) => a.name).join(', ')}`);
        try {
            const { json, rawText } = await groundedResearchCall(buildBatchVerifyPrompt(batch, resultsById));
            const arr = Array.isArray(json) ? json : extractJsonArray(rawText || '');
            if (!arr) {
                console.log('   ⚠️  Could not parse verification batch response, skipping batch.');
                continue;
            }
            const byId = new Map(arr.map((r) => [r.id, r]));
            for (const app of batch) {
                const agentAResult = resultsById.get(app.id);
                const agentB = byId.get(app.id);
                if (!agentB) {
                    console.log(`   ⚠️  [${app.id}] ${app.name}: missing from verification response`);
                    continue;
                }
                const matches = fieldsMatch(agentAResult, agentB);
                const allMatch = Object.values(matches).every(Boolean);
                verification.push({
                    id: app.id,
                    name: app.name,
                    category: app.category,
                    agentA: {
                        authMethods: agentAResult.authMethods,
                        selfServe: agentAResult.selfServe,
                        mcpExists: agentAResult.mcpExists,
                        verdict: agentAResult.verdict,
                        evidenceUrl: agentAResult.evidenceUrl,
                    },
                    agentB,
                    fieldMatches: matches,
                    overallMatch: allMatch,
                });
                console.log(`   ${allMatch ? '✅ agrees' : '⚠️  discrepancy'} — ${app.name}`);
            }
        } catch (err) {
            if (err.isDailyQuota) {
                console.log('\n🛑 Hit the daily free-tier quota during verification. Progress saved so far.');
                break;
            }
            console.log(`   ❌ Batch failed: ${err.message}`);
        }
        await sleep(DELAY_BETWEEN_BATCHES_MS);
    }

    fs.writeFileSync(VERIFICATION_PATH, JSON.stringify(verification, null, 2));

    const agreeCount = verification.filter((v) => v.overallMatch).length;
    const firstPassAccuracy = verification.length ? ((agreeCount / verification.length) * 100).toFixed(1) : 'n/a';
    console.log(`\nAgent-vs-agent agreement: ${agreeCount}/${verification.length} (${firstPassAccuracy}%)`);
    console.log(`Saved to ${VERIFICATION_PATH}`);

    const templateRows = verification
        .map(
            (v) => `| ${v.name} | ${v.category} | ${v.agentA.verdict} | ${v.agentB.yourVerdict} | ${v.overallMatch ? '✅ agree' : '⚠️ disagree'} | [ ] | |`
        )
        .join('\n');

    const template = `# Hand-Check Sample (${verification.length} apps)

Fill in the "Your check" column after visiting each app's actual docs.
This is the human layer of the verification loop.

| App | Category | Agent A verdict | Agent B verdict | Agents agree? | Your check (✓ if correct) | Your notes |
|---|---|---|---|---|---|---|
${templateRows}

## After filling this in
Count how many rows you marked ✓, divide by ${verification.length}, and that's
your human-verified accuracy — report it alongside the agent-vs-agent
agreement rate of ${firstPassAccuracy}% in the case study.
`;

    fs.writeFileSync(HAND_CHECK_TEMPLATE_PATH, template);
    console.log(`Hand-check template written to ${HAND_CHECK_TEMPLATE_PATH} — fill this in manually.`);
}

main();