/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { Feature, QueryLink } from '@kbn/significant-events-schema';

export const MAX_MANAGED_RULES_PER_SERVICE = 7;
const SERVICE_TAG_PREFIX = 'nightshift:monitoring-service:';
const property = (feature: Feature, name: string): string => {
  const value = feature.properties[name];
  return typeof value === 'string' ? value : '';
};
const identity = (name: string, namespace: string): string =>
  JSON.stringify([name.trim().toLowerCase().replaceAll('_', '-'), namespace]);

export const monitoredServices = (features: Feature[]): string[] => {
  const entities = features.filter((feature) => feature.type === 'entity');
  const selected = entities.length ? entities : features;
  return [
    ...new Set(
      selected.flatMap((feature) => {
        const name =
          feature.type === 'entity'
            ? property(feature, 'name')
            : feature.type === 'dependency'
            ? property(feature, 'source')
            : property(feature, 'service_name');
        const namespace =
          feature.type === 'dependency'
            ? property(feature, 'source_namespace')
            : property(feature, 'service_namespace') || property(feature, 'namespace');
        return name ? [identity(name, namespace)] : [];
      })
    ),
  ];
};
export const observedMonitoredServices = (
  columns: ReadonlyArray<{ name: string }>,
  rows: ReadonlyArray<ReadonlyArray<unknown>>
): string[] => {
  const indices = (names: string[]) =>
    names
      .map((name) => columns.findIndex((column) => column.name === name))
      .filter((index) => index >= 0);
  const names = indices(['resource.attributes.service.name', 'service.name', 'service_name']);
  const namespaces = indices([
    'resource.attributes.service.namespace',
    'service.namespace',
    'namespace',
  ]);
  if (!names.length || !namespaces.length) return [];
  const value = (row: ReadonlyArray<unknown>, positions: number[]) =>
    positions.map((index) => row[index]).find((item) => typeof item === 'string' && item.trim());
  return [
    ...new Set(
      rows.flatMap((row) => {
        const name = value(row, names);
        const namespace = value(row, namespaces);
        return typeof name === 'string'
          ? [identity(name, typeof namespace === 'string' ? namespace : '')]
          : [];
      })
    ),
  ];
};

export const servicesFromOwnershipTags = (tags: string[]): string[] =>
  tags
    .filter((tag) => tag.startsWith(SERVICE_TAG_PREFIX))
    .map((tag) => decodeURIComponent(tag.slice(SERVICE_TAG_PREFIX.length)));

export const serviceOwnershipTags = (services: string[]): string[] =>
  services.map((service) => SERVICE_TAG_PREFIX + encodeURIComponent(service));

export interface CountedRule {
  id: string;
  enabled: boolean;
  metadata: { tags?: string[] };
}

export const serviceRuleUsage = (
  rules: CountedRule[],
  features: Feature[],
  queries: QueryLink[]
): Map<string, Set<string>> => {
  const featureIndex = new Map(
    features.flatMap((feature) => [
      [`${feature.source_id}:${feature.id}`, feature] as const,
      [`${feature.source_id}:${feature.uuid}`, feature] as const,
    ])
  );
  const usage = new Map<string, Set<string>>();
  for (const rule of rules.filter((item) => item.enabled)) {
    const tagged = servicesFromOwnershipTags(rule.metadata.tags ?? []);
    const referenced = queries
      .filter((query) => query.rule_id === rule.id)
      .flatMap((query) =>
        (query.query.features ?? []).flatMap((reference) => {
          const feature = featureIndex.get(`${query.source_id}:${reference.id}`);
          return feature ? [feature] : [];
        })
      );
    for (const service of tagged.length ? tagged : monitoredServices(referenced)) {
      const ids = usage.get(service) ?? new Set<string>();
      ids.add(rule.id);
      usage.set(service, ids);
    }
  }
  return usage;
};

export const assertServiceRuleCapacity = (
  services: string[],
  usage: Map<string, Set<string>>,
  candidateId: string
): void => {
  if (!services.length)
    throw new Error(
      'Retain observed emitting service columns in the validated query output, or link a source-local emitting-service KI before creating or enabling the monitor.'
    );
  for (const service of services) {
    const ids = usage.get(service) ?? new Set<string>();
    const existingCount = [...ids].filter((id) => id !== candidateId).length;
    if (existingCount >= MAX_MANAGED_RULES_PER_SERVICE)
      throw new Error(
        `Managed rule limit reached for ${service}: at most ${MAX_MANAGED_RULES_PER_SERVICE} active rules per service and namespace, across configured sources. Reuse/consolidate an existing monitor or disable a lower-priority owned rule before adding this one. User rules do not count toward this managed limit but their coverage should reduce what you add.`
      );
  }
};
