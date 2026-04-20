# Spec — `note-store` in-memory API

## Summary

Build a minimal Express (or Node's built-in http) API with an in-memory store of notes. Shared state between requests means parallel evals would contend on the same port and the same in-memory map; **eval_parallel_safe is expected to be false**.

## Acceptance Criteria

### Endpoints

- `POST /notes` with body `{"text": "..."}` → responds `201 Created` with body `{"id": "<uuid>", "text": "..."}`. Reject missing/empty `text` with `400`.
- `GET /notes/:id` → responds `200 OK` with the note, or `404` if not found.
- `GET /notes` → responds `200 OK` with an array of all notes, newest first.

### Behavior

- Notes are stored in a single in-process `Map<string, Note>`.
- IDs are generated with `crypto.randomUUID()`.
- The server listens on a port from `process.env.PORT` (default `3000`).

## Non-goals

- No persistence.
- No auth, no rate limiting.
- No update/delete endpoints.

## Tests

- Behavioral tests using `supertest` (or native fetch against `listen()`) covering:
  1. POST returns 201 + id
  2. POST with empty body returns 400
  3. GET /notes/:id returns stored note
  4. GET /notes/:id unknown returns 404
  5. GET /notes returns array
  6. Newest-first ordering
