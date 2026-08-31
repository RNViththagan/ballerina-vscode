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

/**
 * @jest-environment node
 *
 * Guards the tool-call input sanitizer: when a streamed tool call's JSON is invalid, the AI SDK
 * keeps the raw text as a string on the `tool-call` part, and Anthropic rejects every later
 * request in the thread with `tool_use.input: Input should be an object`. The sanitizer coerces
 * such inputs to objects before the history is sent.
 */

import {
    repairToolCallInputs,
    sanitizeMessages,
} from "../features/ai/agent/resilience/messageSanitization";

// The real bug shape: `"new_string">` (should be `":`) makes the input unparseable, so the SDK
// keeps it as a string on the tool-call part.
const MALFORMED_INPUT =
    '{"file_path": "types.bal", "edits": [{"old_string": "a", "new_string">"b"}]}';

const assistantWithMalformedCall = () => ({
    role: "assistant",
    content: [
        { type: "text", text: "Editing the file." },
        {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "file_batch_edit",
            input: MALFORMED_INPUT, // string — the bug
        },
    ],
});

describe("repairToolCallInputs", () => {
    it("coerces an unparseable string input to an empty object", () => {
        const messages = [assistantWithMalformedCall()];
        const repaired = repairToolCallInputs(messages);
        const call = (messages[0].content as any[])[1];
        expect(repaired).toBe(1);
        expect(typeof call.input).toBe("object");
        expect(call.input).toEqual({});
    });

    it("parses a well-formed JSON string input into the object it represents", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "c",
                        toolName: "t",
                        input: '{"file_path":"main.bal","edits":[]}',
                    },
                ],
            },
        ];
        const repaired = repairToolCallInputs(messages);
        expect(repaired).toBe(1);
        expect((messages[0].content as any[])[0].input).toEqual({
            file_path: "main.bal",
            edits: [],
        });
    });

    it("coerces a string truncated mid-JSON to {} (output-token cap on large writes)", () => {
        // The common production trigger: a large file write whose tool-call JSON is cut off
        // at the 8192 output-token limit, leaving unparseable text.
        const messages = [
            {
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        toolCallId: "c",
                        toolName: "file_batch_edit",
                        input: '{"file_path":"main.bal","content":"import ballerina/ht',
                    },
                ],
            },
        ];
        expect(repairToolCallInputs(messages)).toBe(1);
        expect((messages[0].content as any[])[0].input).toEqual({});
    });

    it("coerces an empty string input to {}", () => {
        const messages = [
            {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "c", toolName: "t", input: "" }],
            },
        ];
        expect(repairToolCallInputs(messages)).toBe(1);
        expect((messages[0].content as any[])[0].input).toEqual({});
    });

    it("coerces a JSON array string to {} (provider requires an object, not an array)", () => {
        const messages = [
            {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "c", toolName: "t", input: "[1,2,3]" }],
            },
        ];
        repairToolCallInputs(messages);
        expect((messages[0].content as any[])[0].input).toEqual({});
    });

    it("leaves a valid object input untouched and is a no-op (returns 0)", () => {
        const original = { file_path: "main.bal", edits: [{ old_string: "a", new_string: "b" }] };
        const messages = [
            {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "c", toolName: "t", input: original }],
            },
        ];
        const repaired = repairToolCallInputs(messages);
        expect(repaired).toBe(0);
        expect((messages[0].content as any[])[0].input).toBe(original);
    });

    it("repairs multiple malformed calls across messages and counts them", () => {
        const messages = [
            assistantWithMalformedCall(),
            { role: "user", content: "continue" },
            assistantWithMalformedCall(),
        ];
        expect(repairToolCallInputs(messages)).toBe(2);
    });

    it("ignores messages with non-array content and tolerates empty input", () => {
        expect(repairToolCallInputs([])).toBe(0);
        expect(repairToolCallInputs(undefined as any)).toBe(0);
        expect(repairToolCallInputs([{ role: "user", content: "hi" }])).toBe(0);
    });

    it("leaves non-tool-call parts untouched", () => {
        const messages = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "some string content" },
                    { type: "tool-result", toolCallId: "c", toolName: "t", output: "raw" },
                ],
            },
        ];
        expect(repairToolCallInputs(messages)).toBe(0);
        expect((messages[0].content as any[])[0].text).toBe("some string content");
        expect((messages[0].content as any[])[1].output).toBe("raw");
    });
});

describe("sanitizeMessages", () => {
    it("runs the repair passes over the history in place", () => {
        const messages = [assistantWithMalformedCall()];
        sanitizeMessages(messages);
        expect((messages[0].content as any[])[1].input).toEqual({});
    });

    it("leaves a clean history untouched", () => {
        const messages = [
            {
                role: "assistant",
                content: [{ type: "tool-call", toolCallId: "c", toolName: "t", input: { ok: 1 } }],
            },
        ];
        sanitizeMessages(messages);
        expect((messages[0].content as any[])[0].input).toEqual({ ok: 1 });
    });
});
