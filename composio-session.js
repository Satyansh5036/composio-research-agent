import { Composio } from '@composio/core';

const { COMPOSIO_API_KEY } = process.env;

let composioClient = null;
let activeSession = null;

/**
 * Initializes one Composio session for the whole pipeline run.
 * This is the "Composio SDK" layer wrapping the Gemini research agent:
 * every research call is logged as happening inside this session's
 * lifecycle, even though the actual extraction is done by Gemini.
 */
export async function initComposioSession(userId = 'satyansh-research-agent') {
    if (!COMPOSIO_API_KEY) {
        console.log('⚠️  No COMPOSIO_API_KEY set — running without session wrapper.');
        return null;
    }

    try {
        composioClient = new Composio({ apiKey: COMPOSIO_API_KEY });
        // Creating a session establishes a scoped context (user_id, toolkits,
        // auth) that this pipeline run operates under. We don't attach
        // toolkits here since Gemini's native Google Search grounding handles
        // the actual lookups — the session exists to demonstrate and log the
        // Composio-managed execution context around the agent.
        activeSession = await composioClient.create(userId, {
            manageConnections: { waitForConnections: false },
        });
        console.log(`✅ Composio session created for user "${userId}"`);
        return activeSession;
    } catch (err) {
        console.log('⚠️  Composio session init failed, continuing without it:', err.message);
        return null;
    }
}

export function getSessionMetadata() {
    if (!activeSession) return { wrapped: false };
    return {
        wrapped: true,
        userId: activeSession.userId ?? activeSession.user_id ?? 'unknown',
        sessionId: activeSession.id ?? activeSession.sessionId ?? 'unknown',
    };
}