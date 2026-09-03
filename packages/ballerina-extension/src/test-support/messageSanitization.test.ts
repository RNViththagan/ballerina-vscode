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
 * Guards the tool-call input sanitizer. When a streamed tool call's JSON is invalid the AI SDK
 * keeps the raw text as a string on the `tool-call` part; when it parses but fails the tool's
 * schema, the parsed array/null/number is kept instead. Anthropic rejects every later request in
 * the thread with `tool_use.input: Input should be an object`. The sanitizer coerces such inputs
 * to objects before the history is sent, tells the model the call never ran, and never writes
 * into the history it was given.
 */

import type { AssistantModelMessage, ModelMessage, ToolCallPart } from "ai";
import {
    repairToolCallInputs,
    sanitizeMessages,
} from "../features/ai/agent/resilience/messageSanitization";

// The real bug shape: `"new_string">` (should be `":`) makes the input unparseable, so the SDK
// keeps it as a string on the tool-call part.
const MALFORMED_INPUT =
    '{"file_path": "types.bal", "edits": [{"old_string": "a", "new_string">"b"}]}';

function assistantCalling(toolName: string, input: unknown, toolCallId = "call_1"): AssistantModelMessage {
    return {
        role: "assistant",
        content: [
            { type: "text", text: "Editing the file." },
            { type: "tool-call", toolCallId, toolName, input },
        ],
    };
}

const toolResultFor = (toolCallId: string): ModelMessage => ({
    role: "tool",
    content: [
        {
            type: "tool-result",
            toolCallId,
            toolName: "file_batch_edit",
            output: { type: "error-text", value: "Invalid JSON" },
        },
    ],
});

function toolCallAt(message: ModelMessage, index: number): ToolCallPart {
    if (message.role !== "assistant" || typeof message.content === "string") {
        throw new Error("expected an assistant message with parts");
    }
    const part = message.content[index];
    if (part.type !== "tool-call") {
        throw new Error(`expected a tool-call part at ${index}, got ${part.type}`);
    }
    return part;
}

const reminders = (messages: ModelMessage[]) =>
    messages.filter(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("<system-reminder>")
    );

describe("repairToolCallInputs", () => {
    it("coerces an unparseable string input to an empty object", () => {
        const { messages, repaired } = repairToolCallInputs([assistantCalling("file_batch_edit", MALFORMED_INPUT)]);

        expect(repaired).toBe(1);
        expect(toolCallAt(messages[0], 1).input).toEqual({});
    });

    it("parses a well-formed JSON string input into the object it represents", () => {
        const { messages, repaired } = repairToolCallInputs([
            assistantCalling("t", '{"file_path":"main.bal","edits":[]}'),
        ]);

        expect(repaired).toBe(1);
        expect(toolCallAt(messages[0], 1).input).toEqual({ file_path: "main.bal", edits: [] });
    });

    it("coerces a string truncated mid-JSON to {} (output-token cap on large writes)", () => {
        const { messages } = repairToolCallInputs([
            assistantCalling("file_batch_edit", '{"file_path":"main.bal","content":"import ballerina/ht'),
        ]);

        expect(toolCallAt(messages[0], 1).input).toEqual({});
    });

    it.each([
        ["an empty string", ""],
        ["a JSON array string", "[1,2,3]"],
        ["an actual array, the SDK's shape when the JSON parsed but failed the schema", [1, 2]],
        ["null", null],
        ["a number", 42],
        ["undefined", undefined],
    ])("coerces %s to {}", (_label, input) => {
        const { messages, repaired } = repairToolCallInputs([assistantCalling("t", input)]);

        expect(repaired).toBe(1);
        expect(toolCallAt(messages[0], 1).input).toEqual({});
    });

    it("leaves a valid object input untouched and is a no-op (returns 0)", () => {
        const original = { file_path: "main.bal", edits: [{ old_string: "a", new_string: "b" }] };
        const source = [assistantCalling("t", original)];

        const { messages, repaired } = repairToolCallInputs(source);

        expect(repaired).toBe(0);
        expect(toolCallAt(messages[0], 1).input).toBe(original);
        expect(messages[0]).toBe(source[0]);
    });

    it("never writes into the history it was given", () => {
        const source = [assistantCalling("file_batch_edit", MALFORMED_INPUT), toolResultFor("call_1")];

        const { messages } = repairToolCallInputs(source);

        expect(toolCallAt(source[0], 1).input).toBe(MALFORMED_INPUT);
        expect(messages[0]).not.toBe(source[0]);
        expect(messages[1]).toBe(source[1]);
    });

    it("tells the model the call never ran, after the tool result it is paired with", () => {
        const { messages } = repairToolCallInputs([
            assistantCalling("file_batch_edit", MALFORMED_INPUT),
            toolResultFor("call_1"),
            { role: "user", content: "continue" },
        ]);

        expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "user", "user"]);
        const reminder = messages[2];
        expect(reminder.content).toContain("<system-reminder>");
        expect(reminder.content).toContain("`file_batch_edit`");
        expect(reminder.content).toContain("NOT performed");
        expect(messages[3].content).toBe("continue");
    });

    it("places the reminder right after the assistant message when no tool result follows", () => {
        const { messages } = repairToolCallInputs([
            assistantCalling("t", MALFORMED_INPUT),
            { role: "user", content: "continue" },
        ]);

        expect(messages.map((m) => m.role)).toEqual(["assistant", "user", "user"]);
        expect(reminders(messages)).toHaveLength(1);
    });

    it("issues one reminder per assistant message, naming every dropped call", () => {
        const twoCalls: AssistantModelMessage = {
            role: "assistant",
            content: [
                { type: "tool-call", toolCallId: "a", toolName: "file_batch_edit", input: "" },
                { type: "tool-call", toolCallId: "b", toolName: "file_write", input: [] },
            ],
        };

        const { messages, repaired } = repairToolCallInputs([twoCalls]);

        expect(repaired).toBe(2);
        const [reminder] = reminders(messages);
        expect(reminders(messages)).toHaveLength(1);
        expect(reminder.content).toContain("`file_batch_edit`, `file_write`");
        expect(reminder.content).toContain("Those calls were NOT performed");
    });

    it("repairs malformed calls across messages and counts them", () => {
        const { repaired } = repairToolCallInputs([
            assistantCalling("t", MALFORMED_INPUT),
            { role: "user", content: "continue" },
            assistantCalling("t", MALFORMED_INPUT, "call_2"),
        ]);

        expect(repaired).toBe(2);
    });

    it("adds no reminder to a clean history", () => {
        const { messages } = repairToolCallInputs([assistantCalling("t", { ok: 1 }), toolResultFor("call_1")]);

        expect(reminders(messages)).toHaveLength(0);
    });

    it("tolerates empty, missing and part-less input", () => {
        expect(repairToolCallInputs([]).repaired).toBe(0);
        expect(repairToolCallInputs(undefined).repaired).toBe(0);
        expect(repairToolCallInputs(null).messages).toEqual([]);
        expect(repairToolCallInputs([{ role: "user", content: "hi" }]).repaired).toBe(0);
        expect(repairToolCallInputs([{ role: "assistant", content: "plain text" }]).repaired).toBe(0);
    });

    it("leaves non-tool-call parts untouched", () => {
        const source: ModelMessage[] = [
            {
                role: "assistant",
                content: [
                    { type: "text", text: "some string content" },
                    { type: "tool-call", toolCallId: "c", toolName: "t", input: "" },
                ],
            },
        ];

        const { messages } = repairToolCallInputs(source);

        const first = (messages[0] as AssistantModelMessage).content[0];
        expect(first).toEqual({ type: "text", text: "some string content" });
    });
});

describe("sanitizeMessages", () => {
    it("returns the repaired history and how many calls were dropped", () => {
        const { messages, repaired } = sanitizeMessages([assistantCalling("t", MALFORMED_INPUT)]);

        expect(repaired).toBe(1);
        expect(toolCallAt(messages[0], 1).input).toEqual({});
    });

    it("hands a clean history back unchanged", () => {
        const source = [assistantCalling("t", { ok: 1 })];

        const { messages, repaired } = sanitizeMessages(source);

        expect(repaired).toBe(0);
        expect(messages).toEqual(source);
    });
});
