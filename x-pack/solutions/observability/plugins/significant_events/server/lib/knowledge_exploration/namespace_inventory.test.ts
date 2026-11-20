/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { summarizeNamespaceInventory } from './namespace_inventory';

describe('compact stored knowledge inventory', () => {
  it('deduplicates source-local anchors while keeping namespaces separate', () => {
    const result = summarizeNamespaceInventory([
      { id: 'a-log', type: 'entity', properties: { name: 'api', service_namespace: 'one' } },
      { id: 'a-trace', type: 'entity', properties: { name: 'api', service_namespace: 'one' } },
      { id: 'a-other', type: 'entity', properties: { name: 'api', service_namespace: 'two' } },
    ]);
    expect(result.map(({ namespace, entities }) => ({ namespace, entities }))).toEqual([
      { namespace: 'one', entities: 1 },
      { namespace: 'two', entities: 1 },
    ]);
  });

  it('highlights missing stored relationships without claiming they cannot exist', () => {
    const [result] = summarizeNamespaceInventory([
      { id: 'api', type: 'entity', properties: { name: 'api', service_namespace: 'one' } },
    ]);
    expect(result.relationshipInvestigationNeeded).toBe(true);
  });

  it('counts directed edges by actual endpoints rather than source-local IDs', () => {
    const properties = {
      source: 'api',
      target: 'db',
      source_namespace: 'one',
      target_namespace: 'one',
    };
    const [result] = summarizeNamespaceInventory([
      { id: 'api', type: 'entity', properties: { name: 'api', service_namespace: 'one' } },
      { id: 'log-edge', type: 'dependency', properties },
      { id: 'trace-edge', type: 'dependency', properties },
    ]);
    expect(result.dependencies).toBe(1);
    expect(result.relationshipInvestigationNeeded).toBe(false);
  });

  it('does not manufacture namespace assignments for source-wide contracts or excluded records', () => {
    expect(
      summarizeNamespaceInventory([
        { id: 'format', type: 'schema', properties: { fields: ['status'] } },
        {
          id: 'old',
          type: 'entity',
          excluded: true,
          properties: { name: 'old', service_namespace: 'old' },
        },
      ])
    ).toEqual([]);
  });
});
