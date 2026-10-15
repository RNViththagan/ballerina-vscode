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
import {
    ConnectionCreator,
    ConnectionKind,
    ConnectionSelectionList,
    getConnectionKindDisplayName
} from "../../../../components/ConnectionSelector";
import { RelativeLoader } from "../../../../components/RelativeLoader";
import { LoaderContainer } from "../../../../components/RelativeLoader/styles";
import { CONNECTIONS_FILE } from "../../../../constants";
import { getNodeTemplateForConnection } from "../../FlowDiagram/utils";

const MODAL_WIDTH = 680;
const MODAL_HEIGHT = 780;

interface ComponentFormProps {
    connectionKind: ConnectionKind;
    nodeId: string;
    metadata: unknown;
    fileName: string;
    onSaved: () => void;
    onFailed: () => void;
}

function ComponentForm({ connectionKind, nodeId, metadata, fileName, onSaved, onFailed }: ComponentFormProps) {
    const { rpcClient } = useRpcContext();
    const [template, setTemplate] = useState<FlowNode>();

    useEffect(() => {
        getNodeTemplateForConnection(nodeId, metadata, undefined, fileName, rpcClient)
            .then(({ flowNode }) => setTemplate(flowNode))
            .catch((error) => {
                console.error("Error fetching the component template", error);
                onFailed();
            });
    }, [nodeId]);

    if (!template) {
        return <LoaderContainer><RelativeLoader /></LoaderContainer>;
    }
    return (
        <ConnectionCreator
            connectionKind={connectionKind}
            selectedNode={{ properties: { model: { value: "" } } } as unknown as FlowNode}
            nodeFormTemplate={template}
            onSave={onSaved}
        />
    );
}

export interface AddAiComponentPopupProps {
    connectionKind: ConnectionKind;
    projectPath: string;
    onNavigateToOverview: () => void;
}

// Opens the same select and create steps an agent's form uses for the AI component, for the explorer's add actions.
export function AddAiComponentPopup({ connectionKind, projectPath, onNavigateToOverview }: AddAiComponentPopupProps): null {
    const { addModal, closeModal } = useModalStack();
    const navigateToOverview = useRef(onNavigateToOverview);
    navigateToOverview.current = onNavigateToOverview;

    useEffect(() => {
        let tearingDown = false;
        const selectId = `add-${connectionKind}-select`;
        const createId = `add-${connectionKind}-create`;
        const displayName = getConnectionKindDisplayName(connectionKind);
        const fileName = Utils.joinPath(URI.file(projectPath), CONNECTIONS_FILE).fsPath;
        const finish = () => {
            tearingDown = true;
            closeModal(createId);
            closeModal(selectId);
            navigateToOverview.current();
        };
        const handleSelect = (nodeId: string, metadata?: unknown) => {
            addModal(
                <ComponentForm
                    connectionKind={connectionKind}
                    nodeId={nodeId}
                    metadata={metadata}
                    fileName={fileName}
                    onSaved={finish}
                    onFailed={() => closeModal(createId)}
                />,
                createId,
                `Create ${displayName}`,
                MODAL_HEIGHT,
                MODAL_WIDTH
            );
        };
        addModal(
            <ConnectionSelectionList connectionKind={connectionKind} onSelect={handleSelect} fillContainerHeight />,
            selectId,
            `Select ${displayName}`,
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
            closeModal(createId);
            closeModal(selectId);
        };
    }, [connectionKind, projectPath]);

    return null;
}

export default AddAiComponentPopup;
