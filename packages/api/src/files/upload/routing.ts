import {
  EToolResources,
  getEndpointFileConfig,
  resolveDefaultLLMDeliveryPath,
} from 'librechat-data-provider';
import type {
  EndpointFileConfig,
  FileConfig,
  TDefaultLLMDeliveryPath,
} from 'librechat-data-provider';

export interface UploadRoutingInput {
  /** Uploaded file, before persistence. */
  readonly file: { readonly mimetype?: string };
  /** Endpoint posted with the request, typically `agents` for agent uploads. */
  readonly requestEndpoint?: string | null;
  /** Provider of the agent this upload targets, when it targets one. */
  readonly agentProvider?: string | null;
  readonly agentId?: string | null;
  readonly toolResource?: string | null;
  readonly messageAttachment?: boolean;
  readonly fileConfig: FileConfig;
}

export interface UploadRouting {
  /** Endpoint whose file config governs this upload. */
  readonly endpoint?: string;
  readonly endpointConfig: EndpointFileConfig;
  readonly llmDeliveryPath: TDefaultLLMDeliveryPath;
  /** Resource the upload behaves as, after OCR aliasing and text-path promotion. */
  readonly effectiveToolResource?: string;
  /** Legacy mode requires an explicit tool resource for permanent agent uploads. */
  readonly requiresExplicitToolResource: boolean;
}

/**
 * Resolves every routing decision an upload needs, in one place and before the route
 * validates anything. Filtering, content preflight, extraction planning, and delivery
 * all consume the same answer, so a provider's limits and a promoted resource cannot
 * disagree with what processing later decides.
 *
 * Pure by design: the caller loads and authorizes the agent, then passes its provider.
 */
export function resolveUploadRouting(input: UploadRoutingInput): UploadRouting {
  const { file, requestEndpoint, agentProvider, agentId, toolResource, fileConfig } = input;
  const messageAttachment = input.messageAttachment === true;

  /** An agent upload posts `agents`; the agent's own provider is what governs limits
   *  and delivery, so it wins whenever the agent could be resolved. */
  const endpoint = agentProvider || requestEndpoint || undefined;
  const endpointConfig = getEndpointFileConfig({ fileConfig, endpoint });

  const llmDeliveryPath = resolveDeliveryPath({
    toolResource,
    mimeType: file.mimetype ?? '',
    endpointConfig,
    fileConfig,
    endpoint,
  });

  let effectiveToolResource =
    toolResource === EToolResources.ocr ? EToolResources.context : (toolResource ?? undefined);
  if (!toolResource && llmDeliveryPath === 'text') {
    effectiveToolResource = EToolResources.context;
  }

  const requiresExplicitToolResource =
    agentId != null &&
    !toolResource &&
    !messageAttachment &&
    endpointConfig?.legacyFileUploadUX === true;

  return {
    endpoint,
    endpointConfig,
    llmDeliveryPath,
    effectiveToolResource,
    requiresExplicitToolResource,
  };
}

function resolveDeliveryPath({
  toolResource,
  mimeType,
  endpointConfig,
  fileConfig,
  endpoint,
}: {
  toolResource?: string | null;
  mimeType: string;
  endpointConfig: EndpointFileConfig;
  fileConfig: FileConfig;
  endpoint?: string;
}): TDefaultLLMDeliveryPath {
  if (toolResource === EToolResources.context || toolResource === EToolResources.ocr) {
    return 'text';
  }
  if (toolResource === EToolResources.file_search || toolResource === EToolResources.execute_code) {
    return 'none';
  }
  if (endpointConfig?.legacyFileUploadUX === true) {
    return 'provider';
  }
  return resolveDefaultLLMDeliveryPath(
    mimeType,
    endpointConfig?.defaultLLMDeliveryPath,
    fileConfig?.defaultLLMDeliveryPath,
    endpoint,
  );
}
