# Phase 04: DAG Decomposition & Status Tracking

## 1. Objectives
- Decompose the Product Specification into a Directed Acyclic Graph (DAG) of executable jobs.
- Initialize the status tracking system to manage the execution flow via MCP.

## 2. File Structure (STRICT)
- **DECOMPOSITION**: `.tenet/decomposition/{date}-{feature}.md` (e.g. `.tenet/decomposition/2026-04-08-oauth.md`)
- **JOB QUEUE**:     `.tenet/status/job-queue.md` (auto-generated from DB)
- **BACKLOG**:       `.tenet/status/backlog.md`
- **STATUS**:        `.tenet/status/status.md` (auto-generated from DB)

Use the same `{feature}` slug established during the interview phase. `{date}` is today's ISO date (YYYY-MM-DD).

## 3. Decomposition Format
The decomposition file must include:
- **ASCII DAG**: Visual representation of job dependencies.
- **Job Details**: For each job, specify ID, type, dependencies, deliverables, and verification criteria.
- **Interface Contracts**: Define data/state boundaries between dependent jobs.

## 4. Job Queue Format
Populate `job-queue.md` immediately after decomposition:
```markdown
| ID | Name | Status | Dependencies | Assigned |
|----|------|--------|-------------|----------|
| job-1 | Core Scaffold | pending | none | - |
| job-2 | Auth Service | pending | job-1 | - |
```
*Statuses: `pending`, `running`, `completed`, `failed`, `blocked`.*

## 5. Execution Protocol (CRITICAL)
1. **Write Files First**: Finish writing the decomposition file, `backlog.md`. Status files (`job-queue.md`, `status.md`) are auto-generated from the DB.
2. **Register Jobs**: Call `tenet_register_jobs` with all jobs from the DAG. This creates runtime entries so `tenet_continue()` can manage execution. Example:
   ```
   tenet_register_jobs({
     jobs: [
       { id: "job-1", name: "Core Scaffold", depends_on: [], prompt: "Set up project structure with..." },
       { id: "job-2", name: "Auth Service", depends_on: ["job-1"], prompt: "Implement authentication..." }
     ]
   })
   ```
3. **MCP Loop**: After registration, use `tenet_continue()` to get the next ready job, then `tenet_start_job` to dispatch it.
4. **No Bypassing**: Do NOT start executing or call subagents until all status files are updated AND jobs are registered.
5. **Small Batches**: Every job must be completable in one agent session with clear verification.

## 6. Verification
Update `.tenet/status/status.md` (mode, total jobs, current phase) before proceeding.
