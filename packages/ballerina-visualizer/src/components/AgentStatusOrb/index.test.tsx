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

// The idle invite is a hover affordance, and the box it offers is easy to lose in ways that
// cost the user whatever they were about to type: a pointer on its way over crosses the gap
// the wrapper leaves untouchable (bridged in the layout, so a leave never fires), and a
// pointer wanders off mid-sentence (held by the focus/content pin, asserted here).

import * as React from "react";
import { act } from "react-dom/test-utils";
import { createRoot, Root } from "react-dom/client";
import type { AgentRunStatus } from "@wso2/ballerina-core";

// The core barrel re-exports ESM-only LS transport modules jest cannot load. shared.ts
// only property-accesses MACHINE_VIEW, and the orb only reads the open-panel command id.
jest.mock("@wso2/ballerina-core", () => ({
    MACHINE_VIEW: {},
    SHARED_COMMANDS: { OPEN_AI_PANEL: "ballerina.open.ai.panel" },
}));

let mockRpcClient: any;

jest.mock("@wso2/ballerina-rpc-client", () => ({
    useRpcContext: () => ({ rpcClient: mockRpcClient }),
}));

// A WebGL surface jsdom has no renderer for, and a chat overlay irrelevant here.
jest.mock("./CopilotOrb", () => ({ CopilotOrb: (): null => null }));
jest.mock("./MiniChat", () => ({ MiniChat: (): null => null }));

import { AgentStatusOrb } from "./index";
import { __resetAgentRunStatusStoreForTests } from "./shared";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const INVITE_PLACEHOLDER = "How can I help?";
/** Comfortably past INVITE_FADE_MS. */
const AFTER_FADE_MS = 1000;
const ONE_FRAME_MS = 32;

function makeRpcClient() {
    let pushed: ((status: AgentRunStatus) => void) | undefined;
    const client = {
        getCommonRpcClient: () => ({
            getAgentRunStatus: jest.fn().mockResolvedValue(undefined),
            getCopilotOrbTheme: jest.fn().mockResolvedValue("animated"),
            executeCommand: jest.fn().mockResolvedValue(undefined),
        }),
        onAgentRunStatusChanged: jest.fn((cb: (status: AgentRunStatus) => void) => {
            pushed = cb;
        }),
    };
    return {
        client,
        notify: (status: AgentRunStatus) => {
            if (!pushed) {
                throw new Error("onAgentRunStatusChanged callback was never registered");
            }
            act(() => pushed!(status));
        },
    };
}

describe("AgentStatusOrb idle invite", () => {
    let container: HTMLDivElement;
    let root: Root;

    /** The orb widget: what the pointer enters and leaves. */
    const wrapper = () => container.firstElementChild as HTMLElement;
    const invite = () => container.querySelector(`input[placeholder="${INVITE_PLACEHOLDER}"]`) as HTMLInputElement;
    /** The box itself, which outlives the invite being wanted by the length of its fade. */
    const box = () => invite()?.parentElement ?? null;

    function fire(target: HTMLElement, event: Event): void {
        act(() => {
            target.dispatchEvent(event);
        });
    }

    // React derives mouseenter/mouseleave (and focus/blur) from these, so both have to
    // be driven as the native events they are built from.
    const hover = () =>
        fire(wrapper(), new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    const unhover = () =>
        fire(wrapper(), new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    const focusInvite = () => fire(invite(), new FocusEvent("focusin", { bubbles: true }));
    const blurInvite = () => fire(invite(), new FocusEvent("focusout", { bubbles: true }));

    function type(text: string): void {
        const input = invite();
        act(() => {
            const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
            setValue.call(input, text);
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
    }

    function wait(ms: number): void {
        act(() => {
            jest.advanceTimersByTime(ms);
        });
    }

    /** The box mounts transparent and turns visible a frame later, so the fade has a start. */
    function settle(): void {
        wait(ONE_FRAME_MS);
    }

    const opacityOf = (element: HTMLElement) => getComputedStyle(element).opacity;

    beforeEach(() => {
        jest.useFakeTimers();
        __resetAgentRunStatusStoreForTests();
        const { client, notify } = makeRpcClient();
        mockRpcClient = client;
        container = document.createElement("div");
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root.render(React.createElement(AgentStatusOrb)));
        notify({ state: "idle", aiPanelOpen: false, timestamp: 0 } as AgentRunStatus);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        mockRpcClient = undefined;
        jest.useRealTimers();
    });

    it("keeps the idle orb bare until it is hovered", () => {
        expect(invite()).toBeNull();
    });

    it("offers the invite while the pointer is on the orb", () => {
        hover();
        expect(opacityOf(box()!)).toBe("0");

        settle();

        expect(invite()).not.toBeNull();
        expect(opacityOf(box()!)).toBe("1");
    });

    it("starts fading the moment the pointer leaves, with nothing held back", () => {
        hover();
        settle();

        unhover();

        expect(opacityOf(box()!)).toBe("0");
    });

    it("fades the same box back in when the pointer returns mid-fade", () => {
        hover();
        settle();
        const opened = box();

        unhover();
        hover();
        settle();

        expect(box()).toBe(opened);
        expect(opacityOf(box()!)).toBe("1");
    });

    it("withdraws the invite once the pointer stays away", () => {
        hover();
        settle();

        unhover();
        wait(AFTER_FADE_MS);

        expect(invite()).toBeNull();
    });

    it("holds the invite open while it has focus", () => {
        hover();
        settle();
        focusInvite();

        unhover();
        wait(AFTER_FADE_MS);

        expect(invite()).not.toBeNull();
        expect(opacityOf(box()!)).toBe("1");
    });

    it("holds the invite open while it holds what was typed", () => {
        hover();
        settle();
        focusInvite();
        type("build me a service");

        blurInvite();
        unhover();
        wait(AFTER_FADE_MS);

        expect(invite()).not.toBeNull();
        expect(invite().value).toBe("build me a service");
    });
});
