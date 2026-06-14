/**
 * Tenant provisioning.
 *
 * Row-level multi-tenancy (P0-1): creating a tenant is now just an INSERT into
 * public.tenants (see tenantRepository.createTenant) -- there is NO per-tenant
 * schema DDL at signup anymore. The old createTenantSchema()/dropTenantSchema() helpers (which ran raw
 * CREATE/DROP SCHEMA DDL) have been removed;
 * isolation is enforced by withTenant() + Postgres RLS instead.
 *
 * This module is intentionally empty. Schema-per-tenant returns only later as a
 * "promote large tenant to a dedicated database" feature (see scalability.md).
 */
export {}
