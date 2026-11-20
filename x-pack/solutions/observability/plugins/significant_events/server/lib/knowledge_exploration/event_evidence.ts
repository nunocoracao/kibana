/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Feature, SignalEntry } from '@kbn/significant-events-schema';
import { rowIdentity } from './dependency_evidence';

export interface EventEvidenceCheck {
  sourceId: string;
  query: string;
  row: Record<string, string>;
  checkedAt: number;
}

/** Retains real executed query evidence in a fixed window without inventing a rule firing. */
export const buildEventQuerySignals = (
  checks: EventEvidenceCheck[],
  description: string,
  inactive: boolean,
  references: Array<{ sourceId: string; queryId?: string; ruleId?: string }> = []
): SignalEntry[] => {
  const groups = new Map<string, EventEvidenceCheck[]>();
  for (const check of checks) {
    const key = JSON.stringify([check.sourceId, check.query, check.checkedAt]);
    groups.set(key, [...(groups.get(key) ?? []), check]);
  }
  return [...groups.values()].map((group) => {
    const check = group[0];
    const at = new Date(check.checkedAt).toISOString();
    const minutes = Number(/NOW\(\)\s*-\s*(\d+)\s+minutes/i.exec(check.query)?.[1] ?? 3);
    const offset = Number(/<\s*NOW\(\)\s*-\s*(\d+)\s+minutes/i.exec(check.query)?.[1] ?? 0);
    const historicalComparison = offset > 0 || minutes > 3;
    const query = check.query.replace(
      /"(?:\\.|""|[^"\\])*"|'(?:\\.|''|[^'\\])*'|`(?:``|[^`])*`|\bNOW\(\)/gi,
      (token) => (/^NOW\(\)$/i.test(token) ? `TO_DATETIME("${at}")` : token)
    );
    const refs = references.filter((ref) => ref.sourceId === check.sourceId);
    const ruleIds = [...new Set(refs.flatMap((ref) => (ref.ruleId ? [ref.ruleId] : [])))];
    const standalone = refs.filter((ref) => !ref.ruleId);
    const queryIds = [
      ...new Set(
        (standalone.length ? standalone : refs).flatMap((ref) => (ref.queryId ? [ref.queryId] : []))
      ),
    ];
    return {
      type: 'query',
      source_id: check.sourceId,
      metadata: {
        rule_name: 'Verified source evidence',
        ...(queryIds.length === 1 ? { query_id: queryIds[0] } : {}),
        ...(ruleIds.length === 1 ? { rule_uuid: ruleIds[0] } : {}),
      },
      description: `${
        historicalComparison ? 'Historical comparison; not a current-state confirmation. ' : ''
      }${description}\nObserved rows: ${JSON.stringify(
        group.slice(0, 5).map((entry) => entry.row)
      ).slice(0, 4000)}`,
      verdict:
        historicalComparison || /\|\s*SAMPLE\s+(?:0|\.)/i.test(check.query)
          ? 'inconclusive'
          : inactive
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
    const identity = rowIdentity(check.row);
    if (!identity.name) continue;
    const candidates = features.filter(
      (feature) =>
        feature.source_id === check.sourceId &&
        feature.type === 'entity' &&
        feature.subtype === 'service' &&
        feature.properties.name === identity.name &&
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
