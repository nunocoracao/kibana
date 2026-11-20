/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

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
