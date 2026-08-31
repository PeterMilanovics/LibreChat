import { logger } from '@librechat/data-schemas';
import { SystemRoles, ResourceType, PermissionBits } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { Types } from 'mongoose';
import type { ServerRequest } from '~/types';

/** The agent an upload targets, as far as authorization and routing need it. */
export interface AuthorizedUploadAgent {
  _id: string | Types.ObjectId;
  author?: string | Types.ObjectId | null;
  provider?: string;
}

export type AgentUploadAuthResult =
  | { allowed: true; agent?: AuthorizedUploadAgent }
  | { allowed: false; status: number; error: string; message: string };

export interface AgentUploadAuthParams {
  userId: string;
  userRole: string;
  agentId?: string;
  toolResource?: string | null;
  messageFile?: boolean | string;
  /** Already-loaded agent, when the caller resolved it for routing. Avoids reading
   *  the same record twice on an upload that has to route before it validates. */
  agent?: AuthorizedUploadAgent | null;
}

export interface AgentUploadAuthDeps {
  getAgent: (params: { id: string }) => Promise<AuthorizedUploadAgent | null>;
  checkPermission: (params: {
    userId: string;
    role: string;
    resourceType: ResourceType;
    resourceId: string | Types.ObjectId;
    requiredPermission: number;
  }) => Promise<boolean>;
}

export async function checkAgentUploadAuth(
  params: AgentUploadAuthParams,
  deps: AgentUploadAuthDeps,
): Promise<AgentUploadAuthResult> {
  const { userId, userRole, agentId, messageFile } = params;
  const { getAgent, checkPermission } = deps;

  const isMessageAttachment = messageFile === true || messageFile === 'true';
  /* Any permanent upload against an agent can mutate that agent's resources, so it
   * needs edit permission whether or not the request names a tool resource: unified
   * uploads omit it and are promoted to a context resource during processing. Only
   * message attachments, which belong to the conversation rather than the agent,
   * skip the check. */
  if (!agentId || isMessageAttachment) {
    return { allowed: true };
  }

  /* The agent is returned alongside the verdict so callers can route the upload from
   * its provider without a second read of the same record, and accepted as input for
   * callers that had to resolve it before validation. */
  const agent = params.agent !== undefined ? params.agent : await getAgent({ id: agentId });
  if (userRole === SystemRoles.ADMIN) {
    return { allowed: true, agent: agent ?? undefined };
  }

  if (!agent) {
    return { allowed: false, status: 404, error: 'Not Found', message: 'Agent not found' };
  }

  if (agent.author?.toString() === userId) {
    return { allowed: true, agent };
  }

  const hasEditPermission = await checkPermission({
    userId,
    role: userRole,
    resourceType: ResourceType.AGENT,
    resourceId: agent._id,
    requiredPermission: PermissionBits.EDIT,
  });

  if (hasEditPermission) {
    return { allowed: true, agent };
  }

  logger.warn(
    `[agentUploadAuth] User ${userId} denied upload to agent ${agentId} (insufficient permissions)`,
  );
  return {
    allowed: false,
    status: 403,
    error: 'Forbidden',
    message: 'Insufficient permissions to upload files to this agent',
  };
}

/** Sends the error response when denied. Returns the authorized agent when it loaded
 *  one, so the caller can route the upload without reading the record again. */
export async function verifyAgentUploadPermission({
  req,
  res,
  metadata,
  agent,
  getAgent,
  checkPermission,
}: {
  req: ServerRequest;
  res: Response;
  metadata: { agent_id?: string; tool_resource?: string | null; message_file?: boolean | string };
  /** Pre-resolved agent, when the caller already loaded it. */
  agent?: AuthorizedUploadAgent | null;
  getAgent: AgentUploadAuthDeps['getAgent'];
  checkPermission: AgentUploadAuthDeps['checkPermission'];
}): Promise<{ denied: boolean; agent?: AuthorizedUploadAgent }> {
  const user = req.user as IUser;
  const result = await checkAgentUploadAuth(
    {
      userId: user.id,
      userRole: user.role ?? '',
      agentId: metadata.agent_id,
      toolResource: metadata.tool_resource,
      messageFile: metadata.message_file,
      agent,
    },
    { getAgent, checkPermission },
  );

  if (!result.allowed) {
    res.status(result.status).json({ error: result.error, message: result.message });
    return { denied: true };
  }
  return { denied: false, agent: result.agent };
}
