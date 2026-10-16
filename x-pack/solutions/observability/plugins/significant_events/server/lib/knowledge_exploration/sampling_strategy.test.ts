/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ExplorationStep } from '../../../common/knowledge_exploration';
import type { NightshiftSource } from '@kbn/nightshift-shared';
import {
  buildSamplingAgenda,
  mergeSamplingAttempts,
  summarizeSamplingAttempts,
} from './sampling_strategy';

const step = (input: object, output: object): ExplorationStep => ({
  id: 'one',
  kind: 'tool',
  name: 'source_esql',
  startedAt: '2026-10-16T09:00:00Z',
  durationMs: 30000,
  status: 'failed',
  input: JSON.stringify(input),
  output: JSON.stringify(output),
});

describe('cross-run sampling context', () => {
  it('retains the exact failed time and service scope with bounded error details', () => {
    expect(
      summarizeSamplingAttempts(
        [
          step(
            {
              template: 'infrastructure',
              sourceIds: ['logs'],
              lookbackMinutes: 120,
              endOffsetMinutes: 60,
              serviceNames: ['checkout'],
              serviceNamespace: 'shop',
              fieldSearch: 'host.ip',
            },
            { results: [{ sourceId: 'logs', error: 'Request timed out' }] }
          ),
        ],
        'knowledge'
      )
    ).toEqual([
      {
        attemptId: 'one',
        agent: 'knowledge',
        startedAt: '2026-10-16T09:00:00Z',
        template: 'infrastructure',
        sourceIds: ['logs'],
        lookbackMinutes: 120,
        endOffsetMinutes: 60,
        services: ['checkout'],
        namespace: 'shop',
        fieldSearch: 'host.ip',
        pipeline: '',
        durationMs: 30000,
        status: 'failed',
        results: [
          {
            sourceId: 'logs',
            error: 'Request timed out',
            documents: undefined,
            countRelation: undefined,
            rowsReturned: undefined,
            truncated: false,
          },
        ],
      },
    ]);
  });

  it('preserves capped-count semantics without storing raw telemetry', () => {
    const attempts = summarizeSamplingAttempts(
      [
        step(
          { template: 'volume', lookbackMinutes: 1 },
          {
            results: [
              {
                sourceId: 'metrics',
                documents: 10000,
                countRelation: 'gte',
                rows: [{ secret: 'not retained' }],
              },
            ],
          }
        ),
      ],
      'knowledge'
    );
    expect(attempts[0].results[0]).toMatchObject({
      documents: 10000,
      countRelation: 'gte',
      rowsReturned: 1,
    });
    expect(JSON.stringify(attempts)).not.toContain('not retained');
  });

  it('keeps only recent attempts and skips malformed historical previews', () => {
    const valid = step(
      { template: 'custom', lookbackMinutes: 1, pipeline: 'x'.repeat(2000) },
      { results: [] }
    );
    const attempts = summarizeSamplingAttempts(
      [...Array.from({ length: 12 }, () => valid), { ...valid, output: '{clipped' }],
      'knowledge'
    );
    expect(attempts).toHaveLength(7);
    expect(attempts[0].pipeline).toHaveLength(500);
  });
});

const source = (id: string, type: NightshiftSource['type']): NightshiftSource =>
  ({ id, slug: id, title: id, type, enabled: true } as NightshiftSource);

describe('deterministic sampling agenda', () => {
  it('prioritizes less sampled sources and rotates the time stratum per agent', () => {
    const agenda = buildSamplingAgenda(
      'knowledge',
      [source('logs', 'logs'), source('traces', 'traces'), source('metrics', 'metrics')],
      [
        {
          agent: 'knowledge',
          template: 'volume',
          sourceIds: ['logs'],
          lookbackMinutes: 1,
          endOffsetMinutes: 0,
          namespace: '',
          services: [],
          fieldSearch: '',
          pipeline: '',
          durationMs: 10,
          status: 'completed',
          results: [],
        },
      ]
    );

    expect(agenda.sources[0]).toMatchObject({
      sourceId: 'traces',
      volumeProbeMinutes: 1,
      targetWindowMinutes: 5,
      endOffsetMinutes: 0,
      focus: expect.stringContaining('peer identities'),
    });
    expect(agenda.sources.find(({ sourceId }) => sourceId === 'logs')).toMatchObject({
      sourceId: 'logs',
      endOffsetMinutes: 60,
    });
  });

  it('prioritizes sources named in unresolved gaps', () => {
    const agenda = buildSamplingAgenda(
      'monitoring',
      [source('logs', 'logs'), source('metrics', 'metrics')],
      [],
      undefined,
      ['No managed rule coverage for metrics']
    );
    expect(agenda.sources[0].sourceId).toBe('metrics');
  });

  it('keeps Event Discovery sampling signal-driven and current', () => {
    expect(buildSamplingAgenda('events', [source('logs', 'logs')], [])).toMatchObject({
      instruction: expect.stringContaining('Signal-driven'),
      sources: [],
    });
  });

  it('merges bounded sampling history without retaining duplicate attempts', () => {
    const attempt = {
      attemptId: 'a',
      agent: 'monitoring' as const,
      startedAt: '2026-10-16T09:00:00Z',
      template: 'volume',
      sourceIds: ['logs'],
      lookbackMinutes: 1,
      endOffsetMinutes: 0,
      namespace: '',
      services: [],
      fieldSearch: '',
      pipeline: '',
      durationMs: 10,
      status: 'completed' as const,
      results: [],
    };
    expect(mergeSamplingAttempts([attempt], [attempt])).toEqual([attempt]);
  });
});
