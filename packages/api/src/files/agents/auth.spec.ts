import { SystemRoles, PermissionBits } from 'librechat-data-provider';
import { checkAgentUploadAuth } from './auth';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

describe('checkAgentUploadAuth', () => {
  const agent = { _id: 'agent-object-id', author: { toString: () => 'owner-id' } };
  const getAgent = jest.fn().mockResolvedValue(agent);
  const checkPermission = jest.fn().mockResolvedValue(false);

  beforeEach(() => {
    jest.clearAllMocks();
    getAgent.mockResolvedValue(agent);
    checkPermission.mockResolvedValue(false);
  });

  it('denies a permanent upload with no tool resource from a user without edit permission', async () => {
    const result = await checkAgentUploadAuth(
      { userId: 'attacker-id', userRole: SystemRoles.USER, agentId: 'victim-agent' },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(false);
    expect(checkPermission).toHaveBeenCalled();
  });

  it('allows a permanent upload with no tool resource when the user may edit the agent', async () => {
    checkPermission.mockResolvedValue(true);

    const result = await checkAgentUploadAuth(
      { userId: 'editor-id', userRole: SystemRoles.USER, agentId: 'shared-agent' },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(true);
  });

  it('lets a capability holder bypass the ACL', async () => {
    const result = await checkAgentUploadAuth(
      { userId: 'manager-id', userRole: SystemRoles.USER, agentId: 'victim-agent' },
      { getAgent, checkPermission, hasUploadBypass: jest.fn().mockResolvedValue(true) },
    );

    expect(result.allowed).toBe(true);
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it('reports a missing agent even to a caller holding the bypass', async () => {
    /* The bypass waives the ACL decision, not the agent's existence: letting a stale id
     * through would surface as a late failure once processing has already written the
     * file to remote storage. */
    getAgent.mockResolvedValue(null);

    const result = await checkAgentUploadAuth(
      { userId: 'manager-id', userRole: SystemRoles.USER, agentId: 'missing-agent' },
      { getAgent, checkPermission, hasUploadBypass: jest.fn().mockResolvedValue(true) },
    );

    expect(result).toMatchObject({ allowed: false, status: 404 });
  });

  it('reports a missing agent to an admin rather than proceeding', async () => {
    getAgent.mockResolvedValue(null);

    const result = await checkAgentUploadAuth(
      { userId: 'admin-id', userRole: SystemRoles.ADMIN, agentId: 'missing-agent' },
      { getAgent, checkPermission },
    );

    expect(result).toMatchObject({ allowed: false, status: 404 });
  });

  it('denies the bypass when the capability check throws', async () => {
    const result = await checkAgentUploadAuth(
      { userId: 'manager-id', userRole: SystemRoles.USER, agentId: 'victim-agent' },
      {
        getAgent,
        checkPermission,
        hasUploadBypass: jest.fn().mockRejectedValue(new Error('capability lookup failed')),
      },
    );

    expect(result.allowed).toBe(false);
    expect(checkPermission).toHaveBeenCalled();
  });

  it('allows the agent author without consulting permissions', async () => {
    const result = await checkAgentUploadAuth(
      { userId: 'owner-id', userRole: SystemRoles.USER, agentId: 'own-agent' },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(true);
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it('asks only for view access on a message attachment', async () => {
    /* The attachment belongs to the conversation rather than the agent, so edit access is
     * too much. Skipping the check entirely was too little: the upload is validated under
     * the named agent's provider, so its rejections describe a record the caller may not
     * be allowed to see. */
    checkPermission.mockResolvedValue(true);

    const result = await checkAgentUploadAuth(
      {
        userId: 'viewer-id',
        userRole: SystemRoles.USER,
        agentId: 'shared-agent',
        messageFile: 'true',
      },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(true);
    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermission: PermissionBits.VIEW }),
    );
  });

  it('denies a message attachment naming an agent the caller cannot view', async () => {
    const result = await checkAgentUploadAuth(
      {
        userId: 'attacker-id',
        userRole: SystemRoles.USER,
        agentId: 'victim-agent',
        messageFile: 'true',
      },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(false);
  });

  it('leaves an upload naming no agent alone', async () => {
    const result = await checkAgentUploadAuth(
      { userId: 'any-user', userRole: SystemRoles.USER, messageFile: 'true' },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(true);
    expect(getAgent).not.toHaveBeenCalled();
  });

  it('still denies when a tool resource is supplied without permission', async () => {
    const result = await checkAgentUploadAuth(
      {
        userId: 'attacker-id',
        userRole: SystemRoles.USER,
        agentId: 'victim-agent',
        toolResource: 'context',
      },
      { getAgent, checkPermission },
    );

    expect(result.allowed).toBe(false);
  });
});
