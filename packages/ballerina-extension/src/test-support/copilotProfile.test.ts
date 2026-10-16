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

jest.mock('@wso2/ballerina-core', () => jest.requireActual('@wso2/ballerina-core/lib/state-machine-types'));

import { ProductMode, TaskTypes } from '@wso2/ballerina-core/lib/state-machine-types';
import { getCopilotProfile } from '../features/ai/agent/copilot-profile';
import { buildFollowupPrompt } from '../features/ai/agent/followups/prompt';
import { MODULE_INIT_CODING_RULES } from '../features/ai/agent/module-init-rules';

describe('copilot profile', () => {
    let declaredMode: string | undefined;

    beforeEach(() => {
        declaredMode = process.env.WSO2_PRODUCT_MODE;
    });

    afterEach(() => {
        if (declaredMode === undefined) {
            delete process.env.WSO2_PRODUCT_MODE;
        } else {
            process.env.WSO2_PRODUCT_MODE = declaredMode;
        }
    });

    it.each([ProductMode.INTEGRATOR, ProductMode.BALLERINA])('keeps the integration profile in %s mode', (mode) => {
        const profile = getCopilotProfile(mode);

        expect(profile.designTaskType).toBe(TaskTypes.SERVICE_DESIGN);
        expect(profile.moduleInitRules).toBe(MODULE_INIT_CODING_RULES);
        expect(profile.opening).toContain('Answer queries related to Ballerina and integrations.');
    });

    it('scopes Agent Builder to agents and points standalone integrations to WSO2 Integrator', () => {
        const profile = getCopilotProfile(ProductMode.AGENT_BUILDER);

        expect(profile.opening).toContain('When the project already has an agent, anything the user asks to add to or change in it is in scope');
        expect(profile.opening).toContain('Redirect only when the work itself has no agent in it and the project has none yet');
        expect(profile.opening).toContain('Always name WSO2 Integrator as the product built for that kind of work and include its link, https://wso2.com/integration-platform/');
        expect(profile.opening).toContain('wait for the user to agree before building that');
        expect(profile.opening).toContain('Code an agent needs is in scope too');
        expect(profile.opening).toContain('use the workflow-builder skill only for that');
    });

    it('drops the prompt rules that conflict with the agent-builder skill', () => {
        const profile = getCopilotProfile(ProductMode.AGENT_BUILDER);

        expect(profile.designTaskType).toBe(TaskTypes.AGENT_DESIGN);
        expect(profile.planTaskTypes).not.toContain('service_design');
        expect(profile.planTaskTypes).not.toContain('http:NotImplemented');
        expect(profile.moduleInitRules).toContain('Never write a module `init()` function');
        expect(profile.automationRule).toBe('');
        expect(profile.clarifyEntryPointDefault).toContain('chat trigger');
        expect(profile.terminology).toContain('**agentic integration**');
    });

    it('frames follow-ups around the agent in Agent Builder', () => {
        process.env.WSO2_PRODUCT_MODE = ProductMode.AGENT_BUILDER;

        const followups = buildFollowupPrompt({ userQuery: 'q', assistantResponse: 'a' }).system;
        expect(followups).toContain('The Copilot builds AI agents for the user.');
        expect(followups).toContain('give the agent a new tool');
        expect(followups).not.toContain('integration');
    });

    it('keeps the integration follow-ups in Integrator', () => {
        process.env.WSO2_PRODUCT_MODE = ProductMode.INTEGRATOR;

        expect(buildFollowupPrompt({ userQuery: 'q', assistantResponse: 'a' }).system)
            .toContain('The Copilot builds integrations for the user.');
    });
});
