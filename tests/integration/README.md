# Integration tests

Cross-package tests that exercise the API against real infrastructure (PostgreSQL, Redis, BullMQ)
started with `docker compose up -d postgres redis`. Unit tests stay next to the code they cover
(`*.spec.ts` in `apps/api`, `*.test.ts` in `packages/*`); this folder is for tests that span
modules or need live services.
