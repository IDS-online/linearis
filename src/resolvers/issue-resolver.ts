import type { GraphQLClient } from "../client/graphql-client.js";
import { isEntityNotFoundError, notFoundError } from "../common/errors.js";
import {
  asUuid,
  isUuid,
  parseIssueIdentifier,
  tryParseIssueIdentifier,
  type UUID,
} from "../common/identifier.js";
import {
  FindIssueByAnyIdentifierDocument,
  FindIssuesDocument,
  type FindIssuesQuery,
  type IssueFilter,
} from "../gql/graphql.js";
import { mapParent, type ParentNode } from "./batch-resolve-mappers.js";
import {
  resolveTeamEstimateContext,
  type TeamEstimateContext,
} from "./team-resolver.js";

/** The identity fields every issue lookup in this module selects. */
type IssueLookupNode = FindIssuesQuery["issues"]["nodes"][number];

/** Builds the FindIssues filter for a UUID or "TEAM-123" identifier. */
function issueLookupFilter(issueIdOrIdentifier: string): IssueFilter {
  if (isUuid(issueIdOrIdentifier)) {
    return { id: { eq: issueIdOrIdentifier } };
  }

  const { teamKey, issueNumber } = parseIssueIdentifier(issueIdOrIdentifier);
  return {
    number: { eq: issueNumber },
    team: { key: { eq: teamKey } },
  };
}

/**
 * Second-chance lookup for a reference {@link issueLookupFilter} missed.
 *
 * Linear remembers the identifiers an issue carried before it moved teams and
 * resolves them through `issue(id:)`. The filter cannot: it matches the team
 * key and number the issue has *now*, so every reference recorded before the
 * move — in a script, a commit message, a ticket body — stops resolving the
 * moment the issue changes teams.
 *
 * Only identifier-shaped references are retried: a UUID already resolves
 * through the filter, and a malformed string would trade a precise format
 * error for a confusing API one. Returns null when Linear knows no such issue,
 * leaving the caller to report not-found for the reference actually given.
 */
export async function findIssueByPreviousIdentifier(
  client: GraphQLClient,
  issueIdOrIdentifier: string,
): Promise<IssueLookupNode | null> {
  if (
    isUuid(issueIdOrIdentifier) ||
    !tryParseIssueIdentifier(issueIdOrIdentifier)
  ) {
    return null;
  }

  try {
    const { issue } = await client.request(FindIssueByAnyIdentifierDocument, {
      id: issueIdOrIdentifier,
    });
    return issue ?? null;
  } catch (error) {
    if (isEntityNotFoundError(error)) return null;
    throw error;
  }
}

export interface IssueEstimateContext {
  issueId: UUID;
  team: TeamEstimateContext;
}

/**
 * Resolves issue identifier to UUID.
 *
 * Accepts UUID or issue identifier (e.g., "ENG-123"), including one the issue
 * carried before a team move.
 *
 * @param client - GraphQL client
 * @param issueIdOrIdentifier - Issue UUID or identifier
 * @returns Issue UUID
 * @throws Error if issue not found
 */
export async function resolveIssueId(
  client: GraphQLClient,
  issueIdOrIdentifier: string,
): Promise<UUID> {
  if (isUuid(issueIdOrIdentifier)) return asUuid(issueIdOrIdentifier);

  const { issues } = await client.request(FindIssuesDocument, {
    filter: issueLookupFilter(issueIdOrIdentifier),
    first: 1,
  });

  const node =
    issues.nodes[0] ??
    (await findIssueByPreviousIdentifier(client, issueIdOrIdentifier));

  if (!node) throw notFoundError("Issue", issueIdOrIdentifier);

  return asUuid(node.id);
}

/** An issue reference resolved to its UUID plus the team that scopes it. */
export interface ResolvedIssueRef {
  ref: string;
  id: UUID;
  teamId: UUID;
  teamKey: string;
}

/**
 * Resolves a list of issue references in one request.
 *
 * Unlike {@link resolveIssueId} this also returns each issue's team, because
 * the batch-update caller needs it: `issueBatchUpdate` applies a single patch
 * to every target, so a status or cycle named by word can only be resolved
 * when all targets share one team. UUID references are looked up rather than
 * passed straight through for the same reason — the team is not derivable from
 * a UUID.
 *
 * Duplicate references collapse to one entry, preserving first-seen order.
 *
 * @throws Error if any reference does not match an issue
 */
export async function resolveIssueRefs(
  client: GraphQLClient,
  refs: readonly string[],
): Promise<ResolvedIssueRef[]> {
  const unique = [...new Set(refs)];

  if (unique.length === 0) {
    return [];
  }

  const { issues } = await client.request(FindIssuesDocument, {
    filter: { or: unique.map(issueLookupFilter) },
    first: unique.length,
  });

  // Only the references this one response did not cover fall back, and each
  // falls back on its own: a single moved issue in a batch costs one extra
  // lookup instead of failing every reference alongside it.
  const nodes = await Promise.all(
    unique.map(async (ref) => {
      const matched = issues.nodes.find((candidate) =>
        isUuid(ref)
          ? candidate.id === ref
          : matchesIdentifier(candidate, parseIssueIdentifier(ref)),
      );

      return matched ?? (await findIssueByPreviousIdentifier(client, ref));
    }),
  );

  return unique.map((ref, index) => {
    const node = nodes[index];

    if (!node) {
      throw notFoundError("Issue", ref);
    }

    return {
      ref,
      id: asUuid(node.id),
      teamId: asUuid(node.team.id),
      teamKey: node.team.key,
    };
  });
}

function matchesIdentifier(
  node: { number: number; team: { key: string } },
  identifier: { teamKey: string; issueNumber: number },
): boolean {
  return (
    node.number === identifier.issueNumber &&
    node.team.key === identifier.teamKey
  );
}

/**
 * {@link mapParent} with the previous-identifier second chance.
 *
 * The `BatchResolve*` queries look a parent up by team key and number, so a
 * parent that has since moved teams is simply absent from the response — the
 * same miss {@link findIssueByPreviousIdentifier} exists to cover. The
 * not-found error, when both paths come up empty, is still `mapParent`'s.
 */
export async function resolveParentIssueId(
  client: GraphQLClient,
  nodes: ParentNode[],
  ref: string,
): Promise<UUID> {
  if (nodes.length === 0) {
    const moved = await findIssueByPreviousIdentifier(client, ref);
    if (moved) return asUuid(moved.id);
  }

  return mapParent(nodes, ref);
}

export async function resolveIssueEstimateContext(
  client: GraphQLClient,
  issueIdOrIdentifier: string,
): Promise<IssueEstimateContext> {
  const { issues } = await client.request(FindIssuesDocument, {
    filter: issueLookupFilter(issueIdOrIdentifier),
    first: 1,
  });

  const node =
    issues.nodes[0] ??
    (await findIssueByPreviousIdentifier(client, issueIdOrIdentifier));

  if (!node) throw notFoundError("Issue", issueIdOrIdentifier);

  return {
    issueId: asUuid(node.id),
    team: await resolveTeamEstimateContext(client, node.team.id),
  };
}
