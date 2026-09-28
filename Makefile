# BrandBlitz — common local dev workflows.
#
# Each target is a thin wrapper around an existing pnpm script or docker
# compose service sequence; no logic is duplicated here. Raw equivalents are
# documented in README.md (Quick Start + Workspace Scripts).

.DEFAULT_GOAL := help

.PHONY: help dev reset-db seed test clean

# List the available targets.
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

# Start local development end-to-end:
#   1. infra containers (postgres, redis, minio + bucket bootstrap) — waits for healthchecks
#   2. pending API migrations — wraps apps/api/scripts/migrate.ts via `pnpm --filter @brandblitz/api migrate`
#   3. all workspace dev servers — `pnpm dev` (Turborepo)
dev: ## Start infra, apply migrations, run all dev servers
	docker compose up -d --wait postgres redis minio
	docker compose run --rm minio-setup
	pnpm --filter @brandblitz/api migrate
	pnpm dev

# Fully reset the local database: drops and recreates the schema, then
# reapplies every migration. Wraps apps/api/scripts/reset-db.ts (which shells
# out to apps/api/scripts/migrate.ts). Follow with `make seed` to restore fixtures.
reset-db: ## Drop, recreate, and re-migrate the local database
	pnpm db:reset

# Seed deterministic local fixtures — wraps apps/api/scripts/seed.ts.
# Idempotent by default; pass SEED_FLAGS="-- --reset" to truncate all seed-*
# fixture rows first (see apps/api/scripts/seed.ts and README Quick Start).
seed: ## Seed local fixtures (SEED_FLAGS="-- --reset" wipes first)
	pnpm --filter @brandblitz/api seed $(SEED_FLAGS)

# Run the full unit/integration test suite (vitest, monorepo root config).
test: ## Run all tests
	pnpm test

# Remove build artifacts and node_modules across the workspace.
clean: ## Remove build artifacts and node_modules
	pnpm clean
