/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { directedPeers } from './dependency_evidence';

describe('outbound peer evidence', () => {
  const emitters = [
    { name: 'archive', namespace: 'west' },
    { name: 'archive', namespace: 'east' },
    { name: 'thumbnail', namespace: '' },
  ];
  const caller = { 'service.name': 'reader', 'service.namespace': 'west' };
  it('resolves a named outgoing destination and deduplicates the same namespaced target', () => {
    expect(
      directedPeers(
        { ...caller, 'upstream.cluster': 'archive', 'attributes.upstream.cluster': 'archive' },
        emitters,
        'logs',
        'r1'
      )
    ).toEqual([
      expect.objectContaining({
        source: 'reader',
        target: 'archive',
        targetNamespace: 'west',
        sourceId: 'logs',
        evidenceRef: 'r1',
      }),
    ]);
  });
  it('uses a fully qualified service endpoint and keeps the matching namespace', () => {
    expect(
      directedPeers(
        { ...caller, remote_service_url: 'https://archive.east.svc.cluster.local/v1' },
        emitters,
        'logs',
        'r2'
      )[0]
    ).toMatchObject({ target: 'archive', targetNamespace: 'east' });
  });
  it('skips listening addresses, SDK names, unobserved targets and ambiguous namespace-less targets', () => {
    expect(
      directedPeers(
        {
          'service.name': 'reader',
          'upstream.cluster': 'archive',
          'destination.service.name': 'unknown',
          'server.address': 'thumbnail',
          'feature_flag.provider.name': 'archive',
        },
        emitters,
        'logs',
        'r3'
      )
    ).toEqual([]);
  });
});
