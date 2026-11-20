/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { BaseFeature } from '@kbn/significant-events-schema';

type InventoryFeature = Pick<BaseFeature, 'id' | 'type' | 'properties'> & { excluded?: boolean };
interface NamespaceInventory {
  namespace: string;
  entities: number;
  dependencies: number;
  infrastructure: number;
  technologies: number;
  schemas: number;
  relationshipInvestigationNeeded: boolean;
}

/** Summarizes stored knowledge without treating absent KIs as absent real-world components. */
export const summarizeNamespaceInventory = (
  features: readonly InventoryFeature[]
): NamespaceInventory[] => {
  const groups = new Map<string, Map<string, Set<string>>>();
  const property = (feature: InventoryFeature, key: string): string => {
    const value = feature.properties[key];
    return typeof value === 'string' ? value : '';
  };
  for (const feature of features) {
    if (feature.excluded) continue;
    const namespace =
      property(feature, 'source_namespace') ||
      property(feature, 'service_namespace') ||
      property(feature, 'namespace');
    if (!namespace) continue;
    const group = groups.get(namespace) ?? new Map<string, Set<string>>();
    const identities = group.get(feature.type) ?? new Set<string>();
    const identity =
      feature.type === 'entity'
        ? property(feature, 'name') || property(feature, 'service_name') || feature.id
        : feature.type === 'dependency'
        ? JSON.stringify([
            property(feature, 'source'),
            property(feature, 'target'),
            property(feature, 'target_namespace'),
          ])
        : feature.id;
    identities.add(identity);
    group.set(feature.type, identities);
    groups.set(namespace, group);
  }
  return [...groups].map(([namespace, types]) => {
    const entities = types.get('entity')?.size ?? 0;
    const dependencies = types.get('dependency')?.size ?? 0;
    return {
      namespace,
      entities,
      dependencies,
      infrastructure: types.get('infrastructure')?.size ?? 0,
      technologies: types.get('technology')?.size ?? 0,
      schemas: types.get('schema')?.size ?? 0,
      relationshipInvestigationNeeded: entities > 0 && dependencies === 0,
    };
  });
};
