// Filter builder: turns a flat {property, op, value} list from a ward into a
// Notion query filter. Pure, so the client can build the same specs the server
// validates. The client NEVER sends raw Notion filter JSON — an unvalidated
// filter object is a hole straight into someone's workspace.

export interface FilterSpec {
  property: string;
  op: string;
  value?: unknown;
}

/** Which ops each property type accepts. The key is also the Notion filter
 *  key — `{property: "Due", date: {on_or_after: "…"}}`. */
const OPS: Record<string, string[]> = {
  title: ['equals', 'does_not_equal', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'],
  rich_text: ['equals', 'does_not_equal', 'contains', 'does_not_contain', 'starts_with', 'ends_with', 'is_empty', 'is_not_empty'],
  url: ['equals', 'does_not_equal', 'contains', 'is_empty', 'is_not_empty'],
  email: ['equals', 'does_not_equal', 'contains', 'is_empty', 'is_not_empty'],
  phone_number: ['equals', 'does_not_equal', 'contains', 'is_empty', 'is_not_empty'],
  number: ['equals', 'does_not_equal', 'greater_than', 'less_than', 'greater_than_or_equal_to', 'less_than_or_equal_to', 'is_empty', 'is_not_empty'],
  checkbox: ['equals', 'does_not_equal'],
  select: ['equals', 'does_not_equal', 'is_empty', 'is_not_empty'],
  status: ['equals', 'does_not_equal', 'is_empty', 'is_not_empty'],
  multi_select: ['contains', 'does_not_contain', 'is_empty', 'is_not_empty'],
  date: ['equals', 'before', 'after', 'on_or_before', 'on_or_after', 'past_week', 'past_month', 'this_week', 'next_week', 'is_empty', 'is_not_empty'],
  created_time: ['before', 'after', 'on_or_before', 'on_or_after', 'past_week', 'past_month', 'this_week'],
  last_edited_time: ['before', 'after', 'on_or_before', 'on_or_after', 'past_week', 'past_month', 'this_week'],
  people: ['contains', 'does_not_contain', 'is_empty', 'is_not_empty'],
  created_by: ['contains', 'does_not_contain'],
  last_edited_by: ['contains', 'does_not_contain'],
  relation: ['contains', 'does_not_contain', 'is_empty', 'is_not_empty'],
  files: ['is_empty', 'is_not_empty'],
  unique_id: ['equals', 'does_not_equal', 'greater_than', 'less_than'],
};

/** Ops whose value is the literal `{}` — Notion's relative-date windows. */
const NO_VALUE = new Set(['past_week', 'past_month', 'past_year', 'this_week', 'next_week', 'next_month', 'next_year']);
/** Ops whose value is always the boolean true. */
const EMPTINESS = new Set(['is_empty', 'is_not_empty']);

export function opsFor(type: string): string[] {
  return OPS[type] ?? [];
}

function condition(type: string, spec: FilterSpec): Record<string, unknown> {
  const ops = opsFor(type);
  if (!ops.includes(spec.op)) throw Object.assign(new Error(`"${spec.op}" is not a filter for a ${type} column`), { status: 400 });
  let value: unknown;
  if (EMPTINESS.has(spec.op)) value = true;
  else if (NO_VALUE.has(spec.op)) value = {};
  else if (type === 'checkbox') value = spec.value === true || spec.value === 'true';
  else if (type === 'number' || type === 'unique_id') {
    const n = Number(spec.value);
    if (!Number.isFinite(n)) throw Object.assign(new Error(`"${spec.property}" needs a number`), { status: 400 });
    value = n;
  } else {
    value = String(spec.value ?? '').slice(0, 500);
    if (!value) throw Object.assign(new Error(`"${spec.property}" needs a value`), { status: 400 });
  }
  return { property: spec.property, [type]: { [spec.op]: value } };
}

/** All specs ANDed. Returns undefined for an empty list — Notion rejects an
 *  empty `and`, and "no filter" is the honest translation anyway. */
export function buildFilter(
  types: Record<string, { type: string }>,
  specs: FilterSpec[]
): Record<string, unknown> | undefined {
  const conds = specs.slice(0, 10).map((spec) => {
    const type = types[spec.property]?.type;
    if (!type) throw Object.assign(new Error(`no column named "${spec.property}"`), { status: 400 });
    return condition(type, spec);
  });
  if (!conds.length) return undefined;
  return conds.length === 1 ? conds[0] : { and: conds };
}
