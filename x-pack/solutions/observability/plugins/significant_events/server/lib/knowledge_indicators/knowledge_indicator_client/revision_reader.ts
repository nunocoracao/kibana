/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { esql, type ComposerSortShorthand } from '@elastic/esql';
import type { ElasticsearchClient, Logger } from '@kbn/core/server';
import {
  KNOWLEDGE_INDICATORS_DATA_STREAM,
  isStoredFeatureKnowledgeIndicator,
  type StoredFeatureKnowledgeIndicator,
  type StoredKnowledgeIndicator,
} from '../data_stream';
import { combineWhere, inPredicate, inSpace, IS_NOT_DELETED } from '../esql_helpers';
import {
  esqlToObjects,
  escapeEsqlLikePattern,
  executeCountQuery,
  executeAndDecodeSource,
  pickLatestPerGroup,
  withSort,
  withWhere,
  type LatestSourceGroupBy,
  type LatestSourceWhereCondition,
} from '../../significant_events/latest_source_query';
import { runEsqlQuery } from '../../significant_events/run_esql_query';
import { ID, KI_TYPE_FEATURE, SOURCE_ID, TYPE } from '../fields';

export const REVISION_SIZE_LIMIT = 10_000;

export interface LatestRevisionCursor {
  sourceId: string;
  type: string;
  id: string;
}

/**
 * Identity of a knowledge indicator revision within a space. The space filter
 * must be applied before this grouping: feature ids are derived from
 * `(source_id, slug)`, so the same source id onboarded in two spaces yields the
 * same `id` in both and one space's revision would otherwise shadow the other's.
 */
const REVISION_GROUP_KEY: LatestSourceGroupBy = [SOURCE_ID, TYPE, ID];

/**
 * Space-scoped access to raw knowledge indicator revisions. Every query starts
 * from `inSpace(space)`; nothing in this class can read another space's data.
 */
export class RevisionReader {
  constructor(
    private readonly esClient: ElasticsearchClient,
    private readonly logger: Logger,
    private readonly space: string
  ) {}

  async catalog(options: {
    sourceIds: string[];
    asOf: string;
    terms: string[];
    kind?: 'feature' | 'query';
    featureType?: string;
    after?: LatestRevisionCursor;
    size: number;
    countOnly: boolean;
  }) {
    const { sourceIds, asOf, terms, kind, featureType, after, size, countOnly } = options;
    type Entry = Record<string, unknown> & {
      id: string;
      type: string;
      'source.id': string;
      'feature.slug'?: string;
      title: string;
    };
    type Group = { sourceId: string; kind: string; category: string; count: number };
    if (!sourceIds.length)
      return {
        total: 0,
        queryTotal: 0,
        groups: [] as Group[],
        groupsTruncated: false,
        rows: [] as Entry[],
        after: undefined,
      };
    const buildBase = () => {
      let base = esql.from([KNOWLEDGE_INDICATORS_DATA_STREAM], ['_id']).where`${inSpace(
        this.space
      )}`.where`${esql.col(SOURCE_ID)} IN (${sourceIds.map((id) => esql.str(id))})`
        .where`@timestamp <= TO_DATETIME(${esql.str(asOf)})`;
      if (kind) base = base.where`type == ${esql.str(kind)}`;
      base = pickLatestPerGroup(base, REVISION_GROUP_KEY).where`${IS_NOT_DELETED}`
        .where`type == "query" OR expires_at IS NULL OR expires_at >= TO_DATETIME(${esql.str(
        asOf
      )})`;
      if (featureType) base = base.where`\`feature.type\` == ${esql.str(featureType)}`;
      let predicate: LatestSourceWhereCondition | undefined;
      for (const term of terms) {
        const literal = esql.str('*' + escapeEsqlLikePattern(term) + '*');
        for (const column of [
          'feature.slug',
          'id',
          'title',
          'description',
          'feature.type',
          'feature.subtype',
          'query.esql',
        ]) {
          const match = esql.exp`TO_LOWER(TO_STRING(${esql.col(column)})) LIKE ${literal}`;
          predicate = predicate ? esql.exp`${predicate} OR ${match}` : match;
        }
      }
      base = withWhere(base, predicate);
      return base;
    };
    const read = async <T extends Record<string, unknown>>(query: ReturnType<typeof buildBase>) => {
      const response = await runEsqlQuery(this.esClient, query.print('basic'));
      if (response && 'is_partial' in response && response.is_partial)
        throw new Error('Partial KI inventory. Retry before using the counts or cursor.');
      return response ? esqlToObjects<T>(response) : [];
    };
    const totals = await read<{ kind: string; count: number }>(
      buildBase().pipe`STATS count=COUNT(*) BY kind=type`.limit(2)
    );
    const total = totals.find((row) => row.kind === 'feature')?.count ?? 0;
    const queryTotal = totals.find((row) => row.kind === 'query')?.count ?? 0;
    if (countOnly) {
      const groups = await read<Group>(
        buildBase().pipe`EVAL category=COALESCE(\`feature.type\`, \`query.query_type\`, type)`
          .pipe`STATS count=COUNT(*) BY sourceId=\`source.id\`,kind=type,category`
          .sort(['sourceId', 'ASC'], ['kind', 'ASC'], ['category', 'ASC'])
          .limit(501)
      );
      return {
        total,
        queryTotal,
        groups: groups.slice(0, 500),
        groupsTruncated: groups.length > 500,
        rows: [] as Entry[],
        after: undefined,
      };
    }
    let base = buildBase();
    if (after)
      base = base.where`\`source.id\` > ${esql.str(after.sourceId)} OR (\`source.id\` == ${esql.str(
        after.sourceId
      )} AND (type > ${esql.str(after.type)} OR (type == ${esql.str(
        after.type
      )} AND id > ${esql.str(after.id)})))`;
    const hits = await read<Entry>(
      base
        .sort([SOURCE_ID, 'ASC'], [TYPE, 'ASC'], [ID, 'ASC'])
        .keep(
          SOURCE_ID,
          TYPE,
          ID,
          'title',
          'feature.slug',
          'feature.type',
          'feature.subtype',
          'feature.confidence',
          'excluded',
          'query.query_type',
          'query.rule_backed'
        )
        .limit(size + 1)
    );
    const last = hits[size - 1];
    return {
      total,
      queryTotal,
      rows: hits.slice(0, size),
      after:
        hits.length > size
          ? { sourceId: last['source.id'], type: last.type, id: last.id }
          : undefined,
    };
  }

  /** Counts latest revisions, or the distinct values of `distinctColumn` among them. */
  async countLatestRevisions(
    where?: LatestSourceWhereCondition,
    postGroupingWhere?: LatestSourceWhereCondition,
    distinctColumn?: string
  ): Promise<number> {
    let query = esql.from([KNOWLEDGE_INDICATORS_DATA_STREAM], ['_id']).where`${inSpace(
      this.space
    )}`;
    query = withWhere(query, where);
    query = pickLatestPerGroup(query, REVISION_GROUP_KEY);
    query = withWhere(query, postGroupingWhere);
    query = (
      distinctColumn
        ? query.pipe`STATS total = COUNT_DISTINCT(${esql.col(distinctColumn)})`
        : query.pipe`STATS total = COUNT(*)`
    )
      .keep('total')
      .limit(1);

    return executeCountQuery({ esClient: this.esClient, query });
  }

  async fetchLatestRevisions(
    where?: LatestSourceWhereCondition,
    postGroupingWhere?: LatestSourceWhereCondition,
    sort?: ComposerSortShorthand[],
    limit: number = REVISION_SIZE_LIMIT
  ): Promise<StoredKnowledgeIndicator[]> {
    let query = esql.from([KNOWLEDGE_INDICATORS_DATA_STREAM], ['_id', '_source']).where`${inSpace(
      this.space
    )}`;
    query = withWhere(query, where);
    query = pickLatestPerGroup(query, REVISION_GROUP_KEY);
    query = withWhere(query, postGroupingWhere);
    query = withSort(query, sort);
    // Cap at REVISION_SIZE_LIMIT regardless of the requested limit so a large
    // caller-supplied value can't fetch an unbounded result set.
    if (limit > REVISION_SIZE_LIMIT) {
      this.logger.debug(
        `Requested revision limit ${limit} exceeds REVISION_SIZE_LIMIT ${REVISION_SIZE_LIMIT}; capping at ${REVISION_SIZE_LIMIT}.`
      );
    }
    query = query.keep('_source').limit(Math.min(limit, REVISION_SIZE_LIMIT));

    const { hits } = await executeAndDecodeSource<StoredKnowledgeIndicator>(this.esClient, query);
    return hits;
  }

  async fetchLatestRevisionsPage({
    where,
    postGroupingWhere,
    asOf,
    after,
    size,
  }: {
    where?: LatestSourceWhereCondition;
    postGroupingWhere?: LatestSourceWhereCondition;
    asOf: string;
    after?: LatestRevisionCursor;
    size: number;
  }): Promise<{ hits: StoredKnowledgeIndicator[]; nextCursor?: LatestRevisionCursor }> {
    if (size < 1 || size >= REVISION_SIZE_LIMIT) {
      throw new Error(`Revision page size must be between 1 and ${REVISION_SIZE_LIMIT - 1}.`);
    }

    const atOrBefore = esql.exp`${esql.col('@timestamp')} <= TO_DATETIME(${esql.str(asOf)})`;
    const afterCursor = after
      ? esql.exp`${esql.col(SOURCE_ID)} > ${esql.str(after.sourceId)}
        OR (${esql.col(SOURCE_ID)} == ${esql.str(after.sourceId)}
          AND ${esql.col(TYPE)} > ${esql.str(after.type)})
        OR (${esql.col(SOURCE_ID)} == ${esql.str(after.sourceId)}
          AND ${esql.col(TYPE)} == ${esql.str(after.type)}
          AND ${esql.col(ID)} > ${esql.str(after.id)})`
      : undefined;
    let query = esql.from([KNOWLEDGE_INDICATORS_DATA_STREAM], ['_id', '_source']).where`${inSpace(
      this.space
    )}`;
    query = withWhere(query, combineWhere(where, atOrBefore, afterCursor));
    query = pickLatestPerGroup(query, REVISION_GROUP_KEY);
    query = withWhere(query, postGroupingWhere);
    query = query
      .sort([SOURCE_ID, 'ASC'], [TYPE, 'ASC'], [ID, 'ASC'])
      .keep('_source')
      .limit(size + 1);

    const { hits } = await executeAndDecodeSource<StoredKnowledgeIndicator>(this.esClient, query);
    if (hits.length <= size) {
      return { hits };
    }

    const page = hits.slice(0, size);
    const last = page[page.length - 1];
    return {
      hits: page,
      nextCursor: {
        sourceId: last['source.id'],
        type: last.type,
        id: last.id,
      },
    };
  }

  /**
   * Returns the distinct source ids whose latest KI revision satisfies
   * `postGroupingWhere`. Aggregates on `source.id` in ES|QL so the
   * `REVISION_SIZE_LIMIT` cap bounds distinct sources rather than distinct KIs;
   * warns if the cap is hit so partial coverage isn't silent.
   */
  async fetchDistinctSourceIds(
    where?: LatestSourceWhereCondition,
    postGroupingWhere?: LatestSourceWhereCondition
  ): Promise<string[]> {
    let query = esql.from([KNOWLEDGE_INDICATORS_DATA_STREAM], ['_id']).where`${inSpace(
      this.space
    )}`;
    query = withWhere(query, where);
    query = pickLatestPerGroup(query, REVISION_GROUP_KEY);
    query = withWhere(query, postGroupingWhere);
    query = query.pipe`STATS __count = COUNT(*) BY sourceId = ${esql.col(SOURCE_ID)}`
      .keep('sourceId')
      .limit(REVISION_SIZE_LIMIT);

    // `runEsqlQuery` (not `queryEsql`) so a not-yet-created data stream yields
    // `[]` instead of throwing — the sweep can run before any KI is written.
    const response = await runEsqlQuery(this.esClient, query.print('basic'));
    if (!response) {
      return [];
    }

    const rows = esqlToObjects<{ sourceId?: unknown }>(response);

    if (rows.length >= REVISION_SIZE_LIMIT) {
      this.logger.warn(
        `Distinct source enumeration hit REVISION_SIZE_LIMIT (${REVISION_SIZE_LIMIT}); some sources with knowledge indicators may be omitted from this result.`
      );
    }

    return rows.map((row) => row.sourceId).filter((id): id is string => typeof id === 'string');
  }

  async fetchLatestFeatures(
    sourceId: string,
    ids: string[]
  ): Promise<StoredFeatureKnowledgeIndicator[]> {
    if (ids.length === 0) return [];
    const where = combineWhere(
      inPredicate(TYPE, [KI_TYPE_FEATURE]),
      inPredicate(SOURCE_ID, [sourceId]),
      inPredicate(ID, ids)
    );
    const docs = await this.fetchLatestRevisions(where, IS_NOT_DELETED);
    return docs.filter(isStoredFeatureKnowledgeIndicator);
  }
}
