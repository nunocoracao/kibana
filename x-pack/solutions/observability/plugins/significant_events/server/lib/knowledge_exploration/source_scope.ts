/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { BaseFeature } from '@kbn/significant-events-schema';

/** Reads the canonical entity name and the service-name alias in earlier agent KIs. */
export const entityName = ({
  properties,
  subtype,
}: Pick<BaseFeature, 'properties' | 'subtype'>): string | undefined => {
  const name = properties?.name;
  if (typeof name === 'string' && name.trim()) return name;
  const alias = properties?.service_name;
  return subtype === 'service' && typeof alias === 'string' && alias.trim() ? alias : undefined;
};

/** Builds service filters before a source-scoped pipeline can aggregate or drop identity fields. */
export const buildServiceScopeFilter = (
  columns: readonly string[],
  serviceNames?: readonly string[],
  serviceNamespace?: string
): string => {
  const filters: string[] = [];
  if (serviceNames?.length) {
    const names = ['resource.attributes.service.name', 'service.name', 'service_name'].filter(
      (column) => columns.includes(column)
    );
    const name =
      names.length > 1
        ? `COALESCE(${names.map((column) => `\`${column}\``).join(', ')})`
        : names.length
        ? `\`${names[0]}\``
        : '';
    if (!name) throw new Error('No service name column is exposed by this source');
    filters.push(
      `${name} IN (${serviceNames.map((service) => JSON.stringify(service)).join(', ')})`
    );
  }
  if (serviceNamespace) {
    const names = [
      'resource.attributes.service.namespace',
      'service.namespace',
      'namespace',
    ].filter((column) => columns.includes(column));
    const name =
      names.length > 1
        ? `COALESCE(${names.map((column) => `\`${column}\``).join(', ')})`
        : names.length
        ? `\`${names[0]}\``
        : '';
    if (!name) throw new Error('No service namespace column is exposed by this source');
    filters.push(`${name} == ${JSON.stringify(serviceNamespace)}`);
  }
  return filters.length ? `WHERE ${filters.join(' AND ')} | ` : '';
};

/** Uses populated ECS or OTel body fields when the source contains mixed formats. */
export const sourceLogExpression = (columns: readonly string[]): string | undefined => {
  const fields = ['message', 'body.text', 'body'].filter((name) => columns.includes(name));
  if (!fields.length) return undefined;
  const expressions = fields.map((name) => `TO_STRING(\`${name}\`)`);
  return expressions.length > 1 ? `COALESCE(${expressions.join(', ')})` : expressions[0];
};

/** Returns mapped emitting-service identity fields rather than arbitrary metric dimensions. */
export const sourceIdentityColumns = (columns: readonly string[]): string[] =>
  [
    'resource.attributes.service.name',
    'service.name',
    'service_name',
    'resource.attributes.service.namespace',
    'service.namespace',
    'namespace',
  ].filter((name) => columns.includes(name));

/** Group on the exact keyword variant when a Kubernetes resource is dynamically mapped. */
export const mappedKubernetesFields = (
  columns: readonly string[],
  names: readonly string[]
): string[] =>
  names.flatMap((name) =>
    [`resource.attributes.${name}`, name].flatMap((path) =>
      columns.includes(`${path}.keyword`)
        ? [`${path}.keyword`]
        : columns.includes(path)
        ? [path]
        : []
    )
  );

export const mappedWorkloadFields = (columns: readonly string[]): string[] =>
  mappedKubernetesFields(columns, [
    'k8s.deployment.name',
    'k8s.statefulset.name',
    'k8s.daemonset.name',
  ]);
