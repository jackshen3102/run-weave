// Request conversion adapted from @earendil-works/pi-ai 0.87.1 (MIT).
// Upstream: packages/ai/src/api/openai-codex-responses.ts; see THIRD_PARTY_LICENSE.
import { getSystemMessageText } from '@earendil-works/pi-ai/utils/text';
import { getDeclaredTools, getInitialSystemMessage, resolveTranscriptTools } from '@earendil-works/pi-ai/utils/transcript';
import { createGrammarToolInputProperties } from '@earendil-works/pi-ai/api/constrained-sampling';
import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
const CODEX_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode']);
export function buildRequestBody(model, context, options, cacheSessionId, grammarToolInputProperties = createGrammarToolInputProperties(getDeclaredTools(context.messages), model.compat?.supportsOpenAIGrammarTools ?? false)) {
    const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
    const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
    const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
    const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
    const transcriptTools = resolveTranscriptTools(context.messages, supportsAdditionalTools || supportsToolSearch);
    const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
        includeSystemPrompt: false,
        grammarToolInputProperties,
        supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
        supportsAdditionalTools,
        supportsToolSearch,
        toolOptions: {
            strict: null,
            supportsStrictMode,
            supportsOpenAIGrammarTools,
        },
    });
    const initialSystemMessage = getInitialSystemMessage(context.messages);
    const instructions = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
    const body = {
        model: model.id,
        store: false,
        stream: true,
        instructions: instructions || "You are a helpful assistant.",
        input: messages,
        text: { verbosity: options?.textVerbosity || "low" },
        include: ["reasoning.encrypted_content"],
        prompt_cache_key: cacheSessionId,
        tool_choice: options?.toolChoice ?? "auto",
        parallel_tool_calls: true,
    };
    if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
    }
    if (options?.serviceTier !== undefined) {
        body.service_tier = options.serviceTier;
    }
    if (transcriptTools.requestTools.length > 0) {
        body.tools = convertResponsesTools(transcriptTools.requestTools, {
            strict: null,
            supportsStrictMode,
            supportsOpenAIGrammarTools,
        });
    }
    if (options?.reasoningEffort !== undefined) {
        const effort = options.reasoningEffort === "none"
            ? model.thinkingLevelMap?.off === undefined
                ? "none"
                : model.thinkingLevelMap.off
            : (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
        if (effort !== null) {
            body.reasoning = {
                effort,
                summary: options.reasoningSummary ?? "auto",
            };
        }
    }
    else if (model.reasoning && model.thinkingLevelMap?.off !== null) {
        body.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
    }
    return body;
}
