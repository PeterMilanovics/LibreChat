import { EModelEndpoint, EToolResources, mergeFileConfig } from 'librechat-data-provider';
import { resolveUploadRouting } from './routing';

const fileConfig = (overrides = {}) => mergeFileConfig(overrides);

describe('resolveUploadRouting', () => {
  it('governs the upload by the agent provider rather than the posted endpoint', () => {
    const routing = resolveUploadRouting({
      file: { mimetype: 'application/pdf' },
      requestEndpoint: EModelEndpoint.agents,
      agentProvider: EModelEndpoint.openAI,
      agentId: 'agent-1',
      fileConfig: fileConfig(),
    });

    expect(routing.endpoint).toBe(EModelEndpoint.openAI);
  });

  it('falls back to the request endpoint when no agent provider resolved', () => {
    const routing = resolveUploadRouting({
      file: { mimetype: 'application/pdf' },
      requestEndpoint: EModelEndpoint.agents,
      agentId: 'ephemeral',
      fileConfig: fileConfig(),
    });

    expect(routing.endpoint).toBe(EModelEndpoint.agents);
    expect(routing.llmDeliveryPath).toBe('provider');
  });

  it('promotes an unclassified text-routed upload to the context resource', () => {
    const routing = resolveUploadRouting({
      file: { mimetype: 'text/markdown' },
      requestEndpoint: EModelEndpoint.agents,
      agentProvider: EModelEndpoint.openAI,
      agentId: 'agent-1',
      fileConfig: fileConfig(),
    });

    expect(routing.llmDeliveryPath).toBe('text');
    expect(routing.effectiveToolResource).toBe(EToolResources.context);
  });

  it('does not promote an upload the provider will receive natively', () => {
    const routing = resolveUploadRouting({
      file: { mimetype: 'image/png' },
      requestEndpoint: EModelEndpoint.agents,
      agentProvider: EModelEndpoint.openAI,
      agentId: 'agent-1',
      fileConfig: fileConfig(),
    });

    expect(routing.llmDeliveryPath).toBe('provider');
    expect(routing.effectiveToolResource).toBeUndefined();
  });

  it('aliases an ocr resource onto context', () => {
    const routing = resolveUploadRouting({
      file: { mimetype: 'application/pdf' },
      requestEndpoint: EModelEndpoint.agents,
      agentId: 'agent-1',
      toolResource: EToolResources.ocr,
      fileConfig: fileConfig(),
    });

    expect(routing.effectiveToolResource).toBe(EToolResources.context);
    expect(routing.llmDeliveryPath).toBe('text');
  });

  it('keeps explicit tool resources off the model delivery path', () => {
    for (const toolResource of [EToolResources.file_search, EToolResources.execute_code]) {
      const routing = resolveUploadRouting({
        file: { mimetype: 'text/csv' },
        requestEndpoint: EModelEndpoint.agents,
        agentId: 'agent-1',
        toolResource,
        fileConfig: fileConfig(),
      });

      expect(routing.llmDeliveryPath).toBe('none');
      expect(routing.effectiveToolResource).toBe(toolResource);
    }
  });

  it('reports when legacy mode requires an explicit tool resource', () => {
    const legacy = fileConfig({
      endpoints: { [EModelEndpoint.openAI]: { legacyFileUploadUX: true } },
    });

    const routing = resolveUploadRouting({
      file: { mimetype: 'text/markdown' },
      requestEndpoint: EModelEndpoint.agents,
      agentProvider: EModelEndpoint.openAI,
      agentId: 'agent-1',
      fileConfig: legacy,
    });

    expect(routing.requiresExplicitToolResource).toBe(true);
    expect(routing.llmDeliveryPath).toBe('provider');
  });

  it('exempts message attachments from the legacy requirement', () => {
    const legacy = fileConfig({
      endpoints: { [EModelEndpoint.openAI]: { legacyFileUploadUX: true } },
    });

    const routing = resolveUploadRouting({
      file: { mimetype: 'text/markdown' },
      requestEndpoint: EModelEndpoint.agents,
      agentProvider: EModelEndpoint.openAI,
      agentId: 'agent-1',
      messageAttachment: true,
      fileConfig: legacy,
    });

    expect(routing.requiresExplicitToolResource).toBe(false);
  });

  it('exposes the provider file config so limits match delivery routing', () => {
    const restrictive = fileConfig({
      endpoints: { [EModelEndpoint.openAI]: { fileSizeLimit: 5 } },
    });

    const routing = resolveUploadRouting({
      file: { mimetype: 'application/pdf' },
      requestEndpoint: EModelEndpoint.agents,
      agentProvider: EModelEndpoint.openAI,
      agentId: 'agent-1',
      fileConfig: restrictive,
    });

    expect(routing.endpointConfig.fileSizeLimit).toBe(5 * 1024 * 1024);
  });
});
