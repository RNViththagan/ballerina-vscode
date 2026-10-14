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

// Publishes this project's MCP server, hosted on WSO2 Cloud, to Agent Manager as an MCP proxy.
// Agent Manager can't host an MCP server itself, so the proxy fronts the WSO2 Cloud endpoint.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    AgentManagerActionResponse,
    AgentManagerMcpSourceStepId,
    AgentManagerMcpPublishRequest,
    AgentManagerMcpPublishStatus,
    AgentManagerPublishedMcpProxy,
} from "@wso2/ballerina-core";
import { AgentManagerApiError, getSession, requireSession } from "./auth";
import { api, consoleOrgUrl, DEFAULT_ENVIRONMENT, McpProxyDetails, readManifest, updateManifest } from "./client";
import { readBalSources, readPackageTitle, respond } from "./flows";
import { git, readFacts } from "./github";
import {
    buildMcpProxyRequest, findMcpService, McpCapabilities, McpServiceDeclaration, mcpSourceStep, proxyVersion, toProxyHandle, upstreamMcpUrl,
    withMcpEndpoint,
} from "./mcp-publish-utils";

const COMPONENT_YAML = path.join(".choreo", "component.yaml");

function readComponentYaml(projectPath: string): string | undefined {
    const file = path.join(projectPath, COMPONENT_YAML);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : undefined;
}

function requireMcpService(projectPath: string): McpServiceDeclaration & { port: number } {
    const service = findMcpService([readBalSources(projectPath)]);
    if (!service) {
        throw new Error("This integration has no MCP service to publish.");
    }
    if (service.port === undefined) {
        throw new Error("Couldn't read the MCP listener's port. Declare it as a number, for example `new mcp:Listener(8080)`.");
    }
    return { ...service, port: service.port };
}

function proxyConsoleUrl(consoleUrl: string, org: string, id: string): string {
    return `${consoleOrgUrl(consoleUrl, org)}/mcp-proxies/view/${encodeURIComponent(id)}`;
}

const endpointIn = (proxy: McpProxyDetails, environmentId?: string) =>
    proxy.endpoints?.find((endpoint) => endpoint.environments?.some((env) => env.environmentUuid === environmentId));

const isNotFound = (error: unknown) => error instanceof AgentManagerApiError && error.status === 404;

/** The proxy, or `undefined` when Agent Manager has none with that id. */
async function findProxy(id: string): Promise<McpProxyDetails | undefined> {
    try {
        return await api.getMcpProxy(id);
    } catch (error) {
        if (isNotFound(error)) {
            return undefined;
        }
        throw error;
    }
}

export async function getMcpPublishStatus(projectPath: string): Promise<AgentManagerMcpPublishStatus> {
    const service = findMcpService([readBalSources(projectPath)]);
    const yaml = readComponentYaml(projectPath);
    const local = {
        servicePath: service?.basePath,
        endpointReady: service?.port !== undefined && yaml !== undefined && !withMcpEndpoint(yaml, service.port).changed,
        source: mcpSourceStep(await readFacts(projectPath)),
    };
    const session = await getSession();
    if (!session) {
        return { signedIn: false, ...local };
    }
    const status: AgentManagerMcpPublishStatus = { signedIn: true, instanceUrl: session.instanceUrl, org: session.org, ...local };
    const saved = readManifest(projectPath).publishedMcpProxy;
    if (!saved) {
        return status;
    }
    try {
        const [proxy, environmentId] = await Promise.all([api.getMcpProxy(saved.id), api.getEnvironmentId(DEFAULT_ENVIRONMENT)]);
        const endpoint = endpointIn(proxy, environmentId);
        const upstreamHeader = endpoint?.upstream?.main?.auth?.header || undefined;
        const published: AgentManagerPublishedMcpProxy = {
            id: saved.id,
            name: proxy.name,
            url: saved.url,
            toolCount: endpoint?.capabilities?.tools?.length,
            deployed: endpoint?.environments?.find((env) => env.environmentUuid === environmentId)?.deploymentStatus === "Deployed",
            consoleUrl: proxyConsoleUrl(session.consoleUrl, session.org, saved.id),
            upstreamSecurity: upstreamHeader ? "apiKey" : "none",
            upstreamHeader,
        };
        return { ...status, published };
    } catch (error) {
        return {
            ...status,
            error: isNotFound(error)
                ? `The MCP proxy '${saved.id}' no longer exists in Agent Manager. Publish again to recreate it.`
                : error instanceof Error ? error.message : String(error),
        };
    }
}

const runCommand = (command: string) => async () => {
    await vscode.commands.executeCommand(command);
};

const INITIAL_COMMIT_MESSAGE = "Initial commit";

/** VS Code's Git extension API, so a repository created here shows up in Source Control and GitHub publishing. */
function gitExtensionApi(): any {
    return vscode.extensions.getExtension("vscode.git")?.exports?.getAPI?.(1);
}

async function runGit(cwd: string, args: string[], action: string): Promise<void> {
    const result = await git(cwd, args);
    if (result.status !== 0) {
        throw new Error(`Couldn't ${action}: ${(result.stderr || result.stdout).trim()}`);
    }
}

/** Stages and commits everything Git doesn't ignore; nothing to commit is not an error. */
async function commitAll(root: string): Promise<void> {
    await runGit(root, ["add", "-A"], "stage the project's files");
    if ((await git(root, ["diff", "--cached", "--quiet"])).status === 0) {
        return;
    }
    await runGit(root, ["commit", "-m", INITIAL_COMMIT_MESSAGE], "commit the project's files");
}

/**
 * Publishes to GitHub without VS Code's "which files to include" picker. That picker only appears for a folder
 * with no repository, so the repository is created and everything committed first; publishing then just pushes it.
 */
async function publishToGitHub(projectPath: string): Promise<void> {
    const facts = await readFacts(projectPath);
    const gitApi = gitExtensionApi();
    let root = facts.root;
    if (!root) {
        root = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath))?.uri.fsPath ?? projectPath;
        if (gitApi?.init) {
            await gitApi.init(vscode.Uri.file(root));
        } else {
            await runGit(root, ["init"], "create a Git repository");
        }
    }
    await commitAll(root);
    const repository = await gitApi?.openRepository?.(vscode.Uri.file(root));
    await repository?.status?.();
    await vscode.commands.executeCommand("github.publish");
}

const SOURCE_FIXES: Record<AgentManagerMcpSourceStepId, (projectPath: string) => Promise<void>> = {
    gitMissing: async () => {
        await vscode.env.openExternal(vscode.Uri.parse("https://git-scm.com/downloads"));
    },
    publishRepo: publishToGitHub,
    detached: runCommand("git.checkout"),
    // Only reveals Source Control; the user picks what to commit there.
    commit: runCommand("workbench.scm.focus"),
    publishBranch: runCommand("git.publish"),
    push: runCommand("git.push"),
};

/** Runs the Git step the card showed, exactly as labelled. */
export function fixMcpSource(projectPath: string, step: AgentManagerMcpSourceStepId): Promise<AgentManagerActionResponse> {
    return respond(async () => {
        await SOURCE_FIXES[step]?.(projectPath);
    });
}

/** Points the WSO2 Cloud endpoint at the MCP listener's root, so clients reach the service at its own path. */
export function prepareMcpEndpoint(projectPath: string): Promise<AgentManagerActionResponse> {
    return respond(async () => {
        const { port } = requireMcpService(projectPath);
        const update = withMcpEndpoint(readComponentYaml(projectPath), port);
        if (update.changed) {
            const file = path.join(projectPath, COMPONENT_YAML);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, update.content);
        }
    });
}

export function publishMcpProxy({ projectPath, url, security, header, apiKey }: AgentManagerMcpPublishRequest): Promise<AgentManagerActionResponse> {
    return respond(async () => {
        const session = await requireSession();
        const { basePath } = requireMcpService(projectPath);
        const upstream = upstreamMcpUrl(url, basePath);
        const usesKey = security === "apiKey";
        const headerName = usesKey ? header?.trim() ?? "" : "";
        const key = usesKey ? apiKey?.trim() : undefined;
        if (usesKey && !headerName) {
            throw new Error("Enter the header WSO2 Cloud reads the API key from.");
        }
        const environmentId = await api.getEnvironmentId(DEFAULT_ENVIRONMENT);
        if (!environmentId) {
            throw new Error(`Agent Manager has no '${DEFAULT_ENVIRONMENT}' environment to publish to.`);
        }

        const saved = readManifest(projectPath).publishedMcpProxy;
        let existing = saved ? await findProxy(saved.id) : undefined;
        const storedHeader = existing && (endpointIn(existing, environmentId) ?? existing.endpoints?.[0])?.upstream?.main?.auth?.header;
        if (usesKey && !key && !storedHeader) {
            throw new Error("Enter the API key WSO2 Cloud generated for this MCP server.");
        }
        // Agent Manager merges a stored upstream credential back into every update, so it can't be dropped from here.
        if (!usesKey && storedHeader) {
            throw new Error("Agent Manager can't remove the API key this MCP server already uses. Keep API Key, "
                + "or delete the MCP server in Agent Manager and publish again.");
        }

        // With API Key security and no new key, the server can't be reached from here, so its tools stay as last discovered.
        let capabilities: McpCapabilities | undefined;
        let serverVersion: unknown;
        if (key || !usesKey) {
            const info = await api.fetchMcpServerInfo(upstream, key ? { type: "api-key", header: headerName, value: key } : undefined);
            capabilities = { tools: info.tools ?? [], resources: info.resources ?? [], prompts: info.prompts ?? [] };
            serverVersion = info.serverInfo?.version;
        }

        const title = await readPackageTitle(projectPath);
        const handle = existing?.id ?? toProxyHandle(title);
        if (!existing) {
            // A proxy with this id published from another clone that fronts the same server is adopted, not duplicated.
            const sameId = await findProxy(handle);
            if (sameId) {
                if (!sameId.endpoints?.some((endpoint) => endpoint.upstream?.main?.url === upstream)) {
                    throw new Error(`Agent Manager already has an MCP proxy named '${handle}' for a different server. Rename this integration and publish again.`);
                }
                existing = sameId;
            }
        }

        const body = buildMcpProxyRequest({
            handle,
            name: existing?.name ?? title,
            version: existing?.version ?? proxyVersion(serverVersion),
            description: existing?.description,
            context: existing?.context,
            url: upstream,
            auth: usesKey ? { type: "api-key", header: headerName, value: key || undefined } : undefined,
            capabilities,
            environmentId,
            existingEndpoint: existing && (endpointIn(existing, environmentId) ?? existing.endpoints?.[0]),
        });
        if (existing) {
            await api.updateMcpProxy(handle, body);
        } else {
            await api.createMcpProxy(body);
        }
        updateManifest(projectPath, (manifest) => ({ ...manifest, publishedMcpProxy: { id: handle, url: upstream } }));

        const tools = capabilities ? ` with ${capabilities.tools.length} tool${capabilities.tools.length === 1 ? "" : "s"}` : "";
        return `${existing ? "Updated" : "Published"} '${body.name}' in Agent Manager${tools}. Agents in ${session.org} can add it as an MCP server.`;
    });
}
