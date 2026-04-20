.PHONY: help build clean test test-e2e lint typecheck check dev publish link unlink e2e-cli e2e-api e2e-web e2e-all

.DEFAULT_GOAL := help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

# Build
build: ## Compile TypeScript
	pnpm run build

clean: ## Remove dist/ and build cache
	pnpm run clean

dev: ## Watch mode (rebuild on change)
	pnpm run build:watch

# Quality checks
test: ## Run tests
	pnpm run test

lint: ## Run ESLint
	pnpm run lint

typecheck: ## Type-check without emitting
	pnpm run typecheck

check: clean build typecheck lint test ## Run all checks (pre-publish gate)

# E2E canaries (manual — each runs a real agent CLI end-to-end; costs money/time)
# See docs/e2e-runbook.md for setup, cost estimates, and troubleshooting.
e2e-cli: ## E2E: build a tiny CLI tool canary (~5-10 min, ~$0.05-0.80)
	pnpm vitest run --config vitest.e2e.config.ts tests/e2e/canary-cli.e2e.test.ts

e2e-api: ## E2E: build an in-memory notes API canary (~10-15 min, ~$0.08-1.20)
	pnpm vitest run --config vitest.e2e.config.ts tests/e2e/canary-api.e2e.test.ts

e2e-web: ## E2E: build a static click-counter page canary (~8-12 min, ~$0.07-1.00)
	pnpm vitest run --config vitest.e2e.config.ts tests/e2e/canary-web.e2e.test.ts

e2e-all: ## E2E: run all three canaries sequentially (~25-35 min, ~$0.20-2.50)
	pnpm vitest run --config vitest.e2e.config.ts

# Local development
link: build ## Build and link globally for local dev
	pnpm link --global

unlink: ## Remove global tenet shims
	rm -f "$$(pnpm root -g)/../tenet" "$$(pnpm root -g)/../tenet-mcp"

# Publishing
publish: check ## Full check + npm publish
	npm publish

bump-patch: ## Bump patch version (26.4.1 -> 26.4.2)
	@current=$$(node -p "require('./package.json').version"); \
	IFS='.' read -r yy mm patch <<< "$$current"; \
	new="$$yy.$$mm.$$((patch + 1))"; \
	sed -i '' "s/\"version\": \"$$current\"/\"version\": \"$$new\"/" package.json; \
	echo "$$current -> $$new"

bump-month: ## Reset to current month (YY.MM.0)
	@yy=$$(date +%y); mm=$$(date +%-m); \
	new="$$yy.$$mm.0"; \
	current=$$(node -p "require('./package.json').version"); \
	sed -i '' "s/\"version\": \"$$current\"/\"version\": \"$$new\"/" package.json; \
	echo "$$current -> $$new"

release: bump-patch check ## Bump patch + check + publish
	npm publish
	@echo "Published $$(node -p "require('./package.json').version")"
