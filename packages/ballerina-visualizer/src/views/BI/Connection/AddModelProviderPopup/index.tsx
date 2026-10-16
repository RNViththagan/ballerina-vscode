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

import { useEffect, useRef, useState } from "react";
import { FlowNode } from "@wso2/ballerina-core";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { URI, Utils } from "vscode-uri";
import { useModalStack } from "../../../../Context";
import { ConnectionCreator, ConnectionSelectionList } from "../../../../components/ConnectionSelector";
import { RelativeLoader } from "../../../../components/RelativeLoader";
import { LoaderContainer } from "../../../../components/RelativeLoader/styles";
import { CONNECTIONS_FILE } from "../../../../constants";
import { getNodeTemplateForConnection } from "../../FlowDiagram/utils";

const SELECT_ID = "add-model-provider-select";
const CREATE_ID = "add-model-provider-create";
const MODAL_WIDTH = 680;
const MODAL_HEIGHT = 780;

interface ModelProviderFormProps {
    nodeId: string;
    metadata: unknown;
    fileName: string;
    onSaved: () => void;
    onFailed: () => void;
}

function ModelProviderForm({ nodeId, metadata, fileName, onSaved, onFailed }: ModelProviderFormProps) {
    const { rpcClient } = useRpcContext();
    const [template, setTemplate] = useState<FlowNode>();

    useEffect(() => {
        let active = true;
        getNodeTemplateForConnection(nodeId, metadata, undefined, fileName, rpcClient)
            .then(({ flowNode }) => active && setTemplate(flowNode))
            .catch((error) => {
                console.error("Error fetching model provider template", error);
                // A later selection reuses CREATE_ID, so a stale failure must not close its modal.
                if (active) {
                    onFailed();
                }
            });
        return () => {
            active = false;
        };
    }, [nodeId]);

    if (!template) {
        return <LoaderContainer><RelativeLoader /></LoaderContainer>;
    }
    return (
        <ConnectionCreator
            connectionKind="MODEL_PROVIDER"
            selectedNode={{ properties: { model: { value: "" } } } as unknown as FlowNode}
            nodeFormTemplate={template}
            onSave={onSaved}
        />
    );
}

export interface AddModelProviderPopupProps {
    projectPath: string;
    onNavigateToOverview: () => void;
}

// Opens the same Select Model Provider and create steps an agent's Model field uses, for the explorer's add action.
export function AddModelProviderPopup({ projectPath, onNavigateToOverview }: AddModelProviderPopupProps): null {
    const { addModal, closeModal } = useModalStack();
    const navigateToOverview = useRef(onNavigateToOverview);
    navigateToOverview.current = onNavigateToOverview;

    useEffect(() => {
        let tearingDown = false;
        const fileName = Utils.joinPath(URI.file(projectPath), CONNECTIONS_FILE).fsPath;
        const finish = () => {
            tearingDown = true;
            closeModal(CREATE_ID);
            closeModal(SELECT_ID);
            navigateToOverview.current();
        };
        const handleSelect = (nodeId: string, metadata?: unknown) => {
            addModal(
                <ModelProviderForm
                    nodeId={nodeId}
                    metadata={metadata}
                    fileName={fileName}
                    onSaved={finish}
                    onFailed={() => closeModal(CREATE_ID)}
                />,
                CREATE_ID,
                "Create Model Provider",
                MODAL_HEIGHT,
                MODAL_WIDTH
            );
        };
        addModal(
            <ConnectionSelectionList connectionKind="MODEL_PROVIDER" onSelect={handleSelect} fillContainerHeight />,
            SELECT_ID,
            "Select Model Provider",
            MODAL_HEIGHT,
            MODAL_WIDTH,
            () => {
                if (!tearingDown) {
                    navigateToOverview.current();
                }
            }
        );
        return () => {
            tearingDown = true;
            closeModal(CREATE_ID);
            closeModal(SELECT_ID);
        };
    }, [projectPath]);

    return null;
}

export default AddModelProviderPopup;
