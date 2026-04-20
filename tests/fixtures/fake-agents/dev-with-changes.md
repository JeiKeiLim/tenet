Implemented the login endpoint per spec.

Files modified:
- src/routes/auth.ts: added POST /login handler with bcrypt password check
- src/middleware/session.ts: set session cookie on successful login
- tests/acceptance/login.test.ts: added 3 behavioral tests

Ran `pnpm test` — all 48 tests pass, including the 3 new ones.
Ran smoke check against local dev server: POST /login returns 302 to /dashboard with Set-Cookie; invalid credentials return 401.

Committed locally as `tenet(login): implement password login with session cookie`.
