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
    const name = ['resource.attributes.service.name', 'service.name', 'service_name'].find(
      (column) => columns.includes(column)
    );
    if (!name) throw new Error('No service name column is exposed by this source');
    filters.push(
      `\`${name}\` IN (${serviceNames.map((service) => JSON.stringify(service)).join(', ')})`
    );
  }
  if (serviceNamespace) {
    const name = ['resource.attributes.service.namespace', 'service.namespace', 'namespace'].find(
      (column) => columns.includes(column)
    );
    if (!name) throw new Error('No service namespace column is exposed by this source');
    filters.push(`\`${name}\` == ${JSON.stringify(serviceNamespace)}`);
  }
  return filters.length ? `WHERE ${filters.join(' AND ')} | ` : '';
};
