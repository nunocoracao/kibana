/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Parser } from '@elastic/esql';
import { entityName } from './source_scope';
import type { Feature, SignalEntry, SignificantEvent } from '@kbn/significant-events-schema';
import { rowIdentity } from './dependency_evidence';

export interface EventEvidenceCheck {
  sourceId: string;
  query: string;
  row: Record<string, string>;
  checkedAt: number;
  ref?: string;
  scope?: ReturnType<typeof eventRowScope>;
  outcome?: NonNullable<SignificantEvent['outcome_checks']>[number];
}

/** Resolve simple STATS BY column aliases from the executed query without changing the saved rows. */
export function eventRowScope({ row, query }: Pick<EventEvidenceCheck, 'query' | 'row'>) {
  const identity = rowIdentity(row);
  let operation = row.event_operation || row.operation || row.op || row['http.route'] || row.route;
  if (identity.name && identity.namespace && operation) return { ...identity, operation };
  const parsed = Parser.parse(query);
  const commands = parsed.root.commands;
  const index = commands.findLastIndex((cmd) => cmd.name === 'stats');
  const groups = commands[index]?.args.find(
    (arg) => !Array.isArray(arg) && arg.type === 'option' && arg.name === 'by'
  );
  if (
    parsed.errors.length ||
    !groups ||
    Array.isArray(groups) ||
    groups.type !== 'option' ||
    commands
      .slice(index + 1)
      .some((cmd) => !['sort', 'keep', 'drop', 'limit', 'where'].includes(cmd.name))
  )
    return { ...identity, operation };
  const projected: Record<string, string> = {};
  let serviceOnly = groups.args.length > 0;
  for (const group of groups.args) {
    const assignment =
      !Array.isArray(group) && group.type === 'function' && group.name === '='
        ? group.args
        : undefined;
    const column = assignment ? assignment[0] : group;
    const rhs = assignment?.[1];
    const original = Array.isArray(rhs) && rhs.length === 1 ? rhs[0] : rhs ?? group;
    if (
      !column ||
      Array.isArray(column) ||
      column.type !== 'column' ||
      !original ||
      Array.isArray(original) ||
      original.type !== 'column'
    ) {
      serviceOnly = false;
      continue;
    }
    const value = row[column.name];
    if (value) projected[original.name] = value;
    if (
      ![
        'resource.attributes.service.name',
        'service.name',
        'service_name',
        'resource.attributes.service.namespace',
        'service.namespace',
        'service_namespace',
        'namespace',
      ].includes(original.name)
    )
      serviceOnly = false;
    if (
      !operation &&
      ['event_operation', 'op', 'operation', 'http.route', 'route'].includes(original.name)
    )
      operation = value;
  }
  const scoped = rowIdentity(projected);
  return {
    name: identity.name || scoped.name,
    namespace: identity.namespace || scoped.namespace,
    operation: operation || (serviceOnly ? 'All operations' : undefined),
  };
}

type OutcomeFields = Pick<
  NonNullable<EventEvidenceCheck['outcome']>,
  'condition' | 'failedField' | 'healthyField'
>;

export function collectEventOutcomes({
  checks,
  features,
  prior,
  outcome,
  outcomes,
}: {
  checks: EventEvidenceCheck[];
  features: Feature[];
  prior?: SignificantEvent | null;
  outcome?: OutcomeFields;
  outcomes?: Array<OutcomeFields & { evidenceRef: string }>;
}) {
  const cohortKey = (o: NonNullable<SignificantEvent['outcome_checks']>[number]) =>
    JSON.stringify([
      o.sourceId,
      o.entityId,
      o.operation,
      o.condition,
      o.failedField,
      o.healthyField,
    ]);
  const overrides = new Map(outcomes?.map((o) => [o.evidenceRef, o]));
  const previous = new Map(
    (prior?.status === 'inactive' ? [] : prior?.outcome_checks ?? []).map((o) => [cohortKey(o), o])
  );
  const measured = new Map(previous);

  for (const check of checks) {
    const spec = (check.ref && overrides.get(check.ref)) || outcome;
    if (!spec || spec.failedField === spec.healthyField) continue;
    const identity = check.scope ?? eventRowScope(check);
    const entities = features.filter(
      (f) =>
        f.type === 'entity' &&
        f.source_id === check.sourceId &&
        entityName(f) === identity.name &&
        (f.properties.service_namespace ?? f.properties.namespace ?? '') ===
          (identity.namespace ?? '')
    );
    const operation = identity.operation;
    const count = (field: string) =>
      /^\d+$/.test(check.row[field] ?? '') ? Number(check.row[field]) : NaN;
    const failed = count(spec.failedField);
    const healthy = count(spec.healthyField);
    if (
      entities.length !== 1 ||
      !operation?.trim() ||
      !Number.isSafeInteger(failed + healthy) ||
      !(failed + healthy)
    )
      continue;
    const measurement = {
      condition: spec.condition,
      failedField: spec.failedField,
      healthyField: spec.healthyField,
      observedAt: check.checkedAt,
      sourceId: check.sourceId,
      entityId: entities[0].id,
      operation,
      failed,
      healthy,
    };
    const key = cohortKey(measurement);
    const window = /WHERE\s+`@timestamp`\s*>=\s*NOW\(\)\s*-\s*(\d+) minutes/i.exec(check.query);
    if (
      !window ||
      Date.now() - check.checkedAt > 180000 ||
      /`@timestamp`\s*<\s*NOW\(\)|\|\s*SAMPLE\s+(?:0|\.)/i.test(check.query)
    )
      continue;
    const minutes = Number(window[1]);
    if (!minutes || minutes > 3) continue;
    check.outcome = measurement;
    if ((measured.get(key)?.observedAt ?? 0) <= measurement.observedAt)
      measured.set(key, measurement);
  }
  return [...measured.values()];
}

/** Retains real executed query evidence in a fixed window without inventing a rule firing. */
export const buildEventQuerySignals = (
  checks: EventEvidenceCheck[],
  description: string,
  affectedFeatures: Feature[] = []
): SignalEntry[] => {
  const entities = affectedFeatures.filter((feature) => feature.type === 'entity');
  const outsideAffectedScope = (check: EventEvidenceCheck): boolean => {
    const identity = check.scope ?? eventRowScope(check);
    return Boolean(
      entities.length &&
        identity.name &&
        !entities.some(
          (feature) =>
            feature.source_id === check.sourceId &&
            entityName(feature) === identity.name &&
            (!identity.namespace ||
              (feature.properties.service_namespace ?? feature.properties.namespace) ===
                identity.namespace)
        )
    );
  };
  const groups = new Map<string, EventEvidenceCheck[]>();
  for (const check of checks) {
    const key = JSON.stringify([
      check.sourceId,
      check.query,
      check.checkedAt,
      outsideAffectedScope(check),
      check.outcome,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), check]);
  }
  return [...groups.values()].map((group) => {
    const check = group[0];
    const at = new Date(check.checkedAt).toISOString();
    const minutes = Number(/NOW\(\)\s*-\s*(\d+)\s+minutes/i.exec(check.query)?.[1] ?? 3);
    const offset = Number(/<\s*NOW\(\)\s*-\s*(\d+)\s+minutes/i.exec(check.query)?.[1] ?? 0);
    const historicalComparison = offset > 0 || minutes > 3;
    const outsideScope = outsideAffectedScope(check);
    const query = check.query.replace(
      /"(?:\\.|""|[^"\\])*"|'(?:\\.|''|[^'\\])*'|`(?:``|[^`])*`|\bNOW\(\)/gi,
      (token) => (/^NOW\(\)$/i.test(token) ? `TO_DATETIME("${at}")` : token)
    );
    return {
      type: 'query',
      source_id: check.sourceId,
      metadata: {
        rule_name: 'Verified source evidence',
      },
      description: `${
        historicalComparison
          ? 'Historical comparison; not a current-state confirmation. '
          : outsideScope
          ? 'Context from outside the affected service scope; not confirmation of this problem. '
          : ''
      }${description}\nObserved rows: ${JSON.stringify(
        group.slice(0, 5).map((entry) => entry.row)
      ).slice(0, 4000)}`,
      verdict:
        !check.outcome ||
        !/WHERE\s+`@timestamp`\s*>=\s*NOW\(\)\s*-\s*[123] minutes/i.test(check.query) ||
        Date.now() - check.checkedAt > 3 * 60000 ||
        historicalComparison ||
        outsideScope ||
        /\|\s*SAMPLE\s+(?:0|\.)/i.test(check.query)
          ? 'inconclusive'
          : check.outcome.failed === 0
          ? 'refutes'
          : 'confirms',
      collected_at: at,
      evidence: {
        esql_query: query,
        result: 'found',
        time_range: {
          from: new Date(check.checkedAt - minutes * 60000).toISOString(),
          to: new Date(check.checkedAt - offset * 60000).toISOString(),
        },
      },
    };
  });
};

/** Resolves cited emitters by source and exact namespace, retaining explicit operator/model choices. */
export const resolveEventFeatures = (
  features: Feature[],
  checks: EventEvidenceCheck[],
  ids: string[]
) => {
  const selected = features.filter((feature) => ids.includes(feature.id));
  if (ids.length) return selected;
  for (const check of checks) {
    const identity = check.scope ?? eventRowScope(check);
    if (!identity.name) continue;
    const candidates = features.filter(
      (feature) =>
        feature.source_id === check.sourceId &&
        feature.type === 'entity' &&
        feature.subtype === 'service' &&
        entityName(feature) === identity.name &&
        (!identity.namespace ||
          (feature.properties.service_namespace ?? feature.properties.namespace) ===
            identity.namespace)
    );
    const namespaces = new Set(
      candidates.map(
        (feature) => feature.properties.service_namespace ?? feature.properties.namespace
      )
    );
    if (namespaces.size !== 1) continue;
    for (const feature of candidates)
      if (
        !selected.some(
          (current) => current.id === feature.id && current.source_id === feature.source_id
        )
      )
        selected.push(feature);
  }
  return selected;
};
