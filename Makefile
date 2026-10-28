# community_service — Bun + TypeScript service
#
# Single entrypoints for local development and CI (see docs/engineering_guide.md).
# Runtime is Bun only: never `node`, never `npm`.

BUN ?= bun
PORT ?= 3000

.PHONY: help install dev test typecheck lint build run db-generate clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	$(BUN) install --frozen-lockfile

dev: ## Run the service with hot reload
	$(BUN) run --watch src/index.ts

test: ## Run the full test suite with coverage (unit + integration)
	$(BUN) test --coverage

typecheck: ## Strict TypeScript type check (no emit)
	$(BUN) run typecheck

lint: ## Lint: strict TypeScript check (no extra linter is an approved dependency)
	$(BUN) run typecheck

build: ## Type check and bundle the service for production
	$(BUN) run typecheck
	$(BUN) build ./src/index.ts --target bun --outdir ./dist --sourcemap=external

run: ## Run the built bundle
	PORT=$(PORT) $(BUN) run --smol ./dist/index.js

db-generate: ## Generate drizzle-kit SQL migrations from the typed schema
	$(BUN) x drizzle-kit generate

clean: ## Remove build and coverage artifacts
	rm -rf dist coverage
