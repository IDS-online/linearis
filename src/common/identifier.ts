const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

export function isUuid(value: string): value is UUID {
  return UUID_REGEX.test(value);
}

/**
 * A resolved Linear entity UUID.
 *
 * Branded so the compiler enforces the architecture invariant that services
 * receive already-resolved IDs: a plain `string` (e.g. a human identifier like
 * `ENG-123`) is not assignable to `UUID`, but a `UUID` flows into `string`
 * slots (such as codegen GraphQL inputs) untouched. The brand is erased at
 * runtime, so a `UUID` behaves exactly like the underlying string.
 */
export type UUID = Brand<string, "UUID">;

/**
 * Brand a string as a resolved UUID at a trust boundary — the output of a
 * resolver, or a UUID the user supplied directly on the CLI. Performs no
 * runtime validation.
 */
export function asUuid(value: string): UUID {
  return value as UUID;
}

/** Replace a `string`/`string[]` core with `UUID`/`UUID[]`, preserving null/undefined. */
type ReplaceStringWithUuid<V> = V extends string
  ? UUID
  : V extends string[]
    ? UUID[]
    : V;

/**
 * Brand selected keys of an input type as UUID, preserving each field's
 * optional and readonly modifiers (homomorphic over `keyof T`).
 */
export type BrandUuidFields<T, K extends keyof T> = {
  [P in keyof T]: P extends K ? ReplaceStringWithUuid<T[P]> : T[P];
};

export interface IssueIdentifier {
  teamKey: string;
  issueNumber: number;
}

/** @throws Error if identifier format is invalid */
export function parseIssueIdentifier(identifier: string): IssueIdentifier {
  const [teamKey, issueNumberRaw, ...rest] = identifier.split("-");

  if (
    teamKey === undefined ||
    issueNumberRaw === undefined ||
    rest.length > 0
  ) {
    throw new Error(
      `Invalid issue identifier format: "${identifier}". Expected format: TEAM-123`,
    );
  }

  const issueNumber = parseInt(issueNumberRaw, 10);

  if (Number.isNaN(issueNumber)) {
    throw new Error(`Invalid issue number in identifier: "${identifier}"`);
  }

  return { teamKey, issueNumber };
}

export function tryParseIssueIdentifier(
  identifier: string,
): IssueIdentifier | null {
  try {
    return parseIssueIdentifier(identifier);
  } catch {
    // parseIssueIdentifier throws on invalid format — return null per try-parse contract
    return null;
  }
}

/** The canonical `TEAM-123` spelling of a parsed identifier ("ENG-007" → "ENG-7"). */
export function formatIssueIdentifier(identifier: IssueIdentifier): string {
  return `${identifier.teamKey}-${identifier.issueNumber}`;
}

/**
 * Whether an issue answers to `ref` — as its current identifier, or as one it
 * carried before it moved teams.
 *
 * This is the attestation behind every previous-identifier fallback, and the
 * only reason those fallbacks are safe. `issue(id:)` resolves far more than the
 * key-and-number reference the CLI asked about, so a hit is trusted only when
 * the issue demonstrably carries that exact reference; anything else is a
 * different issue and must be reported not-found rather than returned.
 *
 * The comparison is exact, after normalizing `ref` the way every other lookup
 * normalizes it. Linear's own key/number filter is case-sensitive, so accepting
 * a differently-cased spelling here would let the fallback resolve references
 * the primary lookup rejects.
 */
export function issueCarriesIdentifier(
  issue: { identifier: string; previousIdentifiers: readonly string[] },
  ref: string,
): boolean {
  const parsed = tryParseIssueIdentifier(ref);

  if (!parsed) return false;

  const canonical = formatIssueIdentifier(parsed);

  return (
    issue.identifier === canonical ||
    issue.previousIdentifiers.includes(canonical)
  );
}

const DUE_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

/** @throws Error if date format is invalid or date doesn't exist */
export function parseDueDate(value: string): string {
  const match = DUE_DATE_REGEX.exec(value);
  if (!match) {
    throw new Error(
      `Invalid due date format: "${value}". Expected format: YYYY-MM-DD`,
    );
  }

  // The three capture groups are guaranteed present when the regex matches.
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`Invalid due date: "${value}". The date does not exist.`);
  }

  return value;
}
