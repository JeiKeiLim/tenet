# Phase 00: Brownfield Codebase Scan

## When to Run
Execute this phase immediately after `.tenet/` initialization if the project directory contains existing source code. Trigger this scan when any of the following signals are detected:
- Presence of standard source directories: `src/`, `lib/`, `app/`, `pkg/`, `internal/`
- Existence of package manifests: `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`
- Build or automation files: `Makefile`, `Dockerfile`, `docker-compose.yml`, `CMakeLists.txt`
- Direct source files: any `.py`, `.ts`, `.js`, `.go`, `.rs`, `.java`, `.cpp`, `.rb`, `.php` files

## Output File
Save all findings to: `.tenet/bootstrap/codebase-scan.md`

## Scan Process
Perform a read-only reconnaissance of the repository. Do not modify, refactor, or test existing code. Focus on extracting the following data points:

1. **Tech Stack**: Identify languages, frameworks, runtimes, and package managers.
2. **Directory Structure**: Map the top level layout and note naming conventions (e.g., kebab-case, PascalCase).
3. **Existing Patterns**: Determine the architecture style (MVC, Hexagonal, Microservices, Monolith). Identify state management, API patterns (REST, GraphQL, gRPC), and database layers.
4. **Testing**: Locate existing tests and identify the testing framework used.
5. **CI/CD**: Find configuration files for GitHub Actions, GitLab CI, Jenkins, or other providers.
6. **Entry Points**: Identify main execution files, CLI command definitions, and server start scripts.
7. **Documentation**: Note the presence and quality of READMEs, `/docs` folders, or comprehensive inline comments.

## Output Format
Use the following template for `.tenet/bootstrap/codebase-scan.md`. Tag every finding with `[scanned-not-verified]`.

```markdown
# Brownfield Codebase Scan Summary

## Tech Stack [scanned-not-verified]
- Languages: 
- Frameworks: 
- Package Manager: 

## Architecture & Patterns [scanned-not-verified]
- Style: 
- API: 
- Persistence: 

## Project Layout [scanned-not-verified]
- Source Root: 
- Key Directories: 

## Development Lifecycle [scanned-not-verified]
- Entry Point: 
- Test Framework: 
- CI/CD Provider: 

## Existing Documentation [scanned-not-verified]
- Status: 
```

## What NOT to Do
- **No Writing**: Do not create or edit any source files, configuration files, or tests.
- **No Refactoring**: Do not attempt to fix "code smells" or bugs discovered during the scan.
- **No Execution**: Do not run the application or its test suite unless explicitly required for version detection.

## Handoff to Interview
Once the scan is complete and `.tenet/bootstrap/codebase-scan.md` is written, proceed immediately to the Interview phase. Use the scan results to tailor interview questions. If the scan identifies a React frontend, ask about component library preferences or state management choices rather than asking if they use a frontend framework.
