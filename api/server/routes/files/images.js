const path = require('path');
const fs = require('fs').promises;
const express = require('express');
const { logger, SystemCapabilities } = require('@librechat/data-schemas');
const {
  getSafeErrorMetadata,
  shouldUseUploadSse,
  startUploadSseStream,
  sendUploadPolicyError,
  resolveUploadErrorMessage,
  verifyAgentUploadPermission,
  assertUploadContentAllowed,
  hasActiveFilePolicy,
  sanitizeFilename,
  resolveUploadRouting,
} = require('@librechat/api');
const {
  isAssistantsEndpoint,
  hasActivePiiPatterns,
  mergeFileConfig,
} = require('librechat-data-provider');
const {
  processAgentFileUpload,
  processImageFile,
  resolvesToTextDelivery,
  filterFile,
} = require('~/server/services/Files/process');
const { hasCapability } = require('~/server/middleware/roles/capabilities');
const { checkPermission } = require('~/server/services/PermissionService');
const db = require('~/models');

const router = express.Router();

router.post('/', async (req, res) => {
  const metadata = req.body;
  const appConfig = req.config;

  /** Opened only once auth/validation has passed, right before the potentially
   * long-running upload processing begins — see `startUploadSseStream`. */
  let sseStream = null;
  const openSseStreamIfRequested = () => {
    if (shouldUseUploadSse(req)) {
      sseStream = startUploadSseStream(res);
    }
  };

  try {
    req.file.originalname = sanitizeFilename(req.file.originalname);

    /* Same ordering as the file route: resolve the agent once so the provider's limits
     * govern validation and the preflight sees the effective resource, then hand the
     * record to authorization rather than reading it again. */
    const isAgentUpload = !isAssistantsEndpoint(metadata.endpoint);
    const uploadAgent =
      isAgentUpload && metadata.agent_id ? await db.getAgent({ id: metadata.agent_id }) : undefined;
    const uploadRouting = isAgentUpload
      ? resolveUploadRouting({
          file: req.file,
          requestEndpoint: metadata.endpoint,
          agentProvider: uploadAgent?.provider,
          agentId: metadata.agent_id,
          toolResource: metadata.tool_resource,
          messageAttachment: metadata.message_file === true || metadata.message_file === 'true',
          fileConfig: mergeFileConfig(req.config?.fileConfig),
        })
      : undefined;

    filterFile({ req, image: true, endpointConfig: uploadRouting?.endpointConfig });

    /* An image the config routes to text delivery has to go through the agent upload
     * path, which extracts and stores the text. The image pipeline would persist the
     * routing without any text, leaving the file out of provider delivery and out of
     * the text context both. */
    const takesAgentUploadPath =
      metadata.tool_resource != null || (await resolvesToTextDelivery({ req, metadata }));

    await assertUploadContentAllowed({
      filters: req.config?.filters,
      file: req.file,
      endpoint: uploadRouting?.endpoint ?? metadata.endpoint,
      /* Only the path that extracts may be shown the promoted resource: an upload
       * falling through to `processImageFile` runs no OCR, so deferring a fail-closed
       * policy there would accept it uninspected. */
      toolResource:
        uploadRouting && takesAgentUploadPath
          ? uploadRouting.effectiveToolResource
          : metadata.tool_resource,
      fileConfig: mergeFileConfig(req.config?.fileConfig),
      ocrConfigured: req.config?.ocr != null,
      ragConfigured: !!process.env.RAG_API_URL,
      rawFileMode: 'opaque',
    });

    metadata.temp_file_id = metadata.file_id;
    metadata.file_id = req.file_id;

    /* Authorize whenever the upload names an agent, not only when it names a tool
     * resource: message attachments are exempt inside the check, so what remains is
     * a permanent upload against that agent. The authorized record is reused for
     * routing so the provider is not read a second time. */
    if (isAgentUpload && metadata.agent_id != null) {
      /* Capability holders bypass agent ACLs on writes, as the sibling `/files` route
       * already does; a failed check denies the bypass rather than granting it. */
      let skipUploadAuth = false;
      try {
        skipUploadAuth = await hasCapability(req.user, SystemCapabilities.MANAGE_AGENTS);
      } catch (err) {
        logger.warn(
          '[/files/images] capability check failed, denying bypass:',
          getSafeErrorMetadata(err),
        );
      }

      if (!skipUploadAuth) {
        const { denied } = await verifyAgentUploadPermission({
          req,
          res,
          metadata,
          agent: uploadAgent ?? null,
          getAgent: db.getAgent,
          checkPermission,
        });
        if (denied) {
          return;
        }
      }
    }

    if (isAgentUpload && takesAgentUploadPath) {
      openSseStreamIfRequested();
      return await processAgentFileUpload({ req, res, metadata, sseStream, uploadAgent });
    }

    openSseStreamIfRequested();
    await processImageFile({ req, res, metadata, sseStream, uploadAgent });
  } catch (error) {
    // TODO: delete remote file if it exists
    logger.error('[/files/images] Error processing file:', getSafeErrorMetadata(error));

    try {
      const filepath = path.join(
        appConfig.paths.imageOutput,
        req.user.id,
        path.basename(req.file.filename),
      );
      await fs.unlink(filepath);
    } catch (cleanupError) {
      logger.error('[/files/images] Error deleting file:', getSafeErrorMetadata(cleanupError));
    }
    if (
      sendUploadPolicyError(res, sseStream, error, {
        tempFileId: metadata.temp_file_id,
        toolResource: metadata.tool_resource,
      })
    ) {
      return;
    }
    const contentProtectionActive =
      hasActiveFilePolicy(req.config?.filters) ||
      hasActivePiiPatterns(req.config?.messageFilter?.pii);
    const message = resolveUploadErrorMessage(
      error,
      'Error processing file',
      contentProtectionActive,
    );
    if (sseStream) {
      sseStream.sendError({
        message,
        code: 500,
        temp_file_id: metadata.temp_file_id,
        tool_resource: metadata.tool_resource,
        display_to_user: true,
      });
    } else {
      res.status(500).json({ message });
    }
  } finally {
    try {
      await fs.unlink(req.file.path);
      logger.debug('[/files/images] Temp. image upload file deleted');
    } catch {
      logger.debug('[/files/images] Temp. image upload file already deleted');
    }
    if (sseStream) {
      sseStream.close();
    }
  }
});

module.exports = router;
