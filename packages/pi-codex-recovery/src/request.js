// Request conversion adapted from @earendil-works/pi-ai 0.85.1 (MIT).
// Upstream: packages/ai/src/api/openai-codex-responses.ts; see THIRD_PARTY_LICENSE.
import { splitDeferredTools } from '@earendil-works/pi-ai/utils/deferred-tools';
import { createGrammarToolInputProperties } from '@earendil-works/pi-ai/api/constrained-sampling';
import { convertResponsesMessages, convertResponsesTools } from '@earendil-works/pi-ai/api/openai-responses-shared';
const CODEX_TOOL_CALL_PROVIDERS = new Set(['openai', 'openai-codex', 'opencode']);
export function buildRequestBody(model, context, options, cacheSessionId, grammarToolInputProperties = createGrammarToolInputProperties(context.tools, model.compat?.supportsOpenAIGrammarTools ?? false)) {
    const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
    const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
    const deferredToolsMode = model.compat?.supportsAdditionalTools
        ? "additional-tools"
        : model.compat?.supportsToolSearch
            ? "tool-search"
            : undefined;
    const toolPlacement = splitDeferredTools(context, deferredToolsMode !== undefined);
    const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
        includeSystemPrompt: false,
        grammarToolInputProperties,
        deferredTools: toolPlacement.deferred,
        deferredToolsMode,
        toolOptions: {
            strict: null,
            supportsStrictMode,
            supportsOpenAIGrammarTools,
        },
    });
    const body = {
        model: model.id,
        store: false,
        stream: true,
        instructions: context.systemPrompt || "You are a helpful assistant.",
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
    if (toolPlacement.immediate.length > 0) {
        body.tools = convertResponsesTools(toolPlacement.immediate, {
            strict: null,
            supportsStrictMode,
            supportsOpenAIGrammarTools,
        });
    }
    if (options?.reasoningEffort !== undefined) {
        const effort = options.reasoningEffort === "none"
            ? (model.thinkingLevelMap?.off ?? "none")
            : (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
        if (effort !== null) {
            body.reasoning = {
                effort,
                summary: options.reasoningSummary ?? "auto",
            };
        }
    }
    return body;
}
