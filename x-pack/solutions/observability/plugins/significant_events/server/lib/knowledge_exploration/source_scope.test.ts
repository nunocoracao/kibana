/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { buildServiceScopeFilter } from './source_scope';

describe('source query service scope', () => {
  it('does not filter an explicitly unscoped query', () => {
    expect(buildServiceScopeFilter(['service.name'])).toBe('');
  });

  it('retains service and namespace boundaries before custom aggregation', () => {
    expect(
      buildServiceScopeFilter(
        ['resource.attributes.service.name', 'resource.attributes.service.namespace'],
        ['delivery-queue'],
        'sluice'
      )
    ).toBe(
      'WHERE `resource.attributes.service.name` IN ("delivery-queue") AND `resource.attributes.service.namespace` == "sluice" | '
    );
  });

  it('supports exposed service aliases and multiple names', () => {
    expect(buildServiceScopeFilter(['service.name', 'service.namespace'], ['a', 'b'], 'one')).toBe(
      'WHERE `service.name` IN ("a", "b") AND `service.namespace` == "one" | '
    );
  });

  it('quotes operator-controlled identities as values', () => {
    expect(buildServiceScopeFilter(['service.name'], ['a"b'])).toBe(
      'WHERE `service.name` IN ("a\\"b") | '
    );
  });

  it('does not silently broaden a requested filter when fields are unavailable', () => {
    expect(() => buildServiceScopeFilter(['@timestamp'], ['a'])).toThrow('No service name column');
    expect(() => buildServiceScopeFilter(['service.name'], undefined, 'one')).toThrow(
      'No service namespace column'
    );
  });
});
