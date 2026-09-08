import type { FastifyInstance } from 'fastify';
import { authenticate, requireAdmin, userIdOf } from '../plugins/auth.js';
import { toClientPin } from '../services/pinDto.js';
import { validateTrailDraft, type DraftPin } from '../services/trailValidation.js';
import {
  MIN_COHORT_SIZE,
  parseAnalyticsRange,
  summarizeFunnel,
  summarizeTrail,
  type ParsedRange,
} from '../services/analytics.js';
import type { NewPinInput, PinReportStatus } from '../db/types.js';

/** Echoes the window actually applied, so a caller can tell "all time" from "empty week". */
function rangeResponse(range: ParsedRange) {
  return {
    from: range.from ? range.from.toISOString() : null,
    to: range.to ? range.to.toISOString() : null,
  };
}

/**
 * Authoring API (EPIC 7). This is the backend the desktop Admin tool drives — ST-7.1's 3D map
 * UI is a separate client, but nothing could author a trail without these endpoints, so they
 * come first. Every route here is Admin-only.
 *
 * SR-ADMIN-01/02 warnings are advisory: a publish carrying warnings still succeeds, and the
 * warnings come back in the response for the Admin tool to show. Only structural errors — the
 * ones that would produce an unplayable trail — block.
 */

const pinSchema = {
  type: 'object',
  required: ['sequenceIndex', 'lat', 'lng', 'radiusM', 'challengeType'],
  additionalProperties: false,
  properties: {
    sequenceIndex: { type: 'integer', minimum: 1 },
    lat: { type: 'number' },
    lng: { type: 'number' },
    alt: { type: ['number', 'null'] },
    radiusM: { type: 'number' },
    challengeType: { type: 'string' },
    challengeConfig: { type: 'object', additionalProperties: true },
  },
} as const;

const createTrailSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    // GDR-08: null/absent means no expiry, which is the default.
    expiryDays: { type: ['integer', 'null'], minimum: 1 },
  },
} as const;

const publishVersionSchema = {
  type: 'object',
  required: ['pins'],
  additionalProperties: false,
  properties: {
    pins: { type: 'array', minItems: 1, maxItems: 200, items: pinSchema },
  },
} as const;

const REPORT_STATUSES: readonly PinReportStatus[] = ['open', 'reviewed', 'resolved'];

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const adminOnly = { onRequest: [authenticate, requireAdmin] };

  // ST-7.2 — create the trail shell. Pins arrive with its first published version.
  app.post(
    '/api/v1/admin/trails',
    { ...adminOnly, schema: { body: createTrailSchema } },
    async (request, reply) => {
      const { name, expiryDays } = request.body as { name: string; expiryDays?: number | null };

      const trail = await app.store.createTrail({
        name,
        createdBy: userIdOf(request),
        expiryDays: expiryDays ?? null,
      });

      return reply.code(201).send({
        trailId: trail.id,
        name: trail.name,
        expiryDays: trail.expiryDays,
        currentVersionId: trail.currentVersionId,
      });
    },
  );

  // ST-7.2 / GDR-07 — publish a version. Editing a published trail means publishing a new
  // version; players mid-attempt keep the one they started on.
  app.post(
    '/api/v1/admin/trails/:trailId/versions',
    { ...adminOnly, schema: { body: publishVersionSchema } },
    async (request, reply) => {
      const { trailId } = request.params as { trailId: string };
      const { pins } = request.body as { pins: DraftPin[] };

      const trail = await app.store.getTrail(trailId);
      if (!trail) {
        return reply.code(404).send({ error: 'trail_not_found' });
      }

      const validation = validateTrailDraft(pins);
      if (validation.errors.length > 0) {
        return reply.code(422).send({ error: 'invalid_trail', errors: validation.errors });
      }

      const newPins: NewPinInput[] = pins.map((pin) => ({
        sequenceIndex: pin.sequenceIndex,
        lat: pin.lat,
        lng: pin.lng,
        alt: pin.alt ?? null,
        radiusM: pin.radiusM,
        challengeType: pin.challengeType,
        challengeConfig: pin.challengeConfig ?? {},
      }));
      const published = await app.store.publishTrailVersion({ trailId, pins: newPins });

      return reply.code(201).send({
        trailId,
        trailVersionId: published.version.id,
        versionNumber: published.version.versionNumber,
        publishedAt: published.version.publishedAt.toISOString(),
        // SR-ADMIN-01/02: advisory only — the publish already happened.
        warnings: validation.warnings,
        pins: published.pins.map(toClientPin),
      });
    },
  );

  // ST-7.3 — the "can't find this pin" review queue (GDR-09).
  app.get('/api/v1/admin/pin-reports', adminOnly, async (request, reply) => {
    const { status, limit } = request.query as { status?: string; limit?: string };

    if (status !== undefined && !REPORT_STATUSES.includes(status as PinReportStatus)) {
      return reply.code(400).send({ error: 'invalid_status' });
    }
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      return reply.code(400).send({ error: 'invalid_limit' });
    }

    const reports = await app.store.listPinReports({
      status: status as PinReportStatus | undefined,
      limit: parsedLimit,
    });

    return reply.send({
      reports: reports.map((report) => ({
        reportId: report.id,
        pinId: report.pinId,
        note: report.note,
        status: report.status,
        createdAt: report.createdAt.toISOString(),
        // Deliberately not the reporter's id: the Admin is triaging a *place*, and a report
        // may well outlive its reporter (SR-PRIV-02).
      })),
    });
  });

  // ST-8.3 / SR-PRIV-03 — aggregated completion analytics. Admin-only, like everything else
  // here: SR-DATA-02 keeps players out of any view but their own.
  app.get('/api/v1/admin/analytics/trails', adminOnly, async (request, reply) => {
    const query = request.query as { from?: string; to?: string; limit?: string };

    const range = parseAnalyticsRange(query);
    if (!range.ok) {
      return reply.code(400).send({ error: range.error });
    }
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return reply.code(400).send({ error: 'invalid_limit' });
    }

    const aggregates = await app.store.getTrailAttemptAggregates({ ...range.range, limit });

    return reply.send({
      range: rangeResponse(range.range),
      minCohortSize: MIN_COHORT_SIZE,
      trails: aggregates.map((aggregate) => summarizeTrail(aggregate)),
    });
  });

  app.get('/api/v1/admin/analytics/trails/:trailId', adminOnly, async (request, reply) => {
    const { trailId } = request.params as { trailId: string };
    const query = request.query as { from?: string; to?: string };

    const range = parseAnalyticsRange(query);
    if (!range.ok) {
      return reply.code(400).send({ error: range.error });
    }

    const trail = await app.store.getTrail(trailId);
    if (!trail) {
      return reply.code(404).send({ error: 'trail_not_found' });
    }

    const [aggregates, funnelRows] = await Promise.all([
      app.store.getTrailAttemptAggregates({ ...range.range, trailId, limit: 1 }),
      app.store.getPinFunnel(trailId, range.range),
    ]);

    // A trail with no attempts in range has no aggregate row; report zeros rather than a 404,
    // so a dashboard querying week-by-week doesn't have to special-case quiet weeks.
    const summary = summarizeTrail(
      aggregates[0] ?? {
        trailId: trail.id,
        trailName: trail.name,
        attemptsStarted: 0,
        attemptsCompleted: 0,
        attemptsExpired: 0,
        attemptsActive: 0,
        medianCompletionSeconds: null,
        p90CompletionSeconds: null,
      },
    );

    return reply.send({
      range: rangeResponse(range.range),
      minCohortSize: MIN_COHORT_SIZE,
      ...summary,
      funnel: summarizeFunnel(funnelRows, summary.attemptsStarted),
    });
  });

  app.patch(
    '/api/v1/admin/pin-reports/:reportId',
    {
      ...adminOnly,
      schema: {
        body: {
          type: 'object',
          required: ['status'],
          additionalProperties: false,
          properties: { status: { type: 'string', enum: [...REPORT_STATUSES] } },
        },
      },
    },
    async (request, reply) => {
      const { reportId } = request.params as { reportId: string };
      const { status } = request.body as { status: PinReportStatus };

      const updated = await app.store.updatePinReportStatus(reportId, status);
      if (!updated) {
        return reply.code(404).send({ error: 'report_not_found' });
      }

      return reply.send({ reportId: updated.id, pinId: updated.pinId, status: updated.status });
    },
  );
}
