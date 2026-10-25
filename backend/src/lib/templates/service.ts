import { db } from '../db/client';
import {
  MessageTemplate,
  MessageTemplateVersion,
  MessageTemplateWithVersions,
  CreateTemplateRequest,
  UpdateTemplateRequest,
  TemplateStatus,
  TemplateType,
} from '@/types';
import {
  validateTemplate,
  assertValidTemplateType,
  assertValidTemplateStatus,
  TemplateValidationError,
  TemplateStateError,
} from './validator';

export class TemplateService {
  /**
   * Lists all message templates for a given project, including their active version details.
   */
  public static async listTemplates(projectId: string): Promise<MessageTemplate[]> {
    const result = await db.query<any>(
      `SELECT t.*,
              v.id as v_id,
              v.version_number as v_version_number,
              v.body as v_body,
              v.variables as v_variables,
              v.character_count as v_character_count,
              v.segment_count as v_segment_count,
              v.encoding as v_encoding,
              v.status as v_status,
              v.created_at as v_created_at,
              v.activated_at as v_activated_at
       FROM message_templates t
       LEFT JOIN message_template_versions v ON t.active_version_id = v.id
       WHERE t.project_id = $1
       ORDER BY t.created_at DESC`,
      [projectId]
    );

    return result.rows.map((row) => {
      const activeVersion: MessageTemplateVersion | null = row.v_id
        ? {
            id: row.v_id,
            template_id: row.id,
            version_number: row.v_version_number,
            body: row.v_body,
            variables: typeof row.v_variables === 'string' ? JSON.parse(row.v_variables) : row.v_variables || [],
            character_count: row.v_character_count,
            segment_count: row.v_segment_count,
            encoding: row.v_encoding,
            status: row.v_status,
            created_at: new Date(row.v_created_at),
            activated_at: row.v_activated_at ? new Date(row.v_activated_at) : null,
          }
        : null;

      return {
        id: row.id,
        project_id: row.project_id,
        name: row.name,
        slug: row.slug,
        template_type: row.template_type,
        description: row.description,
        status: row.status,
        active_version_id: row.active_version_id,
        dlt_template_id: row.dlt_template_id,
        sender_header: row.sender_header,
        pe_id: row.pe_id,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        active_version: activeVersion,
      };
    });
  }

  /**
   * Retrieves a single template by ID with its complete version history,
   * currently active version, and newest latest_version.
   */
  public static async getTemplate(
    templateId: string,
    projectId?: string
  ): Promise<MessageTemplateWithVersions | null> {
    const params: unknown[] = [templateId];
    let query = `SELECT * FROM message_templates WHERE id = $1`;
    if (projectId) {
      query += ` AND project_id = $2`;
      params.push(projectId);
    }

    const templateRes = await db.query<any>(query, params);
    if (templateRes.rows.length === 0) {
      return null;
    }

    const t = templateRes.rows[0];

    const versionsRes = await db.query<any>(
      `SELECT * FROM message_template_versions
       WHERE template_id = $1
       ORDER BY version_number DESC`,
      [templateId]
    );

    const versions: MessageTemplateVersion[] = versionsRes.rows.map((v) => ({
      id: v.id,
      template_id: v.template_id,
      version_number: v.version_number,
      body: v.body,
      variables: typeof v.variables === 'string' ? JSON.parse(v.variables) : v.variables || [],
      character_count: v.character_count,
      segment_count: v.segment_count,
      encoding: v.encoding,
      status: v.status,
      dlt_template_id: v.dlt_template_id,
      sender_header: v.sender_header,
      pe_id: v.pe_id,
      created_by: v.created_by,
      approved_by: v.approved_by,
      approved_at: v.approved_at ? new Date(v.approved_at) : null,
      created_at: new Date(v.created_at),
      activated_at: v.activated_at ? new Date(v.activated_at) : null,
    }));

    const activeVersion = (t.active_version_id && t.status === 'ACTIVE')
      ? versions.find((v) => v.id === t.active_version_id && v.status === 'ACTIVE') || null
      : null;

    const latestVersion = versions.length > 0 ? versions[0] : null;

    return {
      id: t.id,
      project_id: t.project_id,
      name: t.name,
      slug: t.slug,
      template_type: t.template_type,
      description: t.description,
      status: t.status,
      active_version_id: activeVersion ? activeVersion.id : null,
      dlt_template_id: t.dlt_template_id,
      sender_header: t.sender_header,
      pe_id: t.pe_id,
      created_at: new Date(t.created_at),
      updated_at: new Date(t.updated_at),
      active_version: activeVersion,
      latest_version: latestVersion,
      versions,
    };
  }

  /**
   * Retrieves the currently ACTIVE OTP template for a project.
   * Guarantees that template status is ACTIVE and the active version is ACTIVE.
   */
  public static async getActiveOtpTemplate(
    projectId: string
  ): Promise<(MessageTemplate & { active_version: MessageTemplateVersion }) | null> {
    const result = await db.query<any>(
      `SELECT t.*,
              v.id as v_id,
              v.version_number as v_version_number,
              v.body as v_body,
              v.variables as v_variables,
              v.character_count as v_character_count,
              v.segment_count as v_segment_count,
              v.encoding as v_encoding,
              v.status as v_status,
              v.created_at as v_created_at,
              v.activated_at as v_activated_at
       FROM message_templates t
       JOIN message_template_versions v ON t.active_version_id = v.id
       WHERE t.project_id = $1
         AND t.template_type = 'OTP'
         AND t.status = 'ACTIVE'
         AND v.status = 'ACTIVE'
       LIMIT 1`,
      [projectId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    const activeVersion: MessageTemplateVersion = {
      id: row.v_id,
      template_id: row.id,
      version_number: row.v_version_number,
      body: row.v_body,
      variables: typeof row.v_variables === 'string' ? JSON.parse(row.v_variables) : row.v_variables || [],
      character_count: row.v_character_count,
      segment_count: row.v_segment_count,
      encoding: row.v_encoding,
      status: row.v_status,
      created_at: new Date(row.v_created_at),
      activated_at: row.v_activated_at ? new Date(row.v_activated_at) : null,
    };

    return {
      id: row.id,
      project_id: row.project_id,
      name: row.name,
      slug: row.slug,
      template_type: row.template_type,
      description: row.description,
      status: row.status,
      active_version_id: row.active_version_id,
      dlt_template_id: row.dlt_template_id,
      sender_header: row.sender_header,
      pe_id: row.pe_id,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      active_version: activeVersion,
    };
  }

  /**
   * Creates a new message template in DRAFT status with initial v1 DRAFT version.
   * Direct creation as ACTIVE is strictly forbidden.
   * active_version_id is set to NULL until approved and activated.
   */
  public static async createTemplate(
    projectId: string,
    req: CreateTemplateRequest,
    createdBy = 'system'
  ): Promise<MessageTemplateWithVersions> {
    const templateType: TemplateType = assertValidTemplateType(req.template_type || 'OTP');

    if (req.status !== undefined) {
      assertValidTemplateStatus(req.status);
      if (req.status !== 'DRAFT') {
        const code = req.status === 'ACTIVE' ? 'DIRECT_ACTIVE_FORBIDDEN' : 'INVALID_CREATION_STATUS';
        throw new TemplateValidationError(
          `Invalid status '${req.status}' for template creation. Templates must start in DRAFT status.`,
          code,
          400
        );
      }
    }

    const validation = validateTemplate(req.body, templateType);
    if (!validation.valid) {
      throw new TemplateValidationError(
        `Template validation failed: ${validation.error}`,
        validation.code,
        400
      );
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 1. Insert message_template row with status DRAFT and active_version_id NULL
      const insertTemplateSql = `
        INSERT INTO message_templates (
          project_id, name, slug, template_type, description,
          status, active_version_id, dlt_template_id, sender_header, pe_id
        )
        VALUES ($1, $2, $3, $4, $5, 'DRAFT', NULL, $6, $7, $8)
        RETURNING *
      `;

      const tRes = await client.query<any>(insertTemplateSql, [
        projectId,
        req.name.trim(),
        req.slug.trim().toLowerCase(),
        templateType,
        req.description?.trim() || null,
        req.dlt_template_id?.trim() || null,
        req.sender_header?.trim() || null,
        req.pe_id?.trim() || null,
      ]);

      const templateRow = tRes.rows[0];

      // 2. Insert initial version row (v1) in DRAFT status
      const insertVersionSql = `
        INSERT INTO message_template_versions (
          template_id, version_number, body, variables,
          character_count, segment_count, encoding, status,
          dlt_template_id, sender_header, pe_id, created_by,
          approved_by, approved_at, activated_at
        )
        VALUES ($1, 1, $2, $3, $4, $5, $6, 'DRAFT', $7, $8, $9, $10, NULL, NULL, NULL)
        RETURNING *
      `;

      const vRes = await client.query<any>(insertVersionSql, [
        templateRow.id,
        req.body,
        JSON.stringify(validation.placeholders),
        validation.characterCount,
        validation.segmentCount,
        validation.encoding,
        req.dlt_template_id?.trim() || null,
        req.sender_header?.trim() || null,
        req.pe_id?.trim() || null,
        createdBy,
      ]);

      const versionRow = vRes.rows[0];
      await client.query('COMMIT');

      const version: MessageTemplateVersion = {
        id: versionRow.id,
        template_id: templateRow.id,
        version_number: 1,
        body: versionRow.body,
        variables: validation.placeholders,
        character_count: versionRow.character_count,
        segment_count: versionRow.segment_count,
        encoding: versionRow.encoding,
        status: 'DRAFT',
        dlt_template_id: versionRow.dlt_template_id,
        sender_header: versionRow.sender_header,
        pe_id: versionRow.pe_id,
        created_by: versionRow.created_by,
        approved_by: null,
        approved_at: null,
        created_at: new Date(versionRow.created_at),
        activated_at: null,
      };

      return {
        id: templateRow.id,
        project_id: templateRow.project_id,
        name: templateRow.name,
        slug: templateRow.slug,
        template_type: templateRow.template_type,
        description: templateRow.description,
        status: 'DRAFT',
        active_version_id: null,
        dlt_template_id: templateRow.dlt_template_id,
        sender_header: templateRow.sender_header,
        pe_id: templateRow.pe_id,
        created_at: new Date(templateRow.created_at),
        updated_at: new Date(),
        active_version: null,
        latest_version: version,
        versions: [version],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Updates template metadata and optionally creates a new DRAFT version if body is updated.
   * If the template is currently ACTIVE, it remains ACTIVE and continues sending with its
   * active version undisturbed until the new draft version is approved and activated.
   */
  public static async updateTemplate(
    templateId: string,
    projectId: string,
    req: UpdateTemplateRequest,
    updatedBy = 'system'
  ): Promise<MessageTemplateWithVersions> {
    const existing = await this.getTemplate(templateId, projectId);
    if (!existing) {
      throw new Error('Template not found');
    }

    if (existing.status === 'ARCHIVED') {
      throw new TemplateStateError('Cannot edit an ARCHIVED template.', 'ARCHIVED_TEMPLATE', 409);
    }

    if (req.status !== undefined) {
      throw new TemplateValidationError(
        'Status cannot be updated via PATCH. Lifecycle changes must use approve, activate, or archive endpoints.',
        'DIRECT_STATUS_MUTATION_FORBIDDEN',
        400
      );
    }

    let validationResult: ReturnType<typeof validateTemplate> | null = null;
    if (req.body !== undefined) {
      if (typeof req.body !== 'string' || req.body.trim().length === 0) {
        throw new TemplateValidationError(
          'Template body cannot be empty',
          'EMPTY_BODY',
          400
        );
      }
      const validation = validateTemplate(req.body, existing.template_type);
      if (!validation.valid) {
        throw new TemplateValidationError(
          `Template validation failed: ${validation.error}`,
          validation.code,
          400
        );
      }
      validationResult = validation;
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // If body is updated and differs from latest version, insert new DRAFT version
      const latestBody = existing.latest_version?.body;
      if (req.body !== undefined && validationResult && req.body !== latestBody) {
        const maxVerRes = await client.query<{ max_ver: number }>(
          `SELECT COALESCE(MAX(version_number), 0) as max_ver FROM message_template_versions WHERE template_id = $1`,
          [templateId]
        );
        const nextVersionNumber = (maxVerRes.rows[0]?.max_ver || 0) + 1;

        const insertVersionSql = `
          INSERT INTO message_template_versions (
            template_id, version_number, body, variables,
            character_count, segment_count, encoding, status,
            dlt_template_id, sender_header, pe_id, created_by,
            approved_by, approved_at, activated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8, $9, $10, $11, NULL, NULL, NULL)
          RETURNING *
        `;

        await client.query<any>(insertVersionSql, [
          templateId,
          nextVersionNumber,
          req.body,
          JSON.stringify(validationResult.placeholders),
          validationResult.characterCount,
          validationResult.segmentCount,
          validationResult.encoding,
          req.dlt_template_id?.trim() || existing.dlt_template_id,
          req.sender_header?.trim() || existing.sender_header,
          req.pe_id?.trim() || existing.pe_id,
          updatedBy,
        ]);
      }

      // Update template metadata
      const updateFields: string[] = ['updated_at = NOW()'];
      const updateParams: unknown[] = [templateId, projectId];
      let paramIdx = 3;

      if (req.name) {
        updateFields.push(`name = $${paramIdx++}`);
        updateParams.push(req.name.trim());
      }
      if (req.description !== undefined) {
        updateFields.push(`description = $${paramIdx++}`);
        updateParams.push(req.description ? req.description.trim() : null);
      }
      if (req.dlt_template_id !== undefined) {
        updateFields.push(`dlt_template_id = $${paramIdx++}`);
        updateParams.push(req.dlt_template_id ? req.dlt_template_id.trim() : null);
      }
      if (req.sender_header !== undefined) {
        updateFields.push(`sender_header = $${paramIdx++}`);
        updateParams.push(req.sender_header ? req.sender_header.trim() : null);
      }
      if (req.pe_id !== undefined) {
        updateFields.push(`pe_id = $${paramIdx++}`);
        updateParams.push(req.pe_id ? req.pe_id.trim() : null);
      }

      const updateSql = `
        UPDATE message_templates
        SET ${updateFields.join(', ')}
        WHERE id = $1 AND project_id = $2
        RETURNING *
      `;

      await client.query<any>(updateSql, updateParams);
      await client.query('COMMIT');

      const updated = await this.getTemplate(templateId, projectId);
      return updated!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Explicitly approves a DRAFT version.
   * Populates approved_by and approved_at.
   */
  public static async approveTemplate(
    templateId: string,
    projectId: string,
    approvedBy: string,
    versionId?: string
  ): Promise<MessageTemplateWithVersions> {
    const template = await this.getTemplate(templateId, projectId);
    if (!template) {
      throw new Error('Template not found');
    }

    if (template.status === 'ARCHIVED') {
      throw new TemplateStateError('Cannot approve an ARCHIVED template.', 'ARCHIVED_TEMPLATE', 409);
    }

    // Determine target version to approve
    let targetVersion = versionId
      ? template.versions.find((v) => v.id === versionId)
      : template.latest_version;

    if (!targetVersion) {
      throw new Error('Target version not found');
    }

    if (targetVersion.status === 'ARCHIVED') {
      throw new TemplateStateError('Cannot approve an ARCHIVED version.', 'ARCHIVED_VERSION', 409);
    }
    if (targetVersion.status === 'ACTIVE') {
      throw new TemplateStateError('Version is already ACTIVE.', 'ALREADY_ACTIVE', 409);
    }
    if (targetVersion.status === 'APPROVED') {
      // Idempotent
      return template;
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE message_template_versions
         SET status = 'APPROVED', approved_by = $1, approved_at = NOW()
         WHERE id = $2 AND template_id = $3`,
        [approvedBy, targetVersion.id, templateId]
      );

      // If parent template is in DRAFT, transition to APPROVED
      if (template.status === 'DRAFT') {
        await client.query(
          `UPDATE message_templates
           SET status = 'APPROVED', updated_at = NOW()
           WHERE id = $1 AND project_id = $2`,
          [templateId, projectId]
        );
      }

      await client.query('COMMIT');

      const updated = await this.getTemplate(templateId, projectId);
      return updated!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Activates a template version. Accepts ONLY an APPROVED version.
   * Atomically demotes previously active versions and other active OTP templates in project.
   */
  public static async activateTemplate(
    templateId: string,
    projectId: string,
    versionId?: string
  ): Promise<MessageTemplateWithVersions> {
    const template = await this.getTemplate(templateId, projectId);
    if (!template) {
      throw new Error('Template not found');
    }

    if (template.status === 'ARCHIVED') {
      throw new TemplateStateError('Cannot activate an ARCHIVED template. Explicit restoration flow required.', 'ARCHIVED_TEMPLATE', 409);
    }

    // Determine version to activate
    let targetVersion = versionId
      ? template.versions.find((v) => v.id === versionId)
      : template.versions.find((v) => v.status === 'APPROVED') || template.latest_version;

    if (!targetVersion) {
      throw new Error('Target version not found');
    }

    if (targetVersion.status === 'DRAFT') {
      throw new TemplateStateError(
        'Version is in DRAFT status. Versions must be APPROVED before activation.',
        'MUST_BE_APPROVED',
        409
      );
    }

    if (targetVersion.status === 'ARCHIVED') {
      throw new TemplateStateError(
        'Version is ARCHIVED. Cannot activate an archived version.',
        'ARCHIVED_VERSION',
        409
      );
    }

    // If already active and parent is active, return idempotently
    if (targetVersion.status === 'ACTIVE' && template.status === 'ACTIVE' && template.active_version_id === targetVersion.id) {
      return template;
    }

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 1. If OTP template, demote any other active OTP template and its versions in this project
      if (template.template_type === 'OTP') {
        await client.query(
          `UPDATE message_template_versions
           SET status = 'APPROVED'
           WHERE template_id IN (
             SELECT id FROM message_templates
             WHERE project_id = $1 AND template_type = 'OTP' AND id != $2 AND status = 'ACTIVE'
           ) AND status = 'ACTIVE'`,
          [projectId, templateId]
        );

        await client.query(
          `UPDATE message_templates
           SET status = 'APPROVED', active_version_id = NULL, updated_at = NOW()
           WHERE project_id = $1 AND template_type = 'OTP' AND id != $2 AND status = 'ACTIVE'`,
          [projectId, templateId]
        );
      }

      // 2. Demote any current active version of this template to APPROVED
      await client.query(
        `UPDATE message_template_versions
         SET status = 'APPROVED'
         WHERE template_id = $1 AND status = 'ACTIVE'`,
        [templateId]
      );

      // 3. Mark the target version as ACTIVE
      await client.query(
        `UPDATE message_template_versions
         SET status = 'ACTIVE', activated_at = NOW()
         WHERE id = $1 AND template_id = $2`,
        [targetVersion.id, templateId]
      );

      // 4. Mark template as ACTIVE with active_version_id
      await client.query(
        `UPDATE message_templates
         SET status = 'ACTIVE',
             active_version_id = $1,
             updated_at = NOW()
         WHERE id = $2 AND project_id = $3`,
        [targetVersion.id, templateId, projectId]
      );

      await client.query('COMMIT');

      const updated = await this.getTemplate(templateId, projectId);
      return updated!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Archives a template (soft-delete).
   * Confirms template ownership before mutating any records.
   * If templateId does not match projectId, performs zero mutations and returns false.
   */
  public static async archiveTemplate(
    templateId: string,
    projectId: string
  ): Promise<boolean> {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // 1. Confirm template ownership inside transaction with FOR UPDATE
      const check = await client.query(
        `SELECT id FROM message_templates WHERE id = $1 AND project_id = $2 FOR UPDATE`,
        [templateId, projectId]
      );

      if ((check.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        return false; // Zero mutations performed
      }

      // 2. Archive all versions belonging to this verified template
      await client.query(
        `UPDATE message_template_versions
         SET status = 'ARCHIVED'
         WHERE template_id = $1`,
        [templateId]
      );

      // 3. Archive parent template and clear active_version_id
      await client.query(
        `UPDATE message_templates
         SET status = 'ARCHIVED', active_version_id = NULL, updated_at = NOW()
         WHERE id = $1 AND project_id = $2`,
        [templateId, projectId]
      );

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
