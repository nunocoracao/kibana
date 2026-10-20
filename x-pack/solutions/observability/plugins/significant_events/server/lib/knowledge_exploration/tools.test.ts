/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { mergeUnexploredDimensions, technologyField } from './tools';

describe('technology inventory fields', () => {
  it('matches SDK, runtime and language identity fields in any attribute namespace', () => {
    for (const name of [
      'telemetry.sdk.language',
      'resource.attributes.telemetry.sdk.language',
      'resource.attributes.telemetry.sdk.name',
      'telemetry.distro.version',
      'process.runtime.name',
      'resource.attributes.process.runtime.version',
      'service.language.name',
      'webengine.name',
    ])
      expect(technologyField(name)).toBe(true);
  });

  it('ignores unrelated fields that only share a prefix', () => {
    for (const name of [
      'telemetry.sdk.languages',
      'process.runtime.name.keyword_count',
      'service.name',
      'process.pid',
      'attributes.language',
    ])
      expect(technologyField(name)).toBe(false);
  });
});

describe('finish dimension review', () => {
  it('carries unexplored dimensions over as gaps without duplicating existing ones', () => {
    expect(
      mergeUnexploredDimensions(
        ['demo: technologies unexplored (no time left)'],
        [
          { namespace: 'demo', dimension: 'entities', status: 'learned', basis: 'inventory' },
          {
            namespace: 'demo',
            dimension: 'technologies',
            status: 'unexplored',
            basis: 'no time left',
          },
          {
            namespace: 'demo',
            dimension: 'infrastructure',
            status: 'unobservable',
            basis: 'no k8s or host fields populated',
          },
          { namespace: 'shop', dimension: 'dependencies', status: 'unexplored', basis: 'not read' },
        ]
      )
    ).toEqual([
      'demo: technologies unexplored (no time left)',
      'shop: dependencies unexplored (not read)',
    ]);
  });

  it('never exceeds the stored gap limit', () => {
    const review = Array.from({ length: 30 }, (_, index) => ({
      namespace: `ns${index}`,
      dimension: 'schema',
      status: 'unexplored',
      basis: 'not read',
    }));
    expect(mergeUnexploredDimensions([], review)).toHaveLength(20);
  });
});
