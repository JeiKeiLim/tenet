.PHONY: help build clean test lint typecheck check dev publish link unlink

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
