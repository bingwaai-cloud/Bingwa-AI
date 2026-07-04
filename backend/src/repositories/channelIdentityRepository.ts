import { db } from '../db.js'

/**
 * channel_identities — BSUID→phone mapping (WP-26).
 *
 * This is a NO-RLS pre-context lookup table (like tenant_users). It mirrors
 * Meta's Contact Book so Gezi never depends on Meta retaining the phone→BSUID
 * mapping. It is queryable BEFORE tenant resolution.
 *
 * Only the gezi_app service role reads this table.
 */

export interface ChannelIdentityRow {
  id: string
  channel: string
  identity_type: 'phone' | 'bsuid'
  external_id: string
  phone: string | null
  first_seen_at: Date
  last_seen_at: Date
}

/**
 * UPSERT a channel identity row.
 *
 * Whenever a webhook carries BOTH a phone and a BSUID, we INSERT or UPDATE
 * the bsuid row with the resolved phone set. This is our own mirror — Meta
 * may lose the mapping; we won't.
 */
export async function upsertChannelIdentity(params: {
  channel: string
  identity_type: 'phone' | 'bsuid'
  external_id: string
  phone: string | null
}): Promise<void> {
  await db.$executeRaw`
    INSERT INTO public.channel_identities
      (channel, identity_type, external_id, phone, first_seen_at, last_seen_at)
    VALUES
      (${params.channel}, ${params.identity_type}, ${params.external_id},
       ${params.phone}, now(), now())
    ON CONFLICT (channel, identity_type, external_id)
    DO UPDATE SET
      phone = COALESCE(EXCLUDED.phone, channel_identities.phone),
      last_seen_at = now()
  `
}

/**
 * Look up the phone for a BSUID.
 * Returns null if the BSUID has never been linked to a phone.
 */
export async function findPhoneByBsuid(
  channel: string,
  bsuid: string
): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ phone: string | null }>>`
    SELECT phone FROM public.channel_identities
    WHERE channel = ${channel}
      AND identity_type = 'bsuid'
      AND external_id = ${bsuid}
      AND phone IS NOT NULL
    LIMIT 1
  `
  return rows.length > 0 ? rows[0]!.phone : null
}