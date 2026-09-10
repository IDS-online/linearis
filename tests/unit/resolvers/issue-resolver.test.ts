// tests/unit/resolvers/issue-resolver.test.ts
import { describe, expect, it, vi } from "vitest";
import type { GraphQLClient } from "../../../src/client/graphql-client.js";
import {
  FindIssueByAnyIdentifierDocument,
  FindIssuesDocument,
} from "../../../src/gql/graphql.js";
import {
  findIssueByPreviousIdentifier,
  resolveIssueEstimateContext,
  resolveIssueId,
  resolveIssueRefs,
  resolveParentIssueId,
} from "../../../src/resolvers/issue-resolver.js";

type IssueNode = {
  id: string;
  team: { id: string; key: string };
};

type TeamNode = {
  id: string;
  key: string;
  name: string;
  issueEstimationType:
    | "notUsed"
    | "exponential"
    | "fibonacci"
    | "linear"
    | "tShirt";
  issueEstimationExtended: boolean;
  issueEstimationAllowZero: boolean;
};

// The estimate-context resolver issues two requests: FindIssues, then FindTeams
// (via resolveTeamEstimateContext). resolveIssueId only issues the first.
function mockGqlClient(issueNodes: IssueNode[], teamNodes: TeamNode[] = []) {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ issues: { nodes: issueNodes } })
    .mockResolvedValueOnce({ teams: { nodes: teamNodes } });
  return { request } as unknown as GraphQLClient;
}

const teamId = "550e8400-e29b-41d4-a716-446655440001";

const exponentialTeam: TeamNode = {
  id: teamId,
  key: "ENG",
  name: "Engineering",
  issueEstimationType: "exponential",
  issueEstimationExtended: false,
  issueEstimationAllowZero: false,
};

const engIssue: IssueNode = {
  id: "issue-uuid",
  team: { id: teamId, key: "ENG" },
};

describe("resolveIssueId", () => {
  it("returns UUID as-is", async () => {
    const client = mockGqlClient([]);
    const result = await resolveIssueId(
      client,
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(result).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("resolves ABC-123 identifier", async () => {
    const client = mockGqlClient([engIssue]);
    const result = await resolveIssueId(client, "ENG-42");
    expect(result).toBe("issue-uuid");
    expect(client.request).toHaveBeenCalledWith(expect.anything(), {
      filter: { number: { eq: 42 }, team: { key: { eq: "ENG" } } },
      first: 1,
    });
  });

  it("throws when issue not found", async () => {
    const client = mockGqlClient([]);
    await expect(resolveIssueId(client, "ENG-999")).rejects.toThrow(
      'Issue "ENG-999" not found',
    );
  });
});

describe("resolveIssueEstimateContext", () => {
  it("resolves identifier, derives team from the issue, and returns issueId plus team context", async () => {
    const client = mockGqlClient([engIssue], [exponentialTeam]);

    await expect(
      resolveIssueEstimateContext(client, "ENG-42"),
    ).resolves.toEqual({
      issueId: "issue-uuid",
      team: {
        teamId,
        teamKey: "ENG",
        teamName: "Engineering",
        issueEstimationType: "exponential",
        issueEstimationExtended: false,
        issueEstimationAllowZero: false,
      },
    });

    expect(client.request).toHaveBeenNthCalledWith(1, expect.anything(), {
      filter: { number: { eq: 42 }, team: { key: { eq: "ENG" } } },
      first: 1,
    });
    expect(client.request).toHaveBeenNthCalledWith(2, expect.anything(), {
      filter: { id: { eq: teamId } },
      first: 1,
    });
  });

  it("resolves by UUID using an id eq filter", async () => {
    const client = mockGqlClient([engIssue], [exponentialTeam]);

    await resolveIssueEstimateContext(
      client,
      "550e8400-e29b-41d4-a716-446655440000",
    );

    expect(client.request).toHaveBeenNthCalledWith(1, expect.anything(), {
      filter: { id: { eq: "550e8400-e29b-41d4-a716-446655440000" } },
      first: 1,
    });
  });

  it("throws Issue not found", async () => {
    const client = mockGqlClient([]);

    await expect(
      resolveIssueEstimateContext(client, "ENG-999"),
    ).rejects.toThrow('Issue "ENG-999" not found');
  });
});

describe("resolveIssueRefs", () => {
  const nodes = [
    {
      id: "550e8400-e29b-41d4-a716-4466554400e1",
      number: 1,
      team: { id: teamId, key: "ENG" },
    },
    { id: "eng-2-uuid", number: 2, team: { id: teamId, key: "ENG" } },
    { id: "des-1-uuid", number: 1, team: { id: "des-team", key: "DES" } },
  ];

  function mockRefsClient() {
    const request = vi.fn().mockResolvedValue({ issues: { nodes } });
    return { request, client: { request } as unknown as GraphQLClient };
  }

  it("resolves every reference in a single request", async () => {
    const { request, client } = mockRefsClient();

    const resolved = await resolveIssueRefs(client, ["ENG-1", "DES-1"]);

    expect(resolved).toEqual([
      {
        ref: "ENG-1",
        id: "550e8400-e29b-41d4-a716-4466554400e1",
        teamId,
        teamKey: "ENG",
      },
      { ref: "DES-1", id: "des-1-uuid", teamId: "des-team", teamKey: "DES" },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.anything(), {
      filter: {
        or: [
          { number: { eq: 1 }, team: { key: { eq: "ENG" } } },
          { number: { eq: 1 }, team: { key: { eq: "DES" } } },
        ],
      },
      first: 2,
    });
  });

  it("distinguishes the same issue number across teams", async () => {
    const { client } = mockRefsClient();

    const resolved = await resolveIssueRefs(client, ["DES-1"]);

    expect(resolved[0]?.id).toBe("des-1-uuid");
  });

  it("collapses duplicate references, preserving first-seen order", async () => {
    const { client } = mockRefsClient();

    const resolved = await resolveIssueRefs(client, [
      "ENG-2",
      "ENG-1",
      "ENG-2",
    ]);

    expect(resolved.map((entry) => entry.ref)).toEqual(["ENG-2", "ENG-1"]);
  });

  it("looks up UUID references too, since a UUID carries no team", async () => {
    const { client } = mockRefsClient();

    const resolved = await resolveIssueRefs(client, [
      "550e8400-e29b-41d4-a716-4466554400e1",
    ]);

    expect(resolved[0]?.teamKey).toBe("ENG");
  });

  it("throws for a reference with no match", async () => {
    const { client } = mockRefsClient();

    await expect(resolveIssueRefs(client, ["ENG-99"])).rejects.toThrow(
      'Issue "ENG-99" not found',
    );
  });

  it("makes no request for an empty list", async () => {
    const { request, client } = mockRefsClient();

    await expect(resolveIssueRefs(client, [])).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

/**
 * An issue that has moved teams: the key/number filter no longer matches the
 * identifier it was referenced by, and only `issue(id:)` still resolves it.
 */
type LookupNode = {
  id: string;
  number?: number;
  identifier?: string;
  previousIdentifiers?: string[];
  team: { id: string; key: string };
};

/** An issue now living in team ZZX that used to answer to `ref`. */
function movedFrom(ref: string, id = "moved-uuid"): LookupNode {
  return {
    id,
    identifier: "ZZX-1",
    previousIdentifiers: [ref],
    team: { id: "zzx-team", key: "ZZX" },
  };
}

const movedIssue = movedFrom("ENG-42");

/**
 * Answers per document rather than per call, so a test can say "the filter
 * finds nothing, `issue(id:)` finds the moved issue" without depending on the
 * order the resolver happens to make its requests in.
 */
function mockMovedIssueClient(options: {
  filterNodes?: LookupNode[];
  moved?: LookupNode | null;
  fallbackError?: Error;
  teams?: TeamNode[];
}) {
  const request = vi.fn(async (document: unknown) => {
    if (document === FindIssueByAnyIdentifierDocument) {
      if (options.fallbackError) throw options.fallbackError;
      return { issue: options.moved ?? null };
    }
    if (document === FindIssuesDocument) {
      return { issues: { nodes: options.filterNodes ?? [] } };
    }
    return { teams: { nodes: options.teams ?? [] } };
  });

  return { request, client: { request } as unknown as GraphQLClient };
}

/** Linear's error for a reference it does not recognise at all. */
const entityNotFound = new Error("Entity not found: Issue");

describe("previous-identifier fallback", () => {
  it("resolveIssueId resolves an identifier the issue carried before a team move", async () => {
    const { request, client } = mockMovedIssueClient({ moved: movedIssue });

    await expect(resolveIssueId(client, "ENG-42")).resolves.toBe("moved-uuid");
    expect(request).toHaveBeenNthCalledWith(
      2,
      FindIssueByAnyIdentifierDocument,
      { id: "ENG-42" },
    );
  });

  it("resolveIssueId does not fall back when the filter already matched", async () => {
    const { request, client } = mockMovedIssueClient({
      filterNodes: [engIssue],
    });

    await expect(resolveIssueId(client, "ENG-42")).resolves.toBe("issue-uuid");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("resolveIssueId reports not found when Linear knows no such identifier", async () => {
    const { client } = mockMovedIssueClient({ fallbackError: entityNotFound });

    await expect(resolveIssueId(client, "ENG-999")).rejects.toThrow(
      'Issue "ENG-999" not found',
    );
  });

  it("resolveIssueId rethrows a failure that is not an unknown reference", async () => {
    const { client } = mockMovedIssueClient({
      fallbackError: new Error("Request timed out"),
    });

    await expect(resolveIssueId(client, "ENG-42")).rejects.toThrow(
      "Request timed out",
    );
  });

  it("keeps the format error for a malformed reference instead of calling issue(id:)", async () => {
    const { request, client } = mockMovedIssueClient({});

    await expect(resolveIssueId(client, "not an identifier")).rejects.toThrow(
      "Invalid issue identifier format",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("findIssueByPreviousIdentifier makes no request for a UUID or a malformed reference", async () => {
    const { request, client } = mockMovedIssueClient({ moved: movedIssue });

    await expect(
      findIssueByPreviousIdentifier(
        client,
        "550e8400-e29b-41d4-a716-446655440000",
      ),
    ).resolves.toBeNull();
    await expect(
      findIssueByPreviousIdentifier(client, "ENG-x-1"),
    ).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("resolveIssueRefs mixes current and previous identifiers, one lookup per miss", async () => {
    const { request, client } = mockMovedIssueClient({
      filterNodes: [
        { id: "issue-uuid", number: 42, team: { id: teamId, key: "ENG" } },
      ],
      moved: movedFrom("ENG-7"),
    });

    await expect(
      resolveIssueRefs(client, ["ENG-42", "ENG-7"]),
    ).resolves.toEqual([
      { ref: "ENG-42", id: "issue-uuid", teamId, teamKey: "ENG" },
      {
        ref: "ENG-7",
        id: "moved-uuid",
        teamId: "zzx-team",
        teamKey: "ZZX",
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("resolveIssueEstimateContext derives the team from the moved issue", async () => {
    const { client } = mockMovedIssueClient({
      moved: {
        id: "moved-uuid",
        identifier: "ZZX-1",
        previousIdentifiers: ["ENG-42"],
        team: { id: teamId, key: "ENG" },
      },
      teams: [exponentialTeam],
    });

    await expect(
      resolveIssueEstimateContext(client, "ENG-42"),
    ).resolves.toMatchObject({
      issueId: "moved-uuid",
      team: { teamId, teamKey: "ENG" },
    });
  });

  it("resolveParentIssueId finds a parent that has moved teams", async () => {
    const { client } = mockMovedIssueClient({ moved: movedIssue });

    await expect(resolveParentIssueId(client, [], "ENG-42")).resolves.toBe(
      "moved-uuid",
    );
  });

  it("resolveParentIssueId keeps the batch match when there is one", async () => {
    const { request, client } = mockMovedIssueClient({ moved: movedIssue });

    await expect(
      resolveParentIssueId(
        client,
        [{ id: "parent-uuid", identifier: "ENG-42" }],
        "ENG-42",
      ),
    ).resolves.toBe("parent-uuid");
    expect(request).not.toHaveBeenCalled();
  });

  it("resolveParentIssueId reports the unknown parent", async () => {
    const { client } = mockMovedIssueClient({ fallbackError: entityNotFound });

    await expect(resolveParentIssueId(client, [], "ENG-999")).rejects.toThrow(
      'Issue "ENG-999" not found',
    );
  });
});

describe("attesting a fallback hit", () => {
  it("resolves when the issue lists the identifier among its previous ones", async () => {
    const { client } = mockMovedIssueClient({ moved: movedFrom("ENG-42") });

    await expect(resolveIssueId(client, "ENG-42")).resolves.toBe("moved-uuid");
  });

  it("resolves when the identifier is the issue's current one", async () => {
    const { client } = mockMovedIssueClient({
      moved: {
        id: "moved-uuid",
        identifier: "ENG-42",
        previousIdentifiers: [],
        team: { id: teamId, key: "ENG" },
      },
    });

    await expect(resolveIssueId(client, "ENG-42")).resolves.toBe("moved-uuid");
  });

  it("refuses an issue that carries neither, rather than returning its UUID", async () => {
    const { client } = mockMovedIssueClient({
      moved: {
        id: "someone-elses-uuid",
        identifier: "ZZX-9",
        previousIdentifiers: ["DES-3"],
        team: { id: "zzx-team", key: "ZZX" },
      },
    });

    await expect(resolveIssueId(client, "ENG-42")).rejects.toThrow(
      'Issue "ENG-42" not found',
    );
  });

  it("refuses it in the batch path too", async () => {
    const { client } = mockMovedIssueClient({
      moved: {
        id: "someone-elses-uuid",
        identifier: "ZZX-9",
        previousIdentifiers: ["DES-3"],
        team: { id: "zzx-team", key: "ZZX" },
      },
    });

    await expect(resolveIssueRefs(client, ["ENG-42"])).rejects.toThrow(
      'Issue "ENG-42" not found',
    );
    await expect(resolveIssueEstimateContext(client, "ENG-42")).rejects.toThrow(
      'Issue "ENG-42" not found',
    );
    await expect(resolveParentIssueId(client, [], "ENG-42")).rejects.toThrow(
      'Issue "ENG-42" not found',
    );
  });

  it("asks by the canonical spelling, so a padded number resolves", async () => {
    const { request, client } = mockMovedIssueClient({
      moved: movedFrom("ENG-42"),
    });

    await expect(resolveIssueId(client, "ENG-042")).resolves.toBe("moved-uuid");
    expect(request).toHaveBeenNthCalledWith(
      2,
      FindIssueByAnyIdentifierDocument,
      { id: "ENG-42" },
    );
  });
});
