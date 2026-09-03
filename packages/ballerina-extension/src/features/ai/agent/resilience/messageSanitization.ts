/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { AssistantModelMessage, ModelMessage } from 'ai';

/**
 * Repair passes that keep a model-message history provider-valid before it is sent to Anthropic.
 * `sanitizeMessages` is the single entry point; individual repairs compose under it, so new failure
 * modes can be handled by adding a pass rather than touching call sites.
 *
 * Every pass is copy-on-write: only the messages it has to change are copied, and the input array
 * and its objects are never mutated. Replayed history is handed out by reference from the chat
 * store, so writing into it here would silently edit persisted state.
 */

type AssistantPart = Exclude<AssistantModelMessage['content'], string>[number];

export interface SanitizedHistory {
    messages: ModelMessage[];
    /** Tool calls whose arguments had to be replaced with `{}` — each one a call that never ran. */
    repaired: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * When a streamed tool call's JSON is invalid — most often truncated at the output-token cap on a
 * large file write — the AI SDK keeps the raw text as a string on the `tool-call` part. When it
 * parses but fails the tool's schema, the SDK keeps the parsed value instead, so an array, `null`
 * or a number can arrive here too. Anthropic requires `tool_use.input` to be an object and rejects
 * replay with `tool_use.input: Input should be an object`, which bricks the thread on every later
 * request. Either way the SDK ran nothing for the call.
 */
function coerceInput(raw: unknown): Record<string, unknown> {
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw);
            if (isPlainObject(parsed)) {
                return parsed;
            }
        } catch {
            // unparseable
        }
    }
    return {};
}

function repairAssistantMessage(
    message: AssistantModelMessage
): { message: AssistantModelMessage; toolNames: string[] } | undefined {
    if (typeof message.content === 'string') {
        return undefined;
    }
    const toolNames: string[] = [];
    const content: AssistantPart[] = message.content.map((part) => {
        if (part.type !== 'tool-call' || isPlainObject(part.input)) {
            return part;
        }
        toolNames.push(part.toolName);
        return { ...part, input: coerceInput(part.input) };
    });
    return toolNames.length > 0 ? { message: { ...message, content }, toolNames } : undefined;
}

/**
 * Follows the idiom `getChatHistoryForLLM` uses for interrupted generations: the coerced call now
 * reads as a real call made with no arguments, so the model is told outright that it never ran.
 */
function droppedArgumentsReminder(toolNames: string[]): ModelMessage {
    const calls = toolNames.map((name) => `\`${name}\``).join(', ');
    const plural = toolNames.length > 1;
    return {
        role: 'user',
        content:
            `<system-reminder>\n` +
            `The arguments of the earlier ${calls} tool call${plural ? 's' : ''} could not be read ` +
            `(the output was cut off or malformed) and were replaced with an empty object. ` +
            `${plural ? 'Those calls were' : 'That call was'} NOT performed — redo ` +
            `${plural ? 'them' : 'it'} if still required.\n` +
            `</system-reminder>`,
    };
}

/** Coerce every non-object tool-call input to an object, and flag each such call to the model. */
export function repairToolCallInputs(messages: readonly ModelMessage[] | null | undefined): SanitizedHistory {
    const source = messages ?? [];
    const out: ModelMessage[] = [];
    let repaired = 0;
    for (let i = 0; i < source.length; i++) {
        const message = source[i];
        const repair = message.role === 'assistant' ? repairAssistantMessage(message) : undefined;
        if (!repair) {
            out.push(message);
            continue;
        }
        repaired += repair.toolNames.length;
        out.push(repair.message);
        // A tool_use must stay adjacent to its tool_result, so the reminder goes after the result.
        if (source[i + 1]?.role === 'tool') {
            out.push(source[++i]);
        }
        out.push(droppedArgumentsReminder(repair.toolNames));
    }
    if (repaired > 0) {
        console.warn(`[messageSanitization] Coerced ${repaired} malformed tool-call input(s) to objects.`);
    }
    return { messages: out, repaired };
}

/**
 * Run every repair pass over a message history so it stays provider-valid. Call before sending
 * history to the provider (prepareStep, history load) and send what comes back. Add new passes
 * here as needed.
 */
export function sanitizeMessages(messages: readonly ModelMessage[] | null | undefined): SanitizedHistory {
    return repairToolCallInputs(messages);
}
